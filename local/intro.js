// Only dismiss a verified Pragmatic public DEMO intro; never click in unknown providers.
const KNOWN=/\/IntroScreen\/.*(?:\/StartSpin_Button|\/CloseButton\/ButtonSpin)$/i;

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
