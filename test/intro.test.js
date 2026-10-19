import test from 'node:test';
import assert from 'node:assert/strict';
import {knownIntroCandidate,dismissKnownIntro} from '../local/intro.js';
const sample={state:'INTRO',adapter:'pragmatic-runtime',candidates:[{confidence:.92,path:'Root/IntroScreen/content/IntroButtons/SpinButtons/StartSpin_Button',rect:{x:.7,y:.6,w:.12,h:.15}}]};
test('Pragmatic known intro is dismissed exactly once and resulting state is checked',async()=>{
  let clicks=0;const frame={};const page={mainFrame:()=>frame,viewportSize:()=>({width:1000,height:500}),mouse:{click:async(x,y)=>{clicks++;assert.ok(x>700&&x<900);assert.ok(y>300&&y<450);}}};
  const result=await dismissKnownIntro(page,{frame,data:sample},{inspect:async()=>({frame,data:{state:'BASE',adapter:'pragmatic-runtime'}}),wait:async()=>{}});
  assert.equal(result.dismissed,true);assert.equal(clicks,1);
});
test('never click unknown providers or multiple intro candidates',async()=>{
  const f={};let clicked=false;const page={mainFrame:()=>f,viewportSize:()=>({width:1000,height:600}),mouse:{click:async()=>{clicked=true;}}};
  assert.equal(knownIntroCandidate({...sample,adapter:'generic-dom'}),null);
  assert.equal(knownIntroCandidate({...sample,candidates:[...sample.candidates,...sample.candidates]}),null);
  const result=await dismissKnownIntro(page,{frame:f,data:{...sample,adapter:'generic-dom'}},{inspect:async()=>{throw Error('Should never inspect again');}});
  assert.equal(result.dismissed,false);assert.equal(clicked,false);
});
