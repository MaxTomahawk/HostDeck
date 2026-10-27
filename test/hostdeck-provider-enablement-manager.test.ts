import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mountExtensionManager} from '../ui/newtree/extension-manager.js';
const {JSDOM}=createRequire(import.meta.url)('jsdom');

async function fixture(run:(f:any)=>Promise<void>,legacy=false) {
 const dom=new JSDOM('<main></main>',{url:'https://fixture.example'});
 const original=globalThis.document;
 globalThis.document=dom.window.document;
 let enabledOverride:boolean|null=null,device='fixture-device',current=true;
 let beforeHook:(()=>void)|undefined,afterHook:(()=>void)|undefined;
 const calls:string[]=[];let writes=0;
 const snapshot=()=>({providers:[
  {id:'direct',enabled:true,desiredEnabled:true,enabledOverride:null,configured:true,running:'on_demand',installed:true,healthy:true},
  {id:'everything',enabled:enabledOverride??true,...(legacy?{}:{desiredEnabled:enabledOverride??true,enabledOverride,configured:true}),installed:true,running:true,healthy:false},
 ],functions:[{capability:'files.name',preference:'everything',default:'direct',selected:'everything'}]});
 const call=async(name:string,args:any)=>{
  calls.push(name);
  if(name==='hostdeck_device_status')return {status:'ready'};
  if(name==='hostdeck_list_providers'){const hook=beforeHook;beforeHook=undefined;hook?.();return snapshot();}
  if(name==='hostdeck_set_provider_enabled'){
   assert.equal(args.provider,'everything');assert.ok([true,false,null].includes(args.enabled));
   writes++;enabledOverride=args.enabled;afterHook?.();afterHook=undefined;
   return {updated:true,provider:'everything',enabledOverride,desiredEnabled:enabledOverride??true};
  }
  throw Error('Unexpected tool: '+name);
 };
 const host=document.querySelector('main')!;
 const flush=async()=>{for(let n=0;n<5;n++)await new Promise(r=>setTimeout(r,0));};
 try{
  mountExtensionManager(host,{call,deviceId:()=>device,isCurrent:()=>current});await flush();
  const inspect=(name:string)=>{host.querySelector<HTMLButtonElement>('button[aria-label="Details for '+name+'"]')!.click();};
  inspect('Everything');
  const select=(value:string)=>{const input=host.querySelector<HTMLSelectElement>('#provider-enabled')!;assert.ok(input,'logical integration control exists');input.value=value;input.dispatchEvent(new dom.window.Event('change'));};
  const apply=()=>host.querySelector<HTMLButtonElement>('#provider-enabled-apply')!.click();
  await run({host,select,apply,inspect,flush,calls,writes:()=>writes,value:()=>enabledOverride,
   before:(hook:()=>void)=>{beforeHook=hook;},after:(hook:()=>void)=>{afterHook=hook;},
   external:(value:boolean|null)=>{enabledOverride=value;},device:()=>{device='other-device';},stale:()=>{current=false;}});
 }finally{globalThis.document=original;dom.window.close();}
}

test('manager uses before/set/after readback for logical integration enablement and keeps direct immutable',async()=>{
 await fixture(async(f:any)=>{
  const initial=f.calls.length;f.select('false');f.apply();f.apply();await f.flush();
  assert.deepEqual(f.calls.slice(initial),['hostdeck_list_providers','hostdeck_set_provider_enabled','hostdeck_list_providers']);
  assert.equal(f.writes(),1);assert.equal(f.value(),false);
  assert.match(f.host.querySelector('#provider-enabled-feedback').textContent,/verified on readback/);
  assert.match(f.host.querySelector('#extension-detail').textContent,/RunningYes/s);
  f.select('');f.apply();await f.flush();assert.equal(f.value(),null);assert.equal(f.writes(),2);
  f.inspect('HostDeck direct filesystem');assert.equal(f.host.querySelector('#provider-enabled-apply'),null);
 });
});

test('manager blocks enablement writes on device/context changes and concurrent preflight changes',async()=>{
 for(const condition of ['device','context','conflict'])await fixture(async(f:any)=>{
  f.select('false');f.before(()=>{
   if(condition==='device')f.device();else if(condition==='context')f.stale();else f.external(true);
  });f.apply();await f.flush();assert.equal(f.writes(),0,condition+' cannot write');
 });
});

test('manager reports mismatched readback as uncertain and never replays the write',async()=>{
 await fixture(async(f:any)=>{
  f.select('false');f.after(()=>f.external(true));f.apply();await f.flush();
  assert.equal(f.writes(),1);assert.match(f.host.querySelector('#provider-enabled-feedback').textContent,/disagree|uncertain|mismatch/i);
 });
});

test('older provider snapshots keep unknown logical integration state read-only',async()=>{
 await fixture(async(f:any)=>{
  assert.equal(f.host.querySelector('#provider-enabled-apply'),null);
  assert.match(f.host.querySelector('#extension-detail').textContent,/Logical integration state unavailable/);
  assert.equal(f.writes(),0);
 },true);
});
