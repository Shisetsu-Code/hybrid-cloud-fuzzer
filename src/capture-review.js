import {InputError,hashHex} from './core.js';
const ident=/^[a-z0-9][a-z0-9_.-]{0,99}$/i;
function checkIdentity(p){for(const k of ['runId','provider','gameId','shotId','sessionId'])if(!ident.test(p[k]||''))throw new InputError('invalid '+k);}
function now(){return Math.floor(Date.now()/1000);}
export function reviewPublic(r){return r?{id:r.id,runId:r.run_id,provider:r.provider,gameId:r.game_id,shotId:r.shot_id,sessionId:r.session_id,revision:r.revision,imageSha256:r.image_sha256,status:r.status,action:JSON.parse(r.action_json||'null'),history:JSON.parse(r.history_json),expiresAt:r.expires_at}:null;}
export async function reviewRow(env,id){if(typeof id!=='string'||id.length>405)throw new InputError('invalid review ID');const r=await env.DB.prepare('SELECT * FROM capture_reviews WHERE id=?').bind(id).first();if(!r)throw new InputError('capture review not found',404);return r;}
export async function captureTiming(env,{provider,gameId}){if(!ident.test(provider||'')||!ident.test(gameId||''))throw new InputError('invalid game');const row=await env.DB.prepare('SELECT wait_ms FROM capture_timings WHERE provider=? AND game_id=?').bind(provider,gameId).first();return {waitMs:row?.wait_ms??25000};}
export async function stageCapture(env,p,image){
 checkIdentity(p);const b=new Uint8Array(image);if(b.length<4||b.length>8*1024*1024||b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)throw new InputError('invalid bounded JPEG');
 const id=[p.runId,p.provider,p.gameId,p.shotId].join(':'),hash=await hashHex(image);
 const old=await env.DB.prepare('SELECT * FROM capture_reviews WHERE id=?').bind(id).first();
 if(old?.status==='approved')return reviewPublic(old); // Resume upload, preserving the approved JPEG.
 if(old&&old.session_id!==p.sessionId&&old.expires_at>now())throw new InputError('another live capture session',409);
 if(old&&old.session_id===p.sessionId){
  if(old.image_sha256===hash&&old.revision===p.revision&&old.status==='pending')return reviewPublic(old);
  const action=JSON.parse(old.action_json||'null');
  if(old.status!=='executing'||old.revision!==p.revision||action?.id!==p.commandId)throw new InputError('stale capture command',409);
 }
 const revision=(old?.revision||0)+1,key=`capture-review/${p.runId}/${p.provider}/${p.gameId}/${hash}.jpg`;
 await env.DB.prepare('INSERT OR IGNORE INTO capture_timings(provider,game_id,wait_ms) VALUES(?,?,25000)').bind(p.provider,p.gameId).run();
 await env.IMAGES.put(key,image,{httpMetadata:{contentType:'image/jpeg'}});
 const history=JSON.parse(old?.history_json||'[]');if(old)history.push({revision:old.revision,imageSha256:old.image_sha256,action:JSON.parse(old.action_json||'null'),sessionId:old.session_id});
 if(history.length>40)throw new InputError('capture review step limit reached',409);
 const row=old?await env.DB.prepare("UPDATE capture_reviews SET session_id=?,revision=?,image_sha256=?,image_key=?,status='pending',action_json=NULL,history_json=?,expires_at=?,updated_at=datetime('now') WHERE id=? AND revision=? AND session_id=? RETURNING *").bind(p.sessionId,revision,hash,key,JSON.stringify(history),now()+120,id,old.revision,old.session_id).first():await env.DB.prepare("INSERT INTO capture_reviews(id,run_id,provider,game_id,shot_id,session_id,revision,image_sha256,image_key,status,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?) RETURNING *").bind(id,p.runId,p.provider,p.gameId,p.shotId,p.sessionId,revision,hash,key,now()+120).first();
 if(!row)throw new InputError('concurrent capture update',409);return reviewPublic(row);
}
export async function listCaptureReviews(env,{runId,afterId='',limit=20}={}){
 if(!ident.test(runId||'')||typeof afterId!=='string'||afterId.length>405||!Number.isInteger(limit)||limit<1||limit>50)throw new InputError('invalid review page');
 const rows=await env.DB.prepare("SELECT * FROM capture_reviews WHERE run_id=? AND id>? AND status!='approved' ORDER BY id LIMIT ?").bind(runId,afterId,limit+1).all();const result=rows.results||[];return {items:result.slice(0,limit).map(reviewPublic),nextAfterId:result.length>limit?result[limit-1].id:null};
}
export async function instructCapture(env,p){
 const row=await reviewRow(env,p.id);
 if(p.action!=='approve'&&row.expires_at<=now())throw new InputError('browser offline; wait for a fresh screenshot',409);
 if(!['wait','click','approve'].includes(p.action)||typeof p.reason!=='string'||!p.reason.trim()||p.reason.length>500||typeof p.reviewer!=='string'||!p.reviewer.trim()||p.reviewer.length>80)throw new InputError('action, reason and reviewer required');
 if(p.action==='click'&&(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1))throw new InputError('normalized click coordinates required');
 const waitMs=p.waitMs??2500;if(!Number.isInteger(waitMs)||waitMs<0||waitMs>120000)throw new InputError('waitMs must be 0..120000');
 if(p.initialWaitMs!==undefined&&(!Number.isInteger(p.initialWaitMs)||p.initialWaitMs<1000||p.initialWaitMs>120000))throw new InputError('initialWaitMs must be 1000..120000');
 const action={id:crypto.randomUUID(),kind:p.action,waitMs,reason:p.reason,reviewer:p.reviewer,...(p.action==='click'?{x:p.x,y:p.y}:{})};
 const updated=await env.DB.prepare("UPDATE capture_reviews SET status=?,action_json=?,updated_at=datetime('now') WHERE id=? AND revision=? AND image_sha256=? AND session_id=? AND status='pending' RETURNING *").bind(p.action==='approve'?'approved':'command',JSON.stringify(action),p.id,p.revision,p.imageSha256,p.sessionId).first();
 if(!updated)throw new InputError('stale review/image/session or already instructed',409);
 if(p.initialWaitMs!==undefined)await env.DB.prepare("INSERT INTO capture_timings(provider,game_id,wait_ms) VALUES(?,?,?) ON CONFLICT(provider,game_id) DO UPDATE SET wait_ms=excluded.wait_ms,updated_at=datetime('now')").bind(row.provider,row.game_id,p.initialWaitMs).run();
 return reviewPublic(updated);
}
// Destructive delivery: a lost response never permits a second click. A new
// browser session must post a fresh screenshot, never replay an old command.
export async function takeCaptureCommand(env,p){
 const row=await reviewRow(env,p.id);if(row.session_id!==p.sessionId)throw new InputError('capture session changed',409);
 const updated=await env.DB.prepare("UPDATE capture_reviews SET status=?,expires_at=? WHERE id=? AND session_id=? AND revision=? AND status=? RETURNING *").bind(row.status==='command'?'executing':row.status,now()+120,p.id,p.sessionId,row.revision,row.status).first();
 if(!updated)throw new InputError('capture session changed',409);
 return {...reviewPublic(updated),action:row.status==='command'||row.status==='approved'?JSON.parse(row.action_json||'null'):null};
}
