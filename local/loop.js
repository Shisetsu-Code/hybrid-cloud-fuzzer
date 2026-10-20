import fs from 'node:fs/promises';
import path from 'node:path';
import {RoundJournal,collectTasks,compactRemoteTrace} from './rounds.js';
import {writeAtomic} from './utils.js';
import {updateDrainRequested} from './update-drain.js';

// Each (runId, provider, gameId) is its own classification/execution barrier.
// A stalled game cannot prevent ready games from exploring reviewed DEMO paths.
// A single interrupted/uncertain action is never repeated automatically.
const gameKey=item=>item.provider+'/'+item.gameId;

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
  let blocked=0,completed=0;
  const localBlocked=new Set();

  // Retried uploads are idempotent; *never* re-execute the associated click.
  // An error belongs to this game only. Keep servicing unrelated games.
  for(const entry of Object.values(journal.entries)){
   if(!entry.task)continue;
   const key=gameKey(entry.task);
   if(entry.status==='captured'){
    localBlocked.add(key); // child needs to be reviewed before this game advances
    try{
     await this.uploadSaved(entry,journal);
     completed++;
    }catch(e){
     blocked++;
     this.log('UPLOAD RETRY '+entry.task.id+': '+e.message);
    }
   }else if(['uncertain','blocked','failed'].includes(entry.status)){
    // Operator investigation is required for this game; other games are not stalled.
    localBlocked.add(key);
   }
  }

  // Required: a fresh server-side per-game snapshot of all unresolved captures.
  // Do not fall back to assuming "ready" when this query or paging fails.
  const counts=await this.cloud.stats(this.runId);
  const remoteBlocked=await this.cloud.blockedGames(this.runId);
  if(!(remoteBlocked instanceof Set))throw Error('invalid per-game readiness response');
  const blockedKeys=new Set([...remoteBlocked,...localBlocked]);

  // Fetch classified decisions for *ready* games. A replaced or stale item in
  // one game is quarantined without making other games lose their progress.
  const rows=await this.cloud.allDecisions(this.runId);
  const actionable=rows.filter(d=>d.decisions?.allMarks?.length&&!blockedKeys.has(gameKey(d)));
  const items=[];
  for(let i=0;i<actionable.length;i+=8){
   const slice=actionable.slice(i,i+8);
   const chunk=await Promise.allSettled(slice.map(d=>this.cloud.item(d.id)));
   for(let j=0;j<chunk.length;j++){
    const d=slice[j],result=chunk[j],key=gameKey(d);
    if(result.status!=='fulfilled'){
     blockedKeys.add(key);
     blocked++;
     this.log('GAME WAIT '+key+': source unavailable ('+String(result.reason?.message||result.reason)+')');
     continue;
    }
    const item=result.value;
    if(!item||item.status!=='classified'||item.revision!==d.revision||item.sourceSha256!==d.sourceSha256){
     blockedKeys.add(key);
     blocked++;
     this.log('GAME WAIT '+key+': classification changed since feed');
     continue;
    }
    items.push(item);
   }
  }

  // Only one branch per game per polling round, so after publishing a child
  // its own classification is the next prerequisite. Other games run normally.
  const known=new Set(Object.keys(journal.entries));
  const tasks=collectTasks(items.filter(x=>!blockedKeys.has(gameKey(x))),known,{
   maxDepth:this.maxDepth,maxTasks:3000,allowNormalSpin:this.allowNormalSpin
  });
  const selected=[],selectedGames=new Set();
  for(const task of tasks){
   const key=gameKey(task);
   if(blockedKeys.has(key)||selectedGames.has(key))continue;
   selected.push(task);selectedGames.add(key);
   if(selected.length>=this.limit)break;
  }
  const sources=new Map(items.map(i=>[i.id,i]));
  for(const task of selected){
   if(await updateDrainRequested())break;
   const key=gameKey(task);
   try{
    await journal.set(task,'running');
    const source=sources.get(task.parentId);
    const capture=await this.executor(task,source);
    const prefix=task.runId+'__'+task.provider+'__'+task.gameId+'__'+task.shotId;
    const itemFile=path.join(this.outDir,prefix+'.json'),imageFile=path.join(this.outDir,prefix+'.jpg'),traceFile=path.join(this.outDir,'diagnostics',prefix+'.har');
    await fs.mkdir(path.dirname(traceFile),{recursive:true});
    await fs.writeFile(imageFile+'.tmp',capture.image);await fs.rename(imageFile+'.tmp',imageFile);
    await writeAtomic(itemFile,capture.info);await writeAtomic(traceFile,capture.trace);
    await journal.set(task,'captured',{itemFile,imageFile,traceFile});
    await this.uploadSaved(journal.entries[task.id],journal);
    completed++;
    this.log('BRANCH DONE '+task.gameId+' '+task.shotId+' depth='+task.depth);
   }catch(e){
    // No automatic retry once there is any possibility a click occurred.
    if(journal.status(task.id)==='running'){
     await journal.set(task,e.actionIssued?'uncertain':'blocked',{reason:String(e.message).slice(0,240)});
    }
    blocked++;
    blockedKeys.add(key);
    this.log('GAME STOPPED '+task.gameId+'/'+task.shotId+': '+e.message);
   }
  }
  return {
   completed,blocked,blockedGames:blockedKeys.size,
   waiting:selected.length===0,
   reason:selected.length?'executed':blockedKeys.size?'await-game-classification-or-review':'idle',
   scheduled:tasks.length,scheduledGames:selected.length,
   counts:journal.summary(),cloudCounts:counts
  };
 }
}
