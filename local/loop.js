import fs from 'node:fs/promises';
import path from 'node:path';
import {RoundJournal,collectTasks,roundReady,compactRemoteTrace} from './rounds.js';
import {writeAtomic} from './utils.js';
// One checkpointed cycle. It never calls an assistant: classification remains human/MCP-reviewed.
export class LoopController{
 constructor({cloud,executor,runId,outDir='outbox',limit=20,maxDepth=7,allowNormalSpin=false,log=console.log}={}){
  if(!runId||!cloud||!executor)throw Error('runId, cloud and executor required');
  Object.assign(this,{cloud,executor,runId,outDir:path.resolve(outDir),limit,maxDepth,allowNormalSpin,log});
 }
 async uploadSaved(entry,journal){
  const {task,itemFile,imageFile,traceFile}=entry;
  const info=JSON.parse(await fs.readFile(itemFile,'utf8'));
  const image=await fs.readFile(imageFile);
  const trace=JSON.parse(await fs.readFile(traceFile,'utf8'));
  const uploaded=await this.cloud.uploadCapture(info,image);
  if(uploaded.item?.gameId!==task.gameId||uploaded.item?.shotId!==task.shotId)throw Error('remote capture identity mismatch');
  await this.cloud.uploadTrace({traceId:task.id,runId:task.runId,provider:task.provider,gameId:task.gameId,parentId:task.parentId,
   parentSourceSha256:task.parentSourceSha256,parentRevision:task.parentRevision,childId:uploaded.item.id,trace:compactRemoteTrace(trace)});
  await journal.set(task,'done');
 }
 async once(){
  await fs.mkdir(this.outDir,{recursive:true});
  const journal=await RoundJournal.open(path.join(this.outDir,'.round-journal.json'));
  // Upload completed captures that were left behind by network errors before querying the batch barrier.
  let blocked=0,completed=0;
  for(const entry of Object.values(journal.entries))if(entry.status==='captured'){
   try{await this.uploadSaved(entry,journal);completed++;}catch(e){this.log(`UPLOAD RETRY ${entry.task.id}: ${e.message}`);blocked++;}
  }
  if(blocked)return {completed,blocked,waiting:true,reason:'upload-failed',counts:journal.summary()};
  const counts=await this.cloud.stats(this.runId);
  if(!roundReady(counts))return {completed,blocked,waiting:true,reason:'await-classification',counts};
  const rows=await this.cloud.allDecisions(this.runId);
  const actionable=rows.filter(e=>e.decisions?.allMarks?.length);
  const items=[];
  // Fetch only records having actions; verify revision and source digest before any execution.
  for(let i=0;i<actionable.length;i+=8){
   const chunk=await Promise.all(actionable.slice(i,i+8).map(async d=>{
    const item=await this.cloud.item(d.id);
    if(item.status!=='classified'||item.revision!==d.revision||item.sourceSha256!==d.sourceSha256)throw Error(`stale decision for ${d.id}`);
    return item;
   }));items.push(...chunk);
  }
  const known=new Set(Object.keys(journal.entries));
  const tasks=collectTasks(items,known,{maxDepth:this.maxDepth,maxTasks:3000,allowNormalSpin:this.allowNormalSpin});
  for(const task of tasks.slice(0,this.limit)){
   if(!journal.shouldRun(task))continue;
   try{
    await journal.set(task,'running');
    const source=items.find(i=>i.id===task.parentId);
    const capture=await this.executor(task,source);
    const prefix=`${task.runId}__${task.provider}__${task.gameId}__${task.shotId}`;
    const itemFile=path.join(this.outDir,prefix+'.json'),imageFile=path.join(this.outDir,prefix+'.jpg'),traceFile=path.join(this.outDir,'diagnostics',prefix+'.har');
    await fs.mkdir(path.dirname(traceFile),{recursive:true});
    await fs.writeFile(imageFile+'.tmp',capture.image);await fs.rename(imageFile+'.tmp',imageFile);
    await writeAtomic(itemFile,capture.info);await writeAtomic(traceFile,capture.trace);
    await journal.set(task,'captured',{itemFile,imageFile,traceFile});
    await this.uploadSaved(journal.entries[task.id],journal);completed++;
    this.log(`BRANCH DONE ${task.gameId} ${task.shotId} depth=${task.depth}`);
   }catch(e){
    // 'running' means a browser action *may* already have happened. Never re-click automatically.
    if(journal.status(task.id)==='running')await journal.set(task,e.actionIssued?'uncertain':'blocked',{reason:String(e.message).slice(0,240)});
    blocked++;this.log(`BRANCH STOPPED ${task.gameId}/${task.shotId}: ${e.message}`);
   }
  }
  return {completed,blocked,waiting:false,scheduled:tasks.length,counts:journal.summary()};
 }
}
