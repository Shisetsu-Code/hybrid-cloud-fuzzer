// Only dismiss a verified Pragmatic public DEMO intro; never click in unknown providers.
const KNOWN=/\/IntroScreen\/.*(?:\/StartSpin_Button|\/CloseButton\/ButtonSpin)$/i;

// Only the public catalogue's DEMO launcher, never a game purchase/spin button.
export async function openPublicDemo(page,{provider,url,confirmAdult=false}={}){
  const target=new URL(url);
  if(provider!=='pragmatic'||target.protocol!=='https:'||target.hostname!=='www.pragmaticplay.fun'||!/^\/en\/slots\/[a-z0-9-]+\/$/.test(target.pathname))return {launched:false};
  const verifyDestination=()=>{
    const current=new URL(page.url());
    if(current.origin!==target.origin||current.pathname!==target.pathname)throw Error('Public demo redirected to an unapproved destination');
  };
  verifyDestination();
  const demo=page.locator('iframe[src*="demogamesfree.pragmaticplay.net"]');
  const reject=async()=>{
    const button=page.getByRole('button',{name:/^reject all$|^rechazar todo$/i}).first();
    if(await button.count()&&await button.isVisible()){verifyDestination();await button.click({timeout:2500});}
  };
  if(await demo.count()){await reject();return {launched:false};}
  const launch=page.getByRole('button',{name:/^play demo$|^jugar demo$|^probar demo$/i}).first();
  await launch.waitFor({state:'visible',timeout:15000});
  await reject();
  verifyDestination();
  await launch.click({timeout:10000});
  const age=page.locator('button[data-age-gate-confirm="true"]').first();
  if(await age.count()){
    await age.waitFor({state:'visible',timeout:2500}).catch(()=>{});
    if(await age.isVisible()){
      if(!confirmAdult)throw Error('Operator adult age confirmation required (--confirm-adult)');
      verifyDestination();
      await age.click({timeout:5000});
    }
  }
  await demo.first().waitFor({state:'visible',timeout:25000});
  await reject();
  return {launched:true};
}

export function knownIntroCandidate(data){
  if(data?.state!=='INTRO'||data?.adapter!=='pragmatic-runtime')return null;
  const found=(data.candidates||[]).filter(c=>KNOWN.test(c.path||'')&&c.rect&&c.confidence>=0.8);
  return found.length===1?found[0]:null;
}
export async function dismissKnownIntro(page,selected,{inspect,wait=ms=>page.waitForTimeout(ms)}={}){
  const control=knownIntroCandidate(selected?.data);
  if(!control)return {dismissed:false,selected};
  const frame=selected.frame;
  let x,y;
  if(frame===page.mainFrame()){
    const viewport=page.viewportSize();
    if(!viewport)return {dismissed:false,selected};
    x=(control.rect.x+control.rect.w/2)*viewport.width;
    y=(control.rect.y+control.rect.h/2)*viewport.height;
  }else{
    const box=await (await frame.frameElement()).boundingBox();
    const size=await frame.evaluate(()=>({width:innerWidth,height:innerHeight}));
    if(!box||!size||Math.abs(box.width-size.width)>2||Math.abs(box.height-size.height)>2)
      return {dismissed:false,selected};
    x=box.x+(control.rect.x+control.rect.w/2)*box.width;
    y=box.y+(control.rect.y+control.rect.h/2)*box.height;
  }
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0)return {dismissed:false,selected};
  await page.mouse.click(x,y,{delay:50});
  await wait(1000);
  const after=await inspect();
  return {dismissed:after?.data?.state!=='INTRO',selected:after||selected};
}
