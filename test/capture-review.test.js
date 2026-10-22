import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {stageCapture,instructCapture,takeCaptureCommand,reviewRow,captureTiming} from '../src/capture-review.js';import {ingest} from '../src/core.js';
const jpeg=new Uint8Array([255,216,1,2,255,217]).buffer;
function fixture(){const db=new DatabaseSync(':memory:');for(const m of ['0001_init','0006_capture_reviews'])db.exec(fs.readFileSync(new URL('../migrations/'+m+'.sql',import.meta.url),'utf8'));const objects=new Map();return {db,env:{DB:{prepare(sql){const statement=db.prepare(sql);const bound=args=>({first:async()=>statement.get(...args)||null,run:async()=>({meta:statement.run(...args)}),all:async()=>({results:statement.all(...args)})});return {...bound([]),bind:(...args)=>bound(args)};}},IMAGES:{put:async(k,v)=>objects.set(k,v),get:async k=>objects.has(k)?{arrayBuffer:async()=>objects.get(k)}:null}}};}
const identity={runId:'test',provider:'p',gameId:'g',shotId:'base',sessionId:'session-one'};
const command=(r,extra={})=>({id:r.id,sessionId:r.sessionId,revision:r.revision,imageSha256:r.imageSha256,action:'wait',waitMs:1000,reason:'Still loading',reviewer:'GPT',...extra});
test('same batch quality loop: pending images invisible to queue; one command; exact image approval required',async()=>{const f=fixture();try{
 const first=await stageCapture(f.env,identity,jpeg);assert.equal(f.db.prepare('SELECT count(*) n FROM items').get().n,0);
 await assert.rejects(instructCapture(f.env,command(first,{imageSha256:'bad'})));
 await instructCapture(f.env,command(first,{action:'click',x:.5,y:.8,initialWaitMs:45000}));
 assert.equal((await captureTiming(f.env,identity)).waitMs,45000);
 assert.equal((await captureTiming(f.env,{provider:'p',gameId:'other'})).waitMs,25000);
 await assert.rejects(instructCapture(f.env,command(first)));
 const take=await takeCaptureCommand(f.env,{id:first.id,sessionId:identity.sessionId});assert.equal(take.action.kind,'click');
 assert.equal((await takeCaptureCommand(f.env,{id:first.id,sessionId:identity.sessionId})).action,null);
 await assert.rejects(takeCaptureCommand(f.env,{id:first.id,sessionId:'another-session'}));
 const second=await stageCapture(f.env,{...identity,revision:first.revision,commandId:take.action.id},jpeg);assert.equal(second.id,first.id);assert.equal(second.revision,2);
 await assert.rejects(instructCapture(f.env,command(first,{action:'approve'})));
 const info={...identity,mode:'visual',state:'BASE',adapter:'gpt-quality',width:640,height:480,candidates:[],metadata:{source:'github-actions-catalogue',captureValidation:{reviewId:second.id,revision:second.revision,status:'ready'}}};
 await assert.rejects(ingest(f.env,info,jpeg));
 await instructCapture(f.env,command(second,{action:'approve'}));
 const item=await ingest(f.env,info,jpeg);assert.equal(item.status,'pending');
 assert.equal(f.db.prepare('SELECT count(*) n FROM decision_history').get().n,0);
 await assert.rejects(stageCapture(f.env,{...identity,sessionId:'next-session'},jpeg));
 assert.equal((await reviewRow(f.env,first.id)).status,'approved');
 }finally{f.db.close();}});
test('expired browser commands are never replayed on a new browser; fresh review required',async()=>{const f=fixture();try{
 const first=await stageCapture(f.env,identity,jpeg);await instructCapture(f.env,command(first,{action:'click',x:.4,y:.7}));
 await assert.rejects(stageCapture(f.env,{...identity,sessionId:'next-session'},jpeg));
 f.db.prepare('UPDATE capture_reviews SET expires_at=0').run();
 const fresh=await stageCapture(f.env,{...identity,sessionId:'next-session'},jpeg);assert.equal(fresh.status,'pending');assert.equal(fresh.action,null);assert.equal(fresh.history[0].action.kind,'click');
 await assert.rejects(instructCapture(f.env,command(first,{action:'approve'})));
 }finally{f.db.close();}});
