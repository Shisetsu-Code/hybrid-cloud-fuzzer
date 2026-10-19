import {InputError,validateItem,normalizeDecisions} from './candidates.js';
const shaPattern=/^[a-f0-9]{64}$/i;
const jpegMime='image/jpeg';
const bytesMax=8*1024*1024;
const dbDate="datetime('now')";
export {InputError};
function fromJSON(s,fallback){try{return JSON.parse(s);}catch{return fallback;}}
export async function hashHex(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
export function publicItem(row){if(!row)return null;return {
  id:row.id,runId:row.run_id,provider:row.provider,gameId:row.game_id,shotId:row.shot_id,
  mode:row.mode,state:row.state,adapter:row.adapter,adapterVersion:row.adapter_version,
  candidates:fromJSON(row.candidates_json,[]),metadata:fromJSON(row.metadata_json,{}),
  sourceSha256:row.source_sha256,imageSha256:row.image_sha256||null,hasImage:Boolean(row.image_key),
  width:row.width,height:row.height,status:row.status,revision:row.revision,
  leaseId:row.lease_id,leaseUntil:row.lease_until,decisions:fromJSON(row.decisions_json,null),
  createdAt:row.created_at,updatedAt:row.updated_at};
}
export async function ingest(env,payload,image=null,{replace=false}={}){
  const item=validateItem(payload);
  if(image!==null&&!(image instanceof ArrayBuffer))throw new InputError('expected JPEG arraybuffer');
  let imageHash=null,imageKey=null;
  if(image!==null){
    if(image.byteLength<4||image.byteLength>bytesMax)throw new InputError('JPEG size out of range',413);
    const b=new Uint8Array(image);if(b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)throw new InputError('invalid JPEG',415);
    imageHash=await hashHex(image);imageKey=`images/${item.runId}/${item.provider}/${item.gameId}/${imageHash}.jpg`;
  }
  if(item.mode!=='structured'&&!imageHash)throw new InputError('hybrid/visual mode requires image');
  if(payload.imageSha256&&payload.imageSha256.toLowerCase()!==imageHash)throw new InputError('image hash mismatch');
  const data={runId:item.runId,provider:item.provider,gameId:item.gameId,shotId:item.shotId,mode:item.mode,state:item.state,
    adapter:item.adapter,adapterVersion:item.adapterVersion,candidates:item.candidates,metadata:item.metadata,width:item.width,height:item.height,imageHash};
  const sourceSha=await hashHex(new TextEncoder().encode(JSON.stringify(data)));
  const existing=await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(item.id).first();
  if(existing?.source_sha256===sourceSha)return {...publicItem(existing),unchanged:true};
  if(existing&&!replace)throw new InputError('new content under existing shotId; pass replace=true explicitly',409);
  if(imageKey)await env.IMAGES.put(imageKey,image,{httpMetadata:{contentType:jpegMime},customMetadata:{sha256:imageHash}});
  const values=[item.state,item.mode,item.adapter,item.adapterVersion,JSON.stringify(item.candidates),JSON.stringify(item.metadata),sourceSha,imageKey,imageHash,item.width,item.height];
  if(existing){
    const updated=await env.DB.prepare(`UPDATE items SET state=?,mode=?,adapter=?,adapter_version=?,candidates_json=?,metadata_json=?,source_sha256=?,image_key=?,image_sha256=?,width=?,height=?,
      status='pending',decisions_json=NULL,reviewer=NULL,reviewed_at=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=${dbDate}
      WHERE id=? AND source_sha256=? RETURNING *`).bind(...values,item.id,existing.source_sha256).first();
    if(!updated)throw new InputError('concurrent replacement; retry',409);
    return publicItem(updated);
  }
  try{
    await env.DB.prepare(`INSERT INTO items(id,run_id,provider,game_id,shot_id,state,mode,adapter,adapter_version,candidates_json,metadata_json,source_sha256,image_key,image_sha256,width,height)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.id,item.runId,item.provider,item.gameId,item.shotId,...values).run();
  }catch(e){
    const found=await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(item.id).first();
    if(found?.source_sha256===sourceSha)return {...publicItem(found),unchanged:true};
    throw new InputError('duplicate capture ID',409);
  }
  return publicItem(await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(item.id).first());
}
export async function rawItem(env,id){if(typeof id!=='string'||id.length>400)throw new InputError('invalid ID');const r=await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first();if(!r)throw new InputError('capture not found',404);return r;}
export async function claim(env,{runId=null,provider=null,leaseSeconds=180}={}){
  if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>900)throw new InputError('leaseSeconds must be 30..900');
  if(runId&&!/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(runId))throw new InputError('invalid runId');
  if(provider&&!/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(provider))throw new InputError('invalid provider');
  const filters=["(status='pending' OR (status='leased' AND lease_until<=?))"],bind=[Math.floor(Date.now()/1000)];
  if(runId){filters.push('run_id=?');bind.push(runId);}if(provider){filters.push('provider=?');bind.push(provider);}
  const where=filters.join(' AND ');
  for(let i=0;i<4;i++){
    const lease=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
    const updated=await env.DB.prepare(`UPDATE items SET status='leased',lease_id=?,lease_until=?,revision=revision+1,updated_at=${dbDate}
      WHERE id=(SELECT id FROM items WHERE ${where} ORDER BY created_at ASC,id ASC LIMIT 1)
      AND (status='pending' OR (status='leased' AND lease_until<=?)) RETURNING *`)
      .bind(lease,now+leaseSeconds,...bind,now).first();
    if(updated)return publicItem(updated);
  }
  return null;
}
export async function save(env,payload){
  if(!payload||typeof payload!=='object')throw new InputError('JSON object required');
  const {id,leaseId,revision,sourceSha256,status,reviewer}=payload;
  if(typeof id!=='string'||id.length>400||typeof leaseId!=='string'||leaseId.length>150||!Number.isSafeInteger(revision)||revision<1)throw new InputError('invalid lease identity');
  if(!shaPattern.test(sourceSha256||''))throw new InputError('invalid source hash');
  if(!['classified','needs_review'].includes(status))throw new InputError('invalid status');
  if(typeof reviewer!=='string'||!reviewer.trim()||reviewer.length>80)throw new InputError('reviewer required');
  const raw=await rawItem(env,id);
  const decisions=normalizeDecisions(payload,fromJSON(raw.candidates_json,[]));
  const now=Math.floor(Date.now()/1000);
  const result=await env.DB.prepare(`UPDATE items SET status=?,decisions_json=?,reviewer=?,reviewed_at=${dbDate},revision=revision+1,
    lease_id=NULL,lease_until=NULL,updated_at=${dbDate}
    WHERE id=? AND status='leased' AND lease_id=? AND lease_until>? AND revision=? AND source_sha256=? RETURNING *`)
    .bind(status,JSON.stringify(decisions),reviewer.trim(),id,leaseId,now,revision,sourceSha256.toLowerCase()).first();
  if(!result)throw new InputError('stale lease/revision/capture; claim again',409);
  try{await env.DB.prepare(`INSERT INTO decision_history(item_id,source_sha256,revision,reviewer,status,decisions_json) VALUES(?,?,?,?,?,?)`)
    .bind(id,result.source_sha256,result.revision,reviewer.trim(),status,JSON.stringify(decisions)).run();}
  catch(e){console.error('decision history write failed',e);}
  return publicItem(result);
}
export async function release(env,{id,leaseId,revision}={}){
  if(typeof id!=='string'||typeof leaseId!=='string'||!Number.isSafeInteger(revision))throw new InputError('invalid release');
  const row=await env.DB.prepare(`UPDATE items SET status='pending',lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=${dbDate}
    WHERE id=? AND status='leased' AND lease_id=? AND revision=? RETURNING *`).bind(id,leaseId,revision).first();
  if(!row)throw new InputError('stale lease',409);return publicItem(row);
}
export async function stats(env,{runId=null,provider=null}={}){
  const where=[],vals=[];if(runId){where.push('run_id=?');vals.push(runId);}if(provider){where.push('provider=?');vals.push(provider);}
  const rows=await env.DB.prepare(`SELECT status,COUNT(*) AS count FROM items ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY status`).bind(...vals).all();
  const counts={pending:0,leased:0,classified:0,needs_review:0};for(const row of rows.results||[])if(row.status in counts)counts[row.status]=row.count;
  return {counts,total:Object.values(counts).reduce((a,b)=>a+b,0)};
}
export async function decisionsFeed(env,{runId=null,after=0,limit=50}={}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new InputError('invalid feed paging');
  if(runId&&!/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(runId))throw new InputError('invalid runId');
  const where=runId?'AND i.run_id=?':'';
  const rows=await env.DB.prepare(`SELECT h.id AS seq,h.item_id AS item_id,h.revision AS revision,h.decisions_json AS decisions_json,
      i.run_id AS run_id,i.provider AS provider,i.game_id AS game_id,i.shot_id AS shot_id,i.source_sha256 AS source_sha256
    FROM decision_history h JOIN items i ON i.id=h.item_id
    WHERE h.id>? ${where} AND h.source_sha256=i.source_sha256 AND i.status='classified' ORDER BY h.id ASC LIMIT ?`)
    .bind(after,...(runId?[runId]:[]),limit).all();
  const items=(rows.results||[]).map(r=>({seq:r.seq,id:r.item_id,runId:r.run_id,provider:r.provider,gameId:r.game_id,shotId:r.shot_id,
    sourceSha256:r.source_sha256,revision:r.revision,decisions:fromJSON(r.decisions_json,{})}));
  return {items,nextAfter:items.length?items.at(-1).seq:after};
}
