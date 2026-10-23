import test from 'node:test';
import assert from 'node:assert/strict';
import {settleGame,transitionDecision} from '../local/transitions.js';
const control=(label,path='Game/Continue')=>({label,path,confidence:.95,rect:{x:.4,y:.4,w:.2,h:.1}});
const screen=(state,phase,candidates=[])=>({frame:{},data:{state,candidates,metadata:{roundPhase:phase}}});

test('confirmation belongs to an already reviewed purchase; it never starts a new buy',()=>{
 const selected=screen('CONFIRM','awaiting_confirmation',[control('Confirm')]);
 assert.equal(transitionDecision(selected,{purchaseAuthorized:false}).kind,'review');
 assert.equal(transitionDecision(selected,{purchaseAuthorized:true}).kind,'click');
 assert.equal(transitionDecision(screen('BASE','idle',[control('Buy free spins')]),{purchaseAuthorized:true}).kind,'idle');
});

test('real Pragmatic BuyWindow accept icon is a confirmation, never its reject icon',()=>{
 const path='Game/BuyFeature/PurchaseManager/BuyWindow/Content/BF/Offset/Buttons/';
 const s=screen('CONFIRM','awaiting_confirmation',[control('button / accept',path+'ButtonYes'),control('button / reject',path+'ButtonNo')]);
 assert.equal(transitionDecision(s,{purchaseAuthorized:true}).control.path,path+'ButtonYes');
 assert.equal(transitionDecision(s,{purchaseAuthorized:false}).kind,'review');
});
test('multiple choices and ambiguous confirmation buttons return to the image batch',()=>{
 assert.equal(transitionDecision(screen('BONUS','choice',[control('Pick 1'),control('Pick 2')]),{purchaseAuthorized:true}).kind,'review');
 assert.equal(transitionDecision(screen('CONFIRM','awaiting_confirmation',[control('Confirm','A'),control('Confirm','B')]),{purchaseAuthorized:true}).kind,'review');
});
test('keeps watching bonus, starts it, collects its result, then requires stable idle',async()=>{
 const sequence=[screen('CONFIRM','awaiting_confirmation',[control('Confirm')]),screen('BONUS','awaiting_start',[control('Start free spins')]),screen('BONUS','active'),screen('BONUS','active'),screen('BONUS','result',[control('Collect')]),screen('BASE','idle'),screen('BASE','idle')];
 let index=0,time=0;const clicked=[];
 const result=await settleGame({},'fixture',{inspect:async()=>sequence[Math.min(index++,sequence.length-1)],cleanup:async()=>{},sleep:async ms=>{time+=ms;},now:()=>time,pollMs:100,minIdleMs:100,purchaseAuthorized:true,click:async c=>clicked.push(c.label)});
 assert.deepEqual(clicked,['Confirm','Start free spins','Collect']);
 assert.equal(result.outcome,'completed');assert.ok(index>=7);
});
test('a request or an unchanged base screen alone does not prove a completed round',async()=>{
 let time=0;
 const result=await settleGame({},'fixture',{inspect:async()=>screen('BASE','idle'),cleanup:async()=>{},sleep:async ms=>{time+=ms;},now:()=>time,pollMs:100,minIdleMs:200});
 assert.equal(result.outcome,'next_screen');assert.equal(result.completed,false);
});
test('a frozen bonus reaches its bounded timeout without an extra purchase or spin',async()=>{
 let time=0,clicks=0;
 const result=await settleGame({},'fixture',{inspect:async()=>screen('BONUS','active'),cleanup:async()=>{},sleep:async ms=>{time+=ms;},now:()=>time,pollMs:100,timeoutMs:300,click:async()=>clicks++});
 assert.equal(result.outcome,'timeout');assert.equal(result.completed,false);assert.equal(clicks,0);
});
test('an unchanging continue prompt is clicked once, then returned for review',async()=>{
 let time=0,clicks=0;
 const result=await settleGame({},'fixture',{inspect:async()=>screen('BONUS','result',[control('Collect')]),cleanup:async()=>{},sleep:async ms=>{time+=ms;},now:()=>time,pollMs:100,click:async()=>clicks++});
 assert.equal(clicks,1);assert.equal(result.outcome,'needs_review');
});
test('a known following reviewed step takes precedence over automatic confirmation',async()=>{
 let time=0,clicks=0;
 const result=await settleGame({},'fixture',{inspect:async()=>screen('CONFIRM','awaiting_confirmation',[control('Confirm')]),cleanup:async()=>{},sleep:async ms=>{time+=ms;},now:()=>time,pollMs:100,minIdleMs:100,purchaseAuthorized:true,expectedState:'CONFIRM',click:async()=>clicks++});
 assert.equal(result.outcome,'next_screen');assert.equal(clicks,0);
});
