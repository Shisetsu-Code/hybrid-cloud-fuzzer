#!/usr/bin/env node
// Optional live speed control for an already running LOCAL Chromium CDP browser.
// This does not start games, click buttons, spin or bypass server-side delays.
import {cli} from './utils.js';
import {validateSpeed,speedUpGame} from './speed.js';
const args=cli(process.argv.slice(2));
if(args.help){console.log('node local/speed-control.mjs --cdp=http://127.0.0.1:9222 --host=demogamesfree.pragmaticplay.net --speed=4 [--watch]');process.exit(0);}
const factor=validateSpeed(args.speed||4);
if(!args.host||!args.cdp)throw Error('--cdp and --host are required; only local Chromium debugging ports are allowed');
const endpoint=new URL(String(args.cdp));
if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!endpoint.port||endpoint.username||endpoint.password)throw Error('CDP endpoint must be local http://127.0.0.1:<port>');
const host=String(args.host).toLowerCase();
if(!/^[a-z0-9.-]+$/.test(host)||!host.includes('.'))throw Error('Invalid demo host');
const {chromium}=await import('playwright');
const browser=await chromium.connectOverCDP(endpoint.toString());
let count=0;
async function apply(){
  for(const context of browser.contexts())for(const page of context.pages())for(const frame of page.frames()){
    let name;try{name=new URL(frame.url()).hostname.toLowerCase();}catch{continue;}
    if(name!==host&& !name.endsWith('.'+host))continue;
    const r=await speedUpGame(page,frame,factor);
    if(r.installed)count++;
  }
}
try{
  await apply();console.log(`Speed ${factor}x applied to ${count} matching frame(s)`);
  if(args.watch){
    console.log('Watching for new demo frames. Ctrl+C to stop.');
    let stop=false;process.once('SIGINT',()=>{stop=true;});process.once('SIGTERM',()=>{stop=true;});
    while(!stop){await new Promise(resolve=>setTimeout(resolve,2000));await apply();}
  }
}finally{await browser.close();}
