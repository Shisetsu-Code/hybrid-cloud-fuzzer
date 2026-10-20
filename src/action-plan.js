// Pure planning rules shared by the Worker progress view and local executor.
export const isCatalogueOverlayAction=action=>/reject\s+all|rechazar\s+todo|cookies?|consent\s+overlay|privacy\s+(?:notice|dialog)|age\s+gate/i.test((action?.label||'')+' '+(action?.controlPath||''));
const kinds=new Set(['buy','navigate','pick','other']);
const key=a=>`${a.state}|${String(a.controlPath||a.label||'').toLowerCase()}|${a.kind}`;
export function reviewedAction(item,index){
 if(item?.status!=='classified'||!item.sourceSha256||!Number.isInteger(item.revision))throw Error('decision must be classified with current revision');
 const selection=item.decisions?.allMarks?.[index];
 if(!selection||!kinds.has(selection.kind)||!Number.isFinite(selection.x)||!Number.isFinite(selection.y)||selection.x<0||selection.x>1||selection.y<0||selection.y>1)throw Error('invalid classified action');
 const chosen=item.decisions?.selections?.find(s=>s.kind===selection.kind&&s.label===selection.label&&s.x===selection.x&&s.y===selection.y);
 const candidateId=chosen?.candidateId||selection.candidateId;
 const candidate=candidateId?(item.candidates||[]).find(c=>c.id===candidateId):null;
 if(candidateId&&!candidate)throw Error('stale candidate');
 return {kind:selection.kind,label:String(selection.label||candidate?.label||'').slice(0,140),x:selection.x,y:selection.y,state:item.state,...(candidate?.path?{controlPath:candidate.path}:{}),...(candidateId?{candidateId}:{})};
}
export function eligibleReviewedPath(action,ancestors,{maxDepth=7,allowNormalSpin=false}={}){
 if(!Array.isArray(ancestors)||ancestors.length>=maxDepth||ancestors.length>20)return false;
 if(ancestors.some(isCatalogueOverlayAction)||isCatalogueOverlayAction(action))return false;
 const label=(action.label||'')+' '+(action.controlPath||'');
 if(/AutoPlay|Settings|Gear|SoundToggle|HelpButton|MenuButton/i.test(label))return false;
 if(!allowNormalSpin&&action.state==='BASE'&&/(?:Spin[_/-]?Normal|Normal[_/-]?Spin|AutoSpin|SpinButton)/i.test(label))return false;
 return !ancestors.some(a=>key(a)===key(action));
}
