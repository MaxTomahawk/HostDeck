import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FileAdapter} from '../src/hostdeck/files.js';
import {ProviderRegistry} from '../src/hostdeck/providers.js';
import {RuntimeError} from '../src/hostdeck/runtime-error.js';

test('explicit provider uses authorized snapshots, Unicode metadata, stable paging and preserved preferences',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hostdeck-provider-search-')));
 const workspace=path.join(root,'workspace');await mkdir(workspace);
 const context={ownerId:'owner-a',deviceId:'device-a',executorId:'executor-a',sessionIds:[1]};
 const sibling=path.join(root,'private.txt');await writeFile(sibling,'secret');
 const names=['é 中文.txt',"quote's.txt",'[abc].txt'];
 for(const n of names)await writeFile(path.join(workspace,n),'owned');
 await mkdir(path.join(workspace,'folder'));
 const preferences=await ProviderRegistry.open(path.join(root,'preferences.sqlite'));
 let calls=0;
 const everything={sessionId:1,status:async()=>({installed:true,enabled:true,running:true,compatible:true,healthy:true,reason:'ready'}),
  query:async()=>{calls++;return {paths:[sibling,...names.map(n=>path.join(workspace,n)),path.join(workspace,'folder')],truncated:false,version:'fixture',instance:'fixture',session_id:1,runtime_id:'fixture'};}};
 const adapter=await FileAdapter.create({workspace,providers:preferences,everything:everything as any,reauthorize:async()=>{}} as any);
 const call=(name:string,args:Record<string,unknown>={})=>adapter.handle('hostdeck_'+name,{device_id:context.deviceId,...args},context) as Promise<any>;
 const done=async(id:string)=>{for(let i=0;i<100;i++){const page=await call('search_results',{search_id:id,limit:100});if(page.complete)return page;await new Promise(r=>setTimeout(r,5));}throw Error('fixture search stalled');};
 try{
  await call('set_provider_preference',{capability:'files.name',provider:'everything'});
  const start=await call('search_files',{path:'.',pattern:'.',provider:'everything',entry_type:'all',sort:'path',metadata:true});
  const result=await done(start.search_id);
  assert.equal(result.state,'complete',JSON.stringify(result));
  assert.equal(start.provider,'everything');assert.equal(calls,1);
  assert.deepEqual(result.items.map((x:any)=>x.path).sort(),names.slice().sort());
  assert.ok(result.items.every((x:any)=>x.size===5&&x.modified&&x.metadata_source==='filesystem_readback'));
  assert.equal(result.total_results,3);assert.equal(JSON.stringify(result).includes('private.txt'),false);
  await assert.rejects(adapter.handle('hostdeck_search_results',{device_id:context.deviceId,search_id:start.search_id},{...context,sessionIds:[2]}),/EVERYTHING_WRONG_SESSION/);
  const first=await call('search_results',{search_id:start.search_id,offset:0,limit:1});
  const rest=await call('search_results',{search_id:start.search_id,offset:1,limit:100});
  assert.deepEqual([...first.items,...rest.items],result.items);
  await assert.rejects(adapter.handle('hostdeck_search_results',{device_id:context.deviceId,search_id:start.search_id},{...context,ownerId:'owner-b'}),/SEARCH_NOT_OWNED/);
  const literal=await call('search_files',{path:'.',pattern:'ext:txt',provider:'everything'});
  assert.deepEqual((await done(literal.search_id)).items.map((x:any)=>x.path),[]);
  const temporary=await call('search_files',{path:'.',pattern:'owned',mode:'content',provider:'direct'});
  assert.equal((await done(temporary.search_id)).provider,'direct');
  assert.equal(await preferences.select(context,'files.name'),'everything');
  await assert.rejects(call('search_files',{path:'.',pattern:'x',mode:'content',provider:'everything'}),/PROVIDER_CAPABILITY_UNSUPPORTED/);
  await assert.rejects(adapter.handle('hostdeck_search_files',{device_id:context.deviceId,path:'.',pattern:'x',provider:'everything'},{...context,sessionIds:[2]}),/EVERYTHING_WRONG_SESSION/);
  const unavailable=await FileAdapter.create({workspace,providers:preferences} as any);
  await assert.rejects(unavailable.handle('hostdeck_search_files',{device_id:context.deviceId,path:'.',pattern:'x'},context),/EVERYTHING_NOT_CONFIGURED/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('explicit hidden roots and depth boundaries preserve direct/Everything semantics',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hostdeck-search-depth-')));
 const hidden=path.join(root,'.hidden');await mkdir(hidden);const ordinary=path.join(hidden,'ordinary.txt');await writeFile(ordinary,'owned');
 let deepest=root;for(let n=0;n<20;n++){deepest=path.join(deepest,'a');await mkdir(deepest);}
 const over=path.join(deepest,'a-deeper');await mkdir(over);const deepFile=path.join(over,'too-deep.txt');await writeFile(deepFile,'omit');
 const sibling=path.join(deepest,'z-needle.txt');await writeFile(sibling,'retain');
 const context={ownerId:'a',deviceId:'d',executorId:'e',sessionIds:[1]};
 const everything={sessionId:1,status:async()=>({reason:'ready'}),query:async()=>({paths:[hidden,ordinary,deepFile,sibling],truncated:false,version:'fixture',instance:'',session_id:1,runtime_id:'fixture'})};
 const adapter=await FileAdapter.create({workspace:root,everything:everything as any});
 const query=async(provider:string,searchPath:string,pattern:string,entry_type='files')=>{
  const start=await adapter.handle('hostdeck_search_files',{device_id:'d',path:searchPath,pattern,provider,entry_type},context) as any;
  for(let i=0;i<100;i++){const result=await adapter.handle('hostdeck_search_results',{device_id:'d',search_id:start.search_id},context) as any;if(result.complete)return result;await new Promise(r=>setTimeout(r,5));}throw Error('fixture timed out');
 };
 try{
  for(const provider of ['everything','direct']){
   assert.deepEqual((await query(provider,'.hidden','ordinary')).items.map((x:any)=>x.path),[path.join('.hidden','ordinary.txt')]);
   assert.deepEqual((await query(provider,'.hidden','.hidden','directories')).items,[]);
   const depth=await query(provider,'.','needle');assert.deepEqual(depth.items.map((x:any)=>x.path),[path.relative(root,sibling)]);assert.equal(depth.truncated,true);
   assert.deepEqual((await query(provider,'.','too-deep')).items,[]);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('provider cancellation waits for acknowledgement and changed junction targets never leak in pages',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hostdeck-provider-negative-')));
 const workspace=path.join(root,'allowed'),outside=path.join(root,'excluded');await mkdir(workspace);await mkdir(outside);
 const target=path.join(workspace,'entry.txt');await writeFile(target,'owned');await writeFile(path.join(outside,'hidden.txt'),'excluded');
 const context={ownerId:'a',deviceId:'d',executorId:'e',sessionIds:[1]};
 let hang=false,acknowledged=false;
 const client={sessionId:1,status:async()=>({reason:'ready'}),query:async(_root:string,_timeout:number,signal:AbortSignal)=>{
  if(hang)return new Promise<any>((_resolve,reject)=>signal.addEventListener('abort',()=>{setTimeout(()=>{acknowledged=true;reject(new RuntimeError('EVERYTHING_CANCELLED'));},30);},{once:true}));
  return {paths:[target,path.join(workspace,'escape','hidden.txt')],truncated:false,version:'fixture',instance:'',session_id:1,runtime_id:'fixture'};
 }};
 const adapter=await FileAdapter.create({workspace,everything:client as any});
 const call=(name:string,args:Record<string,unknown>)=>adapter.handle('hostdeck_'+name,{device_id:'d',...args},context) as Promise<any>;
 try{
  await symlink(outside,path.join(workspace,'escape'),process.platform==='win32'?'junction':'dir');
  const started=await call('search_files',{path:'.',pattern:'.txt',provider:'everything'});
  let result:any;for(let i=0;i<100;i++){result=await call('search_results',{search_id:started.search_id});if(result.complete)break;await new Promise(r=>setTimeout(r,5));}
  assert.deepEqual(result.items.map((x:any)=>x.path),['entry.txt']);assert.equal(result.total_results,1);
  hang=true;const pending=await call('search_files',{path:'.',pattern:'x',provider:'everything'});
  await call('stop_search',{search_id:pending.search_id});
  assert.equal((await call('search_results',{search_id:pending.search_id})).complete,false);
  for(let i=0;i<100&&!acknowledged;i++)await new Promise(r=>setTimeout(r,5));
  const cancelled=await call('search_results',{search_id:pending.search_id});
  assert.equal(acknowledged,true);assert.equal(cancelled.complete,true);assert.equal(cancelled.state,'stopped');
  assert.equal(JSON.stringify(cancelled).includes('excluded'),false);
 }finally{
  await rm(path.join(workspace,'escape'),{force:true,recursive:true});
  await rm(root,{recursive:true,force:true});
 }
});
