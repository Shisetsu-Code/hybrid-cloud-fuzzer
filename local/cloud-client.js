// REST client for the existing Cloudflare D1/R2 review and ingest API.
export class CloudClient{
 constructor({endpoint,reviewToken,ingestToken,fetcher=fetch}={}){
  if(!/^https:\/\//.test(endpoint||''))throw Error('HYBRID_FUZZER_URL must be HTTPS');
  if(!reviewToken||!ingestToken)throw Error('Both HYBRID_REVIEW_TOKEN and HYBRID_INGEST_TOKEN required');
  this.endpoint=endpoint.replace(/\/$/,'');this.reviewToken=reviewToken;this.ingestToken=ingestToken;this.fetcher=fetcher;
 }
 async call(route,{role='review',method='GET',body=null,raw=false}={}){
  const token=role==='ingest'?this.ingestToken:this.reviewToken;
  const options={method,headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(40000)};
  if(body!=null){options.body=body;if(!(body instanceof FormData))options.headers['Content-Type']='application/json';}
  const res=await this.fetcher(this.endpoint+route,options);
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Error(`Cloudflare ${res.status} ${data.error||'request failed'} (${route.split('?')[0]})`);
  return raw?data:data;
 }
 async stats(runId){const q=new URLSearchParams({runId});return (await this.call('/v1/stats?'+q)).counts;}
 async allDecisions(runId){
  const result=[];let after=0;
  for(let n=0;n<1000;n++){
   const q=new URLSearchParams({runId,after:String(after),limit:'200'}),r=await this.call('/v1/decisions?'+q);
   result.push(...r.items);if(!r.items.length||r.items.length<200)return result;
   if(r.nextAfter<=after)throw Error('Cloudflare decision cursor did not advance');after=r.nextAfter;
  }
  throw Error('decision feed exceeds pagination budget');
 }
 // Return the game IDs that have unclassified, leased or needs-review captures.
 // This is a separate read-only, paginated REVIEW-token query: never guess that
 // an empty /v1/decisions feed means an unresolved game is ready.
 async blockedGames(runId){
  const blocked=new Set();let after='';
  for(let page=0;page<1000;page++){
   const q=new URLSearchParams({runId,after,limit:'250'});
   const data=await this.call('/v1/game-blockers?'+q);
   if(!data||!Array.isArray(data.items)||typeof data.hasMore!=='boolean')throw Error('invalid game blocker response');
   for(const entry of data.items){
    if(!entry||typeof entry.provider!=='string'||typeof entry.gameId!=='string')throw Error('invalid blocked game identity');
    blocked.add(entry.provider+'/'+entry.gameId);
   }
   if(!data.hasMore)return blocked;
   if(typeof data.nextAfter!=='string'||data.nextAfter<=after)throw Error('game blocker cursor did not advance');
   after=data.nextAfter;
  }
  throw Error('game blockers exceed pagination budget');
 }
 async item(id){return (await this.call('/v1/items/'+encodeURIComponent(id))).item;}
 async uploadCapture(item,image){
  if(item.mode==='structured')return this.call('/v1/items',{role:'ingest',method:'POST',body:JSON.stringify(item)});
  if(!image)throw Error('visual/hybrid upload requires JPEG');
  const form=new FormData();form.set('metadata',JSON.stringify(item));form.set('image',new Blob([image],{type:'image/jpeg'}),`${item.shotId}.jpg`);
  return this.call('/v1/items',{role:'ingest',method:'POST',body:form});
 }
 async uploadTrace(data){return this.call('/v1/traces',{role:'ingest',method:'POST',body:JSON.stringify(data)});}
}
