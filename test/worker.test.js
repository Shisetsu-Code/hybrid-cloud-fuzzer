import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/worker.js';
import {inferMode,normalizeCandidates,validateItem,normalizeDecisions} from '../src/candidates.js';
const migration=fs.readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');
function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(migration);
  const DB={prepare(sql){const stmt=sqlite.prepare(sql);const bound=args=>({first:async()=>stmt.get(...args)||null,run:async()=>({meta:stmt.run(...args)}),all:async()=>({results:stmt.all(...args)})});return {...bound([]),bind:(...args)=>bound(args)}}};
  const images=new Map(),IMAGES={put:async(key,data)=>{images.set(key,data.slice(0));},get:async key=>images.has(key)?{
    arrayBuffer:async()=>images.get(key).slice(0),body:new Blob([images.get(key)]).stream()}:null};
  return {env:{DB,IMAGES,INGEST_TOKEN:'ingest-test',REVIEW_TOKEN:'review-test',MCP_TOKEN:'mcp-test'},images,close:()=>sqlite.close()};
}
const JPEG=new Uint8Array([255,216,1,2,3,4,255,217]);
const candidate={id:'c0',label:'BUY FEATURE',source:'runtime',role:'button',confidence:0.93,rect:{x:0.2,y:0.3,w:0.2,h:0.2},path:'GameRoot/BuyFeature/Collider'};
const item=(other={})=>({runId:'test-run',provider:'pragmatic',gameId:'demo-a',shotId:'base',state:'BASE',mode:'structured',adapter:'pragmatic-runtime',candidates:[candidate],metadata:{demo:true},...other});
async function request(env,path,payload,token='review-test'){
  const r=new Request('https://worker.example'+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  return worker.fetch(r,env);
}
async function upload(env,payload=imageItem(),img=JPEG){
  if(!img)return request(env,'/v1/items',payload,'ingest-test');
  const body=new FormData();body.set('metadata',JSON.stringify(payload));body.set('image',new Blob([img],{type:'image/jpeg'}),'demo.jpg');if(payload.replace)body.set('replace','true');
  return worker.fetch(new Request('https://worker.example/v1/items',{method:'POST',headers:{Authorization:'Bearer ingest-test'},body}),env);
}
const imageItem=(other={})=>item({mode:'visual',candidates:[],adapter:'opaque-canvas',...other});
async function get(env,path,token='review-test'){return worker.fetch(new Request('https://worker.example'+path,{headers:{Authorization:`Bearer ${token}`}}),env);}
async function rpc(env,name,arg){const response=await worker.fetch(new Request('https://worker.example/mcp',{method:'POST',headers:{Authorization:'Bearer mcp-test','Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arg}})}),env);return response.json();}

test('candidate normalization, quality and correct decision coordinate mapping',()=>{
  const normalized=normalizeCandidates([candidate]);assert.equal(normalized.length,1);
  assert.equal(inferMode({state:'BASE',candidates:normalized,opaqueCanvas:true}),'structured');
  assert.equal(inferMode({state:'INTRO',candidates:normalized}),'visual');
  assert.equal(inferMode({state:'BASE',candidates:[]}),'visual');
  assert.throws(()=>normalizeCandidates([{...candidate,rect:{x:0.99,y:0,w:0.2,h:0.1}}]),/outside/);
  assert.throws(()=>normalizeCandidates([candidate,candidate]),/duplicate/);
  assert.throws(()=>validateItem(item({mode:'structured',candidates:[]})),/needs candidates/);
  assert.deepEqual(normalizeDecisions({selections:[{candidateId:'c0',kind:'buy'}],marks:[{x:0.8,y:0.9,kind:'pick',label:'second'}]},normalized).allMarks,
    [{x:0.3,y:0.4,kind:'buy',label:'BUY FEATURE'},{x:0.8,y:0.9,kind:'pick',label:'second'}]);
  assert.throws(()=>normalizeDecisions({selections:[{candidateId:'c50',kind:'buy'}]},normalized),/no longer exists/);
});

test('structured-only ingestion: no image, auth, idempotence, lease, save and consume D1 decisions',async()=>{
  const f=fixture();try{
    assert.equal((await get(f.env,'/v1/stats','ingest-test')).status,401);
    const created=await upload(f.env,item(),null);assert.equal(created.status,201);
    const first=(await created.json()).item;assert.equal(first.mode,'structured');assert.equal(first.hasImage,false);assert.equal(f.images.size,0);
    const duplicate=(await (await upload(f.env,item(),null)).json()).item;assert.equal(duplicate.unchanged,true);
    const claim=(await (await request(f.env,'/v1/claim',{})).json()).item;
    assert.equal(claim.status,'leased');assert.equal(claim.revision,1);
    assert.equal((await request(f.env,'/v1/save',{id:claim.id,leaseId:claim.leaseId,revision:claim.revision,sourceSha256:'0'.repeat(64),reviewer:'gpt',status:'classified',selections:[{candidateId:'c0',kind:'buy'}]})).status,409);
    const data={id:claim.id,leaseId:claim.leaseId,revision:claim.revision,sourceSha256:claim.sourceSha256,reviewer:'gpt',status:'classified',selections:[{candidateId:'c0',kind:'buy'}]};
    const saved=await request(f.env,'/v1/save',data);assert.equal(saved.status,200);
    const res=(await saved.json()).item;assert.equal(res.decisions.allMarks[0].x,0.3);
    assert.equal((await request(f.env,'/v1/save',data)).status,409);
    const feed=(await (await get(f.env,'/v1/decisions?after=0&runId=test-run')).json());
    assert.equal(feed.items.length,1);assert.equal(feed.items[0].decisions.allMarks[0].kind,'buy');
    assert.equal((await (await request(f.env,'/v1/claim',{})).json()).item,null);
  }finally{f.close()}
});

test('visual unknown provider stores private JPEG, MCP returns image only for visual mode',async()=>{
  const f=fixture();try{
    const res=await upload(f.env,imageItem({provider:'rubyplay',gameId:'canvas-demo'}));assert.equal(res.status,201);
    const created=(await res.json()).item;assert.equal(created.hasImage,true);assert.equal(f.images.size,1);
    const next=await rpc(f.env,'next_item',{runId:'test-run'});
    const [msg,picture]=next.result.content;const claimed=JSON.parse(msg.text).item;
    assert.equal(claimed.provider,'rubyplay');assert.equal(picture.mimeType,'image/jpeg');assert.deepEqual(new Uint8Array(Buffer.from(picture.data,'base64')),JPEG);
    const wrong=await rpc(f.env,'save_classification',{id:claimed.id,leaseId:'WRONG',revision:claimed.revision,sourceSha256:claimed.sourceSha256,reviewer:'gpt',status:'classified',marks:[]});
    assert.equal(wrong.result.isError,true);
    const ok=await rpc(f.env,'save_classification',{id:claimed.id,leaseId:claimed.leaseId,revision:claimed.revision,sourceSha256:claimed.sourceSha256,reviewer:'gpt',status:'classified',marks:[{x:0.1,y:0.2,kind:'navigate',label:'Open'}]});
    assert.equal(JSON.parse(ok.result.content[0].text).saved,true);
    const im=await get(f.env,`/v1/items/${encodeURIComponent(created.id)}/image`);assert.equal(im.status,200);assert.deepEqual(new Uint8Array(await im.arrayBuffer()),JPEG);
  }finally{f.close()}
});

test('replace on changed screenshot rejects stale classifier and excludes obsolete decision from feed',async()=>{
  const f=fixture();try{
    const a=(await (await upload(f.env,imageItem())).json()).item;
    const leased=(await (await request(f.env,'/v1/claim',{})).json()).item;
    const edited=new Uint8Array(JPEG);edited[4]=60;
    assert.equal((await upload(f.env,imageItem(),edited)).status,409);
    const payload=imageItem({replace:true});
    const replaced=(await (await upload(f.env,payload,edited)).json()).item;
    assert.notEqual(a.sourceSha256,replaced.sourceSha256);
    const res=await request(f.env,'/v1/save',{id:leased.id,leaseId:leased.leaseId,revision:leased.revision,sourceSha256:leased.sourceSha256,reviewer:'gpt',status:'classified',marks:[]});
    assert.equal(res.status,409);
    assert.equal(replaced.status,'pending');
  }finally{f.close()}
});

test('batch of structured providers, independent claims, zero marks and MCP authentication',async()=>{
  const f=fixture();try{
    const payload={items:[item({provider:'playtech',gameId:'a'}),item({provider:'3oaks',gameId:'b'})]};
    assert.equal((await request(f.env,'/v1/items/batch',payload,'ingest-test')).status,201);
    assert.equal((await get(f.env,'/v1/stats')).status,200);
    const claimed=(await (await request(f.env,'/v1/claim',{provider:'3oaks'})).json()).item;
    assert.equal(claimed.provider,'3oaks');
    const save=await request(f.env,'/v1/save',{id:claimed.id,leaseId:claimed.leaseId,revision:claimed.revision,sourceSha256:claimed.sourceSha256,reviewer:'gpt',status:'classified',marks:[],selections:[]});
    assert.equal(save.status,200);
    const other=(await (await request(f.env,'/v1/claim',{provider:'playtech'})).json()).item;
    assert.equal(other.provider,'playtech');
    const released=await request(f.env,'/v1/release',{id:other.id,leaseId:other.leaseId,revision:other.revision});assert.equal(released.status,200);
    assert.equal((await get(f.env,'/mcp','review-test')).status,401);
    const stats=(await (await get(f.env,'/v1/stats')).json()).counts;assert.deepEqual(stats,{pending:1,leased:0,classified:1,needs_review:0});
  }finally{f.close()}
});

test('prior classification is not emitted once a changed capture is explicitly replaced',async()=>{
  const f=fixture();try{
    await upload(f.env,imageItem());
    const c=(await (await request(f.env,'/v1/claim',{})).json()).item;
    const saved=await request(f.env,'/v1/save',{id:c.id,leaseId:c.leaseId,revision:c.revision,sourceSha256:c.sourceSha256,status:'classified',reviewer:'gpt',marks:[{x:0.3,y:0.4,kind:'buy',label:'old'}]});
    assert.equal(saved.status,200);
    const before=(await (await get(f.env,'/v1/decisions')).json()).items;assert.equal(before.length,1);
    const changed=new Uint8Array(JPEG);changed[2]=99;
    const replaced=(await upload(f.env,imageItem({replace:true}),changed));assert.equal(replaced.status,201);
    const after=(await (await get(f.env,'/v1/decisions')).json()).items;assert.equal(after.length,0);
  }finally{f.close()}
});

test('MCP structured task has no image payload, tools list is present and auth rejects wrong token',async()=>{
  const f=fixture();try{
    await upload(f.env,item(),null);
    const next=await rpc(f.env,'next_item',{});assert.equal(next.result.content.length,1);
    const itemInfo=JSON.parse(next.result.content[0].text).item;assert.equal(itemInfo.candidates[0].label,'BUY FEATURE');
    const bad=await worker.fetch(new Request('https://worker.example/mcp',{method:'POST',headers:{Authorization:'Bearer review-test','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}),f.env);
    assert.equal(bad.status,401);
    const list=await worker.fetch(new Request('https://worker.example/mcp',{method:'POST',headers:{Authorization:'Bearer mcp-test','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}),f.env);
    assert.equal((await list.json()).result.tools.length,5);
  }finally{f.close()}
});
