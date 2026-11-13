import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ProviderRegistry} from '../src/hostdeck/providers.js';
import {FileAdapter} from '../src/hostdeck/files.js';
import {getToolContract,parseToolArguments,discoverTools} from '../src/hostdeck/contracts.js';
import {RuntimeError} from '../src/hostdeck/runtime-error.js';
import {AuditLog,TokenAuthority,PolicyGate,type Grant} from '../src/hostdeck/security.js';
import {HostDeckFacade} from '../src/hostdeck/gateway.js';

const context={ownerId:'owner-a',deviceId:'device-a',executorId:'executor-a',sessionIds:[1]};
async function removeOwnedTemp(root:string,prefix:string):Promise<void> {
 const temporary=await realpath(os.tmpdir()),target=await realpath(root);
 assert.ok(path.isAbsolute(target)&&path.dirname(target)===temporary&&path.basename(target).startsWith(prefix),'cleanup confined to the owned temporary fixture');
 await rm(target,{recursive:true,force:true});
}
async function fixture(run:(f:any)=>Promise<void>) {
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hostdeck-enablement-')));
 try {
  const workspace=path.join(root,'workspace');await mkdir(workspace);
  const hit=path.join(workspace,'owned.txt');await writeFile(hit,'owned');
  const database=path.join(root,'preferences.sqlite');
  const providers=await ProviderRegistry.open(database);
  let queries=0,allowed=true,release:undefined|(()=>void),waiting=false;
  const everything={sessionId:1,status:async()=>({installed:true,enabled:true,running:true,compatible:true,healthy:true,reason:'ready'}),
   query:async()=>{queries++;if(waiting)await new Promise<void>(resolve=>{release=resolve;});return {paths:[hit],truncated:false,version:'fixture',instance:'',session_id:1,runtime_id:'fixture'};}};
  const adapter=await FileAdapter.create({workspace,providers,everything:everything as any,
   reauthorize:async()=>{if(!allowed)throw new RuntimeError('DENIED');}});
  const call=(name:string,args:Record<string,unknown>={},owner=context)=>adapter.handle('hostdeck_'+name,{device_id:owner.deviceId,...args},owner) as Promise<any>;
  const done=async(id:string)=>{for(let n=0;n<100;n++){const result=await call('search_results',{search_id:id});if(result.complete)return result;await new Promise(r=>setTimeout(r,5));}throw Error('fixture timeout');};
  await run({workspace,everything,providers,database,call,done,queries:()=>queries,deny:()=>{allowed=false;},allow:()=>{allowed=true;},wait:()=>{waiting=true;},release:()=>release?.()});
 }finally{await removeOwnedTemp(root,'hostdeck-enablement-');}
}

test('Everything enablement is a bounded files-write contract and direct is immutable',async()=>{
 const name='hostdeck_set_provider_enabled';
 const contract=getToolContract(name);
 assert.deepEqual(contract.requiredScopes,['files:write']);assert.equal(contract.effect,'write');assert.equal(contract.domain,'user');
 assert.equal(discoverTools(new Set([name]))[0].annotations?.readOnlyHint,false);
 for(const enabled of [true,false,null])assert.equal(parseToolArguments(name,{device_id:context.deviceId,provider:'everything',enabled}).enabled,enabled);
 for(const args of [{provider:'direct',enabled:false},{provider:'everything'},{provider:'everything',enabled:'false'},{provider:'everything',enabled:false,install:true}])
  assert.throws(()=>parseToolArguments(name,{device_id:context.deviceId,...args}));
 await fixture(async({call}:any)=>{await assert.rejects(call('set_provider_enabled',{provider:'direct',enabled:false}));});
});

test('disabled explicit and preferred Everything never query or fall back; null restores default enabled',async()=>{
 await fixture(async({call,done,queries,providers}:any)=>{
  await call('set_provider_preference',{capability:'files.name',provider:'everything'});
  assert.equal((await done((await call('search_files',{path:'.',pattern:'owned'})).search_id)).total_results,1);
  const before=queries();
  const receipt=await call('set_provider_enabled',{provider:'everything',enabled:false});
  assert.equal(receipt.updated,true);assert.equal(receipt.desiredEnabled,false);assert.equal(receipt.enabledOverride,false);
  for(const extra of [{provider:'everything'},{}])await assert.rejects(call('search_files',{path:'.',pattern:'owned',...extra}),/PROVIDER_DISABLED/);
  assert.equal(queries(),before);
  assert.equal(await providers.preference(context,'files.name'),'everything');
  assert.equal((await call('search_files',{path:'.',pattern:'owned',provider:'direct'})).provider,'direct');
  const reset=await call('set_provider_enabled',{provider:'everything',enabled:null});
  assert.equal(reset.enabledOverride,null);assert.equal(reset.desiredEnabled,true);
  assert.equal((await done((await call('search_files',{path:'.',pattern:'owned'})).search_id)).total_results,1);
  assert.equal(queries(),before+1);
 });
});

test('enablement persists after reopen, isolates owner/device/executor, and leaves saved selection intact',async()=>{
 await fixture(async({call,database}:any)=>{
  await call('set_provider_preference',{capability:'files.name',provider:'everything'});
  await call('set_provider_enabled',{provider:'everything',enabled:false});
  const reopened=await ProviderRegistry.open(database);
  assert.equal(await reopened.enabled(context,'everything'),false);
  assert.equal(await reopened.select(context,'files.name'),'everything');
  for(const other of [{...context,ownerId:'owner-b'},{...context,deviceId:'device-b'},{...context,executorId:'executor-b'}]) {
   assert.equal(await reopened.enabled(other,'everything'),true);
   assert.equal(await reopened.preference(other,'files.name'),null);
  }
  await call('set_provider_enabled',{provider:'everything',enabled:true});assert.equal(await reopened.enabled(context,'everything'),true);
  await call('set_provider_enabled',{provider:'everything',enabled:null});assert.equal(await reopened.enabledOverride(context,'everything'),null);
  await assert.rejects(reopened.setEnabled(context,'direct' as any,false),/PROVIDER_IMMUTABLE/);
 });
});

test('live desired enablement, configuration, installation, running and health stay distinct',async()=>{
 await fixture(async({call}:any)=>{
  await call('set_provider_enabled',{provider:'everything',enabled:false});
  const status=await call('list_providers');const live=status.providers.find((p:any)=>p.id==='everything');
  assert.equal(live.desiredEnabled,false);assert.equal(live.enabled,false);assert.equal(live.configured,true);
  assert.equal(live.installed,true);assert.equal(live.running,true);assert.equal(live.healthy,true);
  assert.equal(live.enabledOverride,false);
 });
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-unconfigured-'));
 try{
  const adapter=await FileAdapter.create({workspace:root,reauthorize:async()=>{}});
  const status=await adapter.handle('hostdeck_list_providers',{device_id:context.deviceId},context) as any;
  const live=status.providers.find((p:any)=>p.id==='everything');
  assert.equal(live.desiredEnabled,true);assert.equal(live.configured,false);
  assert.equal(live.installed,null);assert.equal(live.running,null);assert.equal(live.healthy,null);
 }finally{await removeOwnedTemp(root,'hostdeck-unconfigured-');}
});

test('current authorization denies setter, observation, new queries and retained pages after revocation',async()=>{
 await fixture(async({call,done,deny,allow,queries}:any)=>{
  const started=await call('search_files',{path:'.',pattern:'owned',provider:'everything'});await done(started.search_id);
  const before=queries();deny();
  for(const [name,args] of [['set_provider_enabled',{provider:'everything',enabled:false}],['list_providers',{}],['search_files',{path:'.',pattern:'owned',provider:'everything'}],['search_results',{search_id:started.search_id}],['stop_search',{search_id:started.search_id}]] as const)
   await assert.rejects(call(name,args),/DENIED/);
  assert.equal(queries(),before);allow();
  assert.equal((await call('list_providers')).providers.find((p:any)=>p.id==='everything').desiredEnabled,true);
 });
});

test('disabling denies retained Everything pages and discards in-flight results even after re-enable',async()=>{
 await fixture(async({call,done,wait,release}:any)=>{
  const completed=await call('search_files',{path:'.',pattern:'owned',provider:'everything'});await done(completed.search_id);
  wait();const pending=await call('search_files',{path:'.',pattern:'owned',provider:'everything'});
  // Let the provider reach its controlled pending response before disabling.
  await new Promise(r=>setTimeout(r,5));
  await call('set_provider_enabled',{provider:'everything',enabled:false});
  for(const id of [completed.search_id,pending.search_id])await assert.rejects(call('search_results',{search_id:id}),/PROVIDER_DISABLED/);
  release();await new Promise(r=>setTimeout(r,5));
  await call('set_provider_enabled',{provider:'everything',enabled:true});
  for(const id of [completed.search_id,pending.search_id])await assert.rejects(call('search_results',{search_id:id}),/PROVIDER_DISABLED/);
 });
});

test('existing facade and PolicyGate enforce files-write discovery, fresh grant revocation and session boundaries',async()=>{
 await fixture(async({workspace,everything,providers,database,queries}:any)=>{
  const audit=await AuditLog.open(path.join(path.dirname(database),'audit'));
  try{
   const authority=new TokenAuthority({issuer:'https://issuer.example',audience:'https://resource.example',jwks:async()=>{throw Error('unused local-token fixture');}});
   const identity={sid:'fixture-user',sessionId:1,elevated:false,eligible:true};
   const principal=authority.local(identity,identity.sid,['files:read','files:write']);
   const reader=authority.local(identity,identity.sid,['files:read']);
   let grants:Grant[]=[{issuer:'hostdeck:local',subject:identity.sid,clientId:'stdio',deviceId:context.deviceId,executorId:context.executorId,
    scopes:['files:read','files:write'],expiresAt:Date.now()/1000+120,revision:'v1',broadUserAuthority:true,sessionIds:[1]}];
   const gate=new PolicyGate(authority,audit,async()=>grants);
   let facade:HostDeckFacade,revokeInside=false;
   const adapter=await FileAdapter.create({workspace,providers,everything,reauthorize:(name,args)=>facade.reauthorize(name,args)});
   facade=new HostDeckFacade({deviceId:context.deviceId,executorId:context.executorId,gate,adapters:[adapter],
    checkExecutor:async()=>{if(revokeInside){revokeInside=false;grants=grants.map(g=>({...g,scopes:['files:read'],revision:'v2'}));}}});
   const name='hostdeck_set_provider_enabled',args={device_id:context.deviceId,provider:'everything',enabled:false};
   assert.equal((await gate.visible(reader,context.deviceId,context.executorId)).has(name),false);
   assert.equal((await gate.visible(principal,context.deviceId,context.executorId)).has(name),true);
   await assert.rejects(facade.call(reader,name,args),/DENIED/);
   revokeInside=true;await assert.rejects(facade.call(principal,name,args),/DENIED/);
   const status=await facade.call(reader,'hostdeck_list_providers',{device_id:context.deviceId}) as any;
   assert.equal(status.providers.find((p:any)=>p.id==='everything').desiredEnabled,true,'revoked setter had no write effect');
   grants=grants.map(g=>({...g,scopes:['files:read','files:write'],revision:'v3'}));
   await facade.call(principal,name,args);
   const before=queries();
   await assert.rejects(facade.call(reader,'hostdeck_search_files',{device_id:context.deviceId,path:'.',pattern:'owned',provider:'everything'}),/PROVIDER_DISABLED/);
   assert.equal(queries(),before);
   await facade.call(principal,name,{...args,enabled:null});
   const started=await facade.call(reader,'hostdeck_search_files',{device_id:context.deviceId,path:'.',pattern:'owned',provider:'everything'}) as any;
   let result:any;
   for(let n=0;n<100;n++){result=await facade.call(reader,'hostdeck_search_results',{device_id:context.deviceId,search_id:started.search_id});if(result.complete)break;await new Promise(r=>setTimeout(r,5));}
   assert.equal(result.total_results,1);
   grants=grants.map(g=>({...g,sessionIds:[]}));
   await assert.rejects(facade.call(reader,'hostdeck_search_results',{device_id:context.deviceId,search_id:started.search_id}),/EVERYTHING_WRONG_SESSION|DENIED/);
   grants=[];
   await assert.rejects(facade.call(reader,'hostdeck_list_providers',{device_id:context.deviceId}),/DENIED/);
  }finally{audit.close();}
 });
});
