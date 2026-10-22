import {InputError,hashHex} from './core.js';
const safe=/^[a-z0-9][a-z0-9_.-]{0,99}$/i,sha=/^[a-f0-9]{64}$/;
const states=new Set(['ready','intro','loading','blocked','overlay','uncertain']);
const roles=new Set(['balance','bet','spin','menu','buy','start']);
function id(value){if(typeof value!=='string'||!safe.test(value))throw new InputError('invalid validation identity');return value;}
function anchors(value){
 if(!Array.isArray(value)||value.length>12)throw new InputError('invalid validation anchors');
 return value.map(a=>{
  if(!roles.has(a.role)||!Array.isArray(a.rect)||a.rect.length!==4||a.rect.some(n=>!Number.isFinite(n)||n<0||n>1)||a.rect[2]<=0||a.rect[3]<=0||a.rect[0]+a.rect[2]>1.001||a.rect[1]+a.rect[3]>1.001)throw new InputError('invalid instrument rectangle');
  return {role:a.role,rect:a.rect,matched:a.matched===true,...(Number.isFinite(a.distance)?{distance:a.distance}:{})};
 });
}
export async function storeValidation(env,payload,jpeg){
 const report={runId:id(payload.runId),provider:id(payload.provider),gameId:id(payload.gameId),validatorVersion:id(payload.validatorVersion)};
 if(!states.has(payload.status)||!Array.isArray(payload.reasons)||payload.reasons.length>12||payload.reasons.some(r=>typeof r!=='string'||!/^[a-z0-9_-]{1,80}$/.test(r)))throw new InputError('invalid validation result');
 const bytes=new Uint8Array(jpeg);
 if(bytes.length<4||bytes.length>8*1024*1024||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw new InputError('valid JPEG comparison required');
 Object.assign(report,{status:payload.status,reasons:payload.reasons,anchors:anchors(payload.anchors||[]),createdAt:new Date().toISOString()});
 if(payload.referenceId){
  const row=await env.DB.prepare('SELECT * FROM items WHERE id=? AND provider=? AND game_id=? AND status=?').bind(payload.referenceId,report.provider,report.gameId,'classified').first();
  if(!row||row.image_sha256!==payload.referenceSha256)throw new InputError('reference must be approved and belong to this game',409);
  report.referenceId=row.id;report.referenceSha256=row.image_sha256;
 }
 report.imageSha256=await hashHex(bytes);
 report.id=await hashHex(new TextEncoder().encode(JSON.stringify(report)));
 await env.IMAGES.put('validation/previews/'+report.id+'.jpg',bytes,{httpMetadata:{contentType:'image/jpeg'}});
 await env.IMAGES.put('validation/reports/'+report.runId+'/'+report.id+'.json',JSON.stringify(report),{httpMetadata:{contentType:'application/json'}});
 return report;
}
export async function listValidations(env,{runId,cursor='',limit=30}={}){
 id(runId);limit=Number(limit);if(!Number.isInteger(limit)||limit<1||limit>50||typeof cursor!=='string'||cursor.length>2000)throw new InputError('invalid validation pagination');
 const page=await env.IMAGES.list({prefix:'validation/reports/'+runId+'/',limit,...(cursor?{cursor}:{})});
 const items=await Promise.all(page.objects.map(async o=>JSON.parse(await (await env.IMAGES.get(o.key)).text())));
 return {items,nextCursor:page.truncated?page.cursor:null};
}
export async function validationPreview(env,value){
 if(typeof value!=='string'||!sha.test(value))throw new InputError('invalid validation ID');
 const obj=await env.IMAGES.get('validation/previews/'+value+'.jpg');if(!obj)throw new InputError('validation preview not found',404);return obj;
}
export async function validationReference(env,{provider,gameId}={}){
 id(provider);id(gameId);
 const rows=await env.DB.prepare("SELECT * FROM items WHERE provider=? AND game_id=? AND status='classified' AND image_key IS NOT NULL ORDER BY reviewed_at DESC LIMIT 20").bind(provider,gameId).all();
 for(const row of rows.results){
  let metadata;try{metadata=JSON.parse(row.metadata_json);}catch{continue;}
  const v=metadata.captureValidation;
  if(v?.status!=='ready'||!Array.isArray(v.anchors)||new Set(v.anchors.map(a=>a.role)).size<2)continue;
  return {reference:{id:row.id,provider:row.provider,gameId:row.game_id,imageSha256:row.image_sha256,anchors:anchors(v.anchors),revision:row.revision}};
 }
 return {reference:null};
}
