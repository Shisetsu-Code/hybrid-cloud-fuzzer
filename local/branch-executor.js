// Local Playwright-only public DEMO branch executor. Never runs on Cloudflare.
import {bestFrame,screenshotBox} from './select-frame.js';
import {openPublicDemo,dismissKnownIntro,dismissCatalogueOverlays,captureWithoutCatalogueOverlays,isCatalogueOverlayAction} from './intro.js';
import {speedUpGame} from './speed.js';
import {createNetworkRecorder,summarizeHar} from './har.js';
import {chooseAction,resolveDemoUrl,classifyTrace,traceEndpoints} from './rounds.js';

export function screenPoint(point,{clip,aligned},viewport){
 if(!aligned)throw Error('frame alignment uncertain; refusing click');
 if(!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<0||point.x>1||point.y<0||point.y>1)throw Error('click coordinates outside normalized viewport');
 const box=clip||{x:0,y:0,width:viewport?.width??0,height:viewport?.height??0};
 if(!(box.width>0&&box.height>0))throw Error('invalid game viewport');
 return {x:Math.round((box.x+point.x*box.width)*1000)/1000,y:Math.round((box.y+point.y*box.height)*1000)/1000};
}
export function actionEvidence(har){return {status:classifyTrace(har),endpoints:traceEndpoints(har),actions:summarizeHar(har).actions,validated:false};}
export async function executeDemoBranch(task,source,{
 chromium,browser=null,manifest=[],waitMs=750,speed=1,headless=true,confirmAdult=false,log=console.log,
 openDemo=openPublicDemo,inspect=bestFrame,frameBox=screenshotBox,recorderFactory=createNetworkRecorder
}={}){
 if(!browser&&!chromium?.launch)throw Error('Playwright Chromium required');
 if(task.path.some(isCatalogueOverlayAction))throw Error('Catalogue consent is not a reviewed game branch');
 const url=resolveDemoUrl(source,{catalog:manifest});
 const ownsBrowser=!browser;
 const activeBrowser=browser||await chromium.launch({headless});let context,recorder,actionIssued=false;
 try{
  context=await activeBrowser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultNavigationTimeout(45000);
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await openDemo(page,{provider:task.provider,url,confirmAdult});
  await page.waitForTimeout(Math.min(waitMs*2,6000));
  // The public catalogue CMP often appears only after the game iframe loads.
  // Do not click the game while its site-level consent/age dialog is visible.
  await dismissCatalogueOverlays(page,{provider:task.provider,url,confirmAdult,graceMs:450,requireClear:true});
  let observed=null;
  for(let i=0;i<task.path.length;i++){
   const step=task.path[i];
   if(!['buy','navigate','pick','other'].includes(step.kind))throw Error('unreviewed action type');
   let candidate=null,position=null,shot=null;
   for(let attempt=0;attempt<4;attempt++){
    await dismissCatalogueOverlays(page,{provider:task.provider,url,confirmAdult,requireClear:true});
    candidate=await inspect(page,task.provider);
    if(!candidate)throw Error('no game frame');
    if(candidate.data.state==='INTRO'&&step.state!=='INTRO'&&task.provider==='pragmatic'){
     const intro=await dismissKnownIntro(page,candidate,{inspect:()=>inspect(page,task.provider)});
     if(intro.dismissed)candidate=intro.selected;
    }
    shot=await frameBox(page,candidate.frame);
    position=chooseAction(step,i===task.path.length-1?source:null,candidate.data.candidates||[],{aligned:shot.aligned,state:candidate.data.state});
    if(position)break;
    await page.waitForTimeout(550);
   }
   if(!position)throw Error(`reviewed control no longer matches game UI: ${step.state}/${step.label}`);
   if(speed>1)await speedUpGame(page,candidate.frame,speed);
   // A delayed CMP can appear between extraction and the reviewed click.
   await dismissCatalogueOverlays(page,{provider:task.provider,url,confirmAdult,requireClear:true});
   const absolute=screenPoint(position,shot,page.viewportSize());
   // Network observation is scoped to the clicked action, not loading/earlier branches.
   const last=i===task.path.length-1;
   if(last)recorder=recorderFactory(context,{maxEntries:500,maxFrames:200});
   // The pending journal is already durable BEFORE this click. Never silently retry it.
   actionIssued=true;await page.mouse.click(absolute.x,absolute.y,{delay:30});
   await page.waitForTimeout(Math.min(Math.max(waitMs,450),4000));
   if(last)observed=await recorder.finish();recorder=null;
   log(`CLICK ${task.gameId} ${i+1}/${task.path.length}: ${step.kind} ${step.label}`);
  }
  // Clear late catalogue dialogs before inspecting/cropping the evidence JPEG.
  const {result,box,image}=await captureWithoutCatalogueOverlays(page,{provider:task.provider,url,confirmAdult},async()=>{
   const result=await inspect(page,task.provider);
   if(!result)throw Error('game frame disappeared after reviewed action');
   const box=await frameBox(page,result.frame);
   const image=Buffer.from(await page.screenshot({type:'jpeg',quality:65,...(box.clip?{clip:box.clip}:{})}));
   return {result,box,image};
  });
  const width=Math.round(box.clip?.width||page.viewportSize().width),height=Math.round(box.clip?.height||page.viewportSize().height);
  const evidence=actionEvidence(observed?.har||{log:{entries:[],_webSockets:[]}});
  const isAligned=box.aligned;
  const info={runId:task.runId,provider:task.provider,gameId:task.gameId,shotId:task.shotId,
   state:result.data.state,mode:isAligned?result.data.mode:'visual',adapter:isAligned?result.data.adapter:'unaligned-frame',
   adapterVersion:result.data.adapterVersion||'1',candidates:isAligned?result.data.candidates:[],width,height,
   metadata:{url,parentId:task.parentId,parentSourceSha256:task.parentSourceSha256,parentRevision:task.parentRevision,
    actionPath:task.path,source:'reviewed-branch-executor',frameAligned:isAligned,terminal:evidence.status==='bet_request_observed',
    evidenceStatus:evidence.status,networkDiagnostics:{format:'sanitized-har-1.2',summary:observed?.summary||{requests:0,actions:[],endpoints:[]}},
    capturedAt:new Date().toISOString()}};
  if(info.mode==='structured'&&!info.candidates.length)info.mode='visual';
  return {info,image,trace:observed?.har||{log:{version:'1.2',entries:[],_webSockets:[],_notice:'Sanitized DEMO diagnostics.'}}};
 }catch(e){e.actionIssued=actionIssued;throw e;}finally{
  if(recorder)await recorder.finish().catch(()=>{});
  await context?.close().catch(()=>{});if(ownsBrowser)await activeBrowser.close().catch(()=>{});
 }
}
