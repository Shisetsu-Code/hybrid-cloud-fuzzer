import test from 'node:test';
import assert from 'node:assert/strict';
import {executeDemoBranch} from '../local/branch-executor.js';

// A local, deterministic demo fixture exercises Chromium, iframe-independent hitboxes,
// action-correlated POST capture, child screenshot, and terminal wager detection.
test('Playwright public demo fixture: classified control -> HTTP request + next screen',
 {skip:process.env.INTEGRATION_BROWSER!=='1'},async()=>{
 const {chromium}=await import('playwright');
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#123}button{position:absolute;left:128px;top:144px;width:128px;height:72px}</style>
 <body data-state="BASE"><button id="buy">BUY FEATURE</button><script>
 document.querySelector('#buy').addEventListener('click',async()=>{const res=await fetch('/api/spin',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'action=doSpin&bet=2'});if(res.ok)document.body.dataset.state='BONUS';});
 </script>`;
 const launcher={async launch(opts){const browser=await chromium.launch(opts);return {
   async newContext(copts){const ctx=await browser.newContext(copts);
    await ctx.route('https://www.pragmaticplay.fun/en/slots/alpha/',r=>r.fulfill({status:200,contentType:'text/html',body:html}));
    await ctx.route('https://www.pragmaticplay.fun/api/spin',r=>r.fulfill({status:200,contentType:'application/json',body:'{"rs":"mc","win":0}'}));return ctx;},
   close:()=>browser.close()};}};
 const task={runId:'r',provider:'pragmatic',gameId:'alpha',shotId:'step-test',parentId:'r:pragmatic:alpha:base',parentSourceSha256:'a'.repeat(64),parentRevision:2,
  path:[{kind:'buy',label:'BUY FEATURE',state:'BASE',x:.15,y:.25,controlPath:'Game/Buy'}]};
 const source={runId:'r',provider:'pragmatic',gameId:'alpha',state:'BASE',metadata:{url:'https://www.pragmaticplay.fun/en/slots/alpha/'}};
 const inspect=async page=>{const state=await page.evaluate(()=>document.body.dataset.state);
  return {frame:page.mainFrame(),data:{state,mode:state==='BASE'?'structured':'visual',adapter:'test-runtime',adapterVersion:'1',candidates:state==='BASE'?[{id:'c1',label:'BUY FEATURE',confidence:.95,path:'Game/Buy',rect:{x:.1,y:.2,w:.1,h:.1}}]:[]}};};
 const result=await executeDemoBranch(task,source,{chromium:launcher,openDemo:async()=>({launched:true}),inspect,frameBox:async()=>({clip:null,aligned:true}),waitMs:650,log:()=>{}});
 assert.equal(result.info.state,'BONUS');assert.equal(result.info.metadata.evidenceStatus,'bet_request_observed');
 assert.equal(result.info.metadata.terminal,true);assert.equal(result.image[0],255);assert.equal(result.image[1],216);
 const wager=result.trace.log.entries.find(e=>e.request.method==='POST'&&e.request.url.includes('/api/spin'));
 assert.ok(wager);assert.match(wager.request.postData.text,/doSpin/);
});
