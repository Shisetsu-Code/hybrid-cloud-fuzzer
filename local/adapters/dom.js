// Generic HTML/DOM adapter: valid for any provider with accessible document controls.
// Evaluated inside a browser frame. Must not depend on Node imports or globals.
export function inspectDOM(){
  const rectOf=el=>{const r=el.getBoundingClientRect(),w=innerWidth,h=innerHeight;
    if(!w||!h||r.width<7||r.height<7||r.right<=0||r.bottom<=0||r.left>=w||r.top>=h)return null;
    const x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(w,r.right),bottom=Math.min(h,r.bottom);
    if(right<=x||bottom<=y)return null;
    return {x:x/w,y:y/h,w:(right-x)/w,h:(bottom-y)/h};
  };
  const path=el=>{const parts=[];for(let p=el,n=0;p&&p.nodeType===1&&n<8;p=p.parentElement,n++){
    const idx=p.parentElement?[...p.parentElement.children].indexOf(p)+1:1;
    parts.unshift(p.tagName.toLowerCase()+(p.id?'#'+p.id:'')+':nth-child('+idx+')');}
    return parts.join(' > ');
  };
  const q='button,[role="button"],[role="menuitem"],[role="option"],[role="switch"],input[type="button"],input[type="submit"],a[href],select';
  const nodes=[...document.querySelectorAll(q)].slice(0,600),items=[];
  for(const el of nodes){
    const style=getComputedStyle(el);
    if(style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0||el.disabled||el.getAttribute('aria-disabled')==='true')continue;
    const rect=rectOf(el);if(!rect)continue;
    const cx=(rect.x+rect.w/2)*innerWidth,cy=(rect.y+rect.h/2)*innerHeight;
    const top=document.elementFromPoint(cx,cy);
    if(top&&!el.contains(top)&&!top.contains(el))continue;
    const name=(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.value||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,180);
    const role=el.getAttribute('role')||el.tagName.toLowerCase();
    const p=path(el);
    items.push({label:name||role,role,rect,source:'dom',confidence:name?0.88:0.56,path:p});
    if(items.length===220)break;
  }
  const canvas=[...document.querySelectorAll('canvas')].some(c=>{const r=c.getBoundingClientRect();return r.width*r.height>innerWidth*innerHeight*.23;});
  return {adapter:'generic-dom',adapterVersion:'1',state:'UNKNOWN',opaqueCanvas:canvas,candidates:items};
}
