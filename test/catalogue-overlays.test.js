import test from 'node:test';
import assert from 'node:assert/strict';
import {dismissCatalogueOverlays,openPublicDemo} from '../local/intro.js';
import {collectTasks} from '../local/rounds.js';

const url='https://www.pragmaticplay.fun/en/slots/alpha/';
function fakePage({cookie=false,age=false,lateCookie=false,currentUrl=url,iframeAttached=true}={}){
 let activeCookie=cookie,activeAge=age;const clicks=[];
 const locator=kind=>({
  first(){return this;},
  count:async()=>kind==='iframe'?Number(iframeAttached):kind==='cookie'?Number(activeCookie):kind==='age'?Number(activeAge):0,
  isVisible:async()=>kind==='cookie'?activeCookie:kind==='age'?activeAge:kind==='iframe'?iframeAttached:false,
  click:async()=>{clicks.push(kind);if(kind==='cookie')activeCookie=false;if(kind==='age')activeAge=false;},
  waitFor:async()=>{}
 });
 return {clicks,url:()=>currentUrl,
  locator:s=>locator(s.startsWith('iframe')?'iframe':s.includes('data-age-gate-confirm')?'age':'none'),
  getByRole:(_role,{name})=>locator(name.test('Reject All')?'cookie':'none'),
  waitForTimeout:async()=>{if(lateCookie)activeCookie=true;lateCookie=false;},
  hasCookie:()=>activeCookie,hasAge:()=>activeAge
 };
}
test('late-loading consent on an attached demo is rejected, and never becomes a game branch',async()=>{
 const page=fakePage({lateCookie:true});
 const result=await dismissCatalogueOverlays(page,{provider:'pragmatic',url,graceMs:300});
 assert.equal(result.cookiesDismissed,1);assert.equal(page.hasCookie(),false);
 assert.deepEqual(page.clicks,['cookie']);
 const decision={id:'r:pragmatic:alpha:base',status:'classified',revision:2,sourceSha256:'a'.repeat(64),runId:'r',provider:'pragmatic',gameId:'alpha',
  state:'BASE',metadata:{},decisions:{allMarks:[
   {x:.875,y:.972,kind:'navigate',label:'Reject All cookies; dismiss consent overlay'},
   {x:.2,y:.3,kind:'buy',label:'BUY FREE SPINS'}
  ]}};
 assert.equal(collectTasks([decision]).length,1);
 assert.equal(collectTasks([decision])[0].path[0].kind,'buy');
});
test('age gate is never acknowledged without explicit adult authorization, including attached iframe',async()=>{
 const page=fakePage({age:true});
 await assert.rejects(()=>openPublicDemo(page,{provider:'pragmatic',url}),/adult|age/i);
 assert.deepEqual(page.clicks,[]);
 const approved=await openPublicDemo(page,{provider:'pragmatic',url,confirmAdult:true});
 assert.equal(approved.launched,false);assert.deepEqual(page.clicks,['age']);assert.equal(page.hasAge(),false);
});
test('consent cleanup rejects unrelated/redirected origins and avoids clicking on them',async()=>{
 const page=fakePage({cookie:true,currentUrl:'https://casino.example/en/slots/alpha/'});
 await assert.rejects(()=>dismissCatalogueOverlays(page,{provider:'pragmatic',url}),/destination|redirect/i);
 assert.deepEqual(page.clicks,[]);
 assert.deepEqual(await dismissCatalogueOverlays(page,{provider:'other',url}),{cookiesDismissed:0,ageConfirmed:false});
 assert.deepEqual(page.clicks,[]);
});
test('popup checks are repeatable after a new context opens an already-attached iframe',async()=>{
 const page=fakePage({cookie:true});
 const opened=await openPublicDemo(page,{provider:'pragmatic',url});
 assert.equal(opened.launched,false);assert.equal(page.hasCookie(),false);
 const repeated=await dismissCatalogueOverlays(page,{provider:'pragmatic',url});
 assert.equal(repeated.cookiesDismissed,0);assert.deepEqual(page.clicks,['cookie']);
});
