// Pragmatic's public demo runtime (read-only). Other providers do NOT use this adapter.
// Execute in the demo frame with frame.evaluate(inspectPragmatic).
export function inspectPragmatic(){
  const safe=fn=>{try{return fn();}catch{return null;}};
  const roots=globalThis.globalRuntime?.sceneRoots||[];
  const canvas=document.querySelector('canvas');
  if(!canvas||!roots.length)return {supported:false};
  const cr=canvas.getBoundingClientRect();
  const vw=innerWidth,vh=innerHeight;
  const rw=globalThis.UHTScreen?.width||canvas.width;
  const rh=globalThis.UHTScreen?.height||canvas.height;
  const cameraType=globalThis.Camera;
  const cameras=(cameraType?roots.flatMap(r=>safe(()=>r.GetComponentsInChildren(cameraType,true))||[]):[])
    .filter(c=>c.enabled!==false).sort((a,b)=>(b.depth||0)-(a.depth||0));
  const items=[],seen=new Set(),types=['XTButton','CATButton','UIButton'];
  for(const root of roots)for(const type of types){
    const ctor=globalThis[type];if(!ctor)continue;
    for(const button of safe(()=>root.GetComponentsInChildren(ctor,true))||[]){
      const go=button.gameObject;
      if(!go||seen.has(go)||go.activeInHierarchy!==true||button.enabled===false||button.xtEnabled===false||!go.collider||go.collider.enabled===false)continue;
      seen.add(go);
      const segs=[];for(let t=go.transform,n=0;t&&n<22;t=t.parent,n++)segs.unshift(String(t.gameObject?.name||''));
      const path=segs.join('/');
      const labels=[];
      for(let t=go.transform,n=0;t&&n<4;t=t.parent,n++){
        for(const cls of ['UILabel','UISprite']){
          const c=globalThis[cls];if(!c)continue;
          for(const w of safe(()=>t.gameObject.GetComponentsInChildren(c,true))||[]){
            if(w.gameObject?.activeInHierarchy!==true)continue;
            if(typeof w.text==='string'&&w.text.trim())labels.push(w.text.trim().replace(/\s+/g,' ').slice(0,90));
            if(typeof w.spriteName==='string'&&w.spriteName.trim())labels.push(w.spriteName.slice(0,90));
          }
        }
        if(labels.length)break;
      }
      const geom=safe(()=>go.collider.GetTransformedCenterAndSize());
      let rect=null;
      if(geom?.center&&geom?.size){
        const cam=cameras.find(c=>((Number(c.cullingMask)||0)&(1<<go.layer))!==0);
        if(cam){
          const v=geom.center,s=geom.size;
          const points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>safe(()=>cam.WorldToScreenPoint({x:v.x+x*s.x/2,y:v.y+y*s.y/2,z:v.z})));
          if(points.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y))){
            const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
            const x1=Math.max(0,cr.x+Math.min(...xs)*cr.width/rw),y1=Math.max(0,cr.y+Math.min(...ys)*cr.height/rh);
            const x2=Math.min(vw,cr.x+Math.max(...xs)*cr.width/rw),y2=Math.min(vh,cr.y+Math.max(...ys)*cr.height/rh);
            if(x2>x1&&y2>y1)rect={x:x1/vw,y:y1/vh,w:(x2-x1)/vw,h:(y2-y1)/vh};
          }
        }
      }
      if(rect)items.push({label:[...new Set(labels)].slice(0,2).join(' / ')||go.name||path.split('/').at(-1),path,rect,role:'button',source:'runtime',confidence:0.92});
    }
  }
  const paths=items.map(c=>c.path);
  let state='BASE';
  if(paths.some(p=>/IntroScreen/i.test(p)))state='INTRO';
  else if(paths.some(p=>/ConfirmPurchaseWindow|FSPurchaseWindow\/content\/Buttons/i.test(p)))state='CONFIRM';
  else if(paths.some(p=>/PurchaseWindow\/content\/Options/i.test(p)))state='BUY_MENU';
  else if(paths.some(p=>/FreeSpins\/Content|StageResultFreeSpin/i.test(p)))state='BONUS';
  return {supported:true,adapter:'pragmatic-runtime',adapterVersion:'1',state,candidates:items.slice(0,250),opaqueCanvas:true};
}
