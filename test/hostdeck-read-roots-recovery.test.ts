import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FileAdapter} from '../src/hostdeck/files.js';
import {UserRuntime} from '../src/hostdeck/user-runtime.js';
import {ReadRootAccess} from '../src/hostdeck/read-root-access.js';
import {ReadRootSelectionStore} from '../src/hostdeck/read-root-selection-store.js';

const owner={ownerId:'fixture_owner',deviceId:'fixture_device',
  executorId:'fixture_executor',revision:'grant_revision',sessionId:1,sessionIds:[1]};
const sid='S-1-5-21-1000';
type Config={version:1;device_id:string;executor_id:string;
  expected_user_sid:string;workspace:string;read_roots?:{
    owner_id:string;revision:string;roots:string[];excluded_roots:string[];
    fixed_volume_roots:string[]}};
const code=(e:unknown)=>e instanceof Error?e.message:String(e);

async function fixture(){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hostdeck-read-root-recovery-')));
  const workspace=path.join(root,'workspace'),external=path.join(root,'external');
  const separate=path.join(root,'separate'),protectedDir=path.join(root,'protected');
  await Promise.all([workspace,external,separate,protectedDir].map(p=>fs.mkdir(p)));
  const configFile=path.join(protectedDir,'hostdeck.json');
  const source=path.join(external,'owned.txt');
  const excluded=path.join(external,'excluded');
  const futureExcluded=path.join(external,'future-protected');
  await fs.mkdir(excluded);
  await fs.writeFile(path.join(workspace,'local.txt'),'LOCAL_FIXTURE');
  await fs.writeFile(source,'VISIBLE_MARKER');
  await fs.writeFile(path.join(excluded,'private.txt'),'EXCLUDED_MARKER');
  await fs.writeFile(path.join(separate,'other.txt'),'OTHER_MARKER');
  let nativeAttribute:'ok'|'hidden'|'system'|'reparse'='ok';
  let forceHandleMismatch=false;
  const calls:string[]=[];
  const native={
    probeProtectedObjectAcl:async(_file:string)=>({
      verified:true as const,status:'verified' as const,
      code:'FULLTEXT_NATIVE_ACL_VERIFIED' as const,
      componentsChecked:3,scope:'physical_filesystem_snapshot_only' as const,
    }),
    attributes:async(paths:readonly string[],_authorize:unknown)=>{
      return paths.map((_,index)=>({
        index,status:nativeAttribute==='reparse'?'reparse_component' as const:'ok' as const,
        hidden:nativeAttribute==='hidden',system:nativeAttribute==='system',
        reparse:nativeAttribute==='reparse',
        hidden_component:nativeAttribute==='hidden',
        system_component:nativeAttribute==='system',directory:null,
      }));
    },
    directoryPage:async(target:string, expected:bigint, offset:number,limit:number,_authorize:unknown)=>{
      const stat=await fs.stat(target,{bigint:true});
      if(forceHandleMismatch||stat.ino!==expected)throw Error('FULLTEXT_NATIVE_DIRECTORY_CHANGED');
      const names=(await fs.readdir(target)).slice(offset,offset+limit);
      const size=(await fs.readdir(target)).length;
      return {names,more:offset+names.length<size,nextOffset:offset+names.length};
    },
  };
  const config:Config={version:1,device_id:owner.deviceId,
    executor_id:owner.executorId,expected_user_sid:sid,workspace,
    read_roots:{owner_id:owner.ownerId,revision:'read_config_rev_1',roots:[external],
      excluded_roots:[excluded],fixed_volume_roots:[]}};
  const writeConfig=async()=>fs.writeFile(configFile,JSON.stringify(config));
  await writeConfig();
  const store=new ReadRootSelectionStore(configFile,workspace,{
    deviceId:owner.deviceId,executorId:owner.executorId,sid,sessionId:1,
  },native);
  const access=new ReadRootAccess(workspace,[protectedDir,futureExcluded],store,native);
  const adapter=await FileAdapter.create({workspace,readRoots:access,
    reauthorize:async(name)=>{calls.push(name);}});
  const runtime=await UserRuntime.create({deviceId:owner.deviceId,workspace,
    authorize:async()=>true,environment:{},shells:{},readRoots:access});
  return {root,workspace,external,separate,protectedDir,source,excluded,futureExcluded,
    config,configFile,writeConfig,store,access,adapter,runtime,native,calls,
    setNativeAttribute:(v:typeof nativeAttribute)=>{nativeAttribute=v;},
    forceMismatch:(v:boolean)=>{forceHandleMismatch=v;},
    cleanup:async()=>{await runtime.dispose();await fs.rm(root,{recursive:true,force:true});}};
}
function args(p:string){return {device_id:owner.deviceId,path:p};}
async function finish(adapter:FileAdapter,id:string,context=owner){
  for(let i=0;i<150;i++){
    const r=await adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:id,offset:0,limit:100,
    },context) as any;
    if(r.complete)return r;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('fixture search did not complete');
}

test('unconfigured or unqualified config remains workspace-only',async()=>{
  const f=await fixture();
  try {
    const before=await f.runtime.invoke('hostdeck_read_file',args('local.txt'),owner);
    assert.equal(before.content,'LOCAL_FIXTURE');
    delete f.config.read_roots;await f.writeConfig();
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),owner),
      /READ_ROOT_DENIED/);
    await assert.rejects(f.adapter.handle('hostdeck_list_directory',{
      ...args(f.external),depth:1,limit:50},owner),/READ_ROOT_DENIED/);
    f.config.read_roots={owner_id:owner.ownerId,revision:'read_config_rev_2',roots:[f.external],
      excluded_roots:[f.excluded],fixed_volume_roots:[]};
    await f.writeConfig();
    const noNative=new ReadRootAccess(f.workspace,[f.protectedDir],
      new ReadRootSelectionStore(f.configFile,f.workspace,{
        deviceId:owner.deviceId,executorId:owner.executorId,sid,sessionId:1,
      }));
    await assert.rejects(noNative.resolve(f.source,owner,'read_file'),
      /READ_ROOT_DENIED/);
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args('local.txt'),owner)).content,
      'LOCAL_FIXTURE');
  }finally{await f.cleanup();}
});

test('external read/list/direct name/content work only inside the selected root',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args(f.source),owner)).content,
      'VISIBLE_MARKER');
    const info=await f.runtime.invoke('hostdeck_file_info',
      {...args(f.source),hash:'sha256'},owner);
    assert.equal(info.type,'file');
    assert.equal(info.root_scope,f.external);
    assert.match(String(info.sha256),/^[0-9a-f]{64}$/);
    const list=await f.adapter.handle('hostdeck_list_directory',{
      ...args(f.external),depth:2,limit:50},owner) as any;
    assert.equal(list.root_scope,f.external);
    assert.deepEqual(list.entries.map((item:any)=>item.path),[f.source]);
    assert.ok(f.calls.filter(name=>name==='hostdeck_list_directory').length>=2);
    for(const [mode,pattern] of [['files','owned'],['content','VISIBLE_MARKER']] as const){
      const start=await f.adapter.handle('hostdeck_search_files',{
        ...args(f.external),pattern,mode,provider:'direct'},owner) as any;
      const result=await finish(f.adapter,start.search_id);
      assert.equal(result.total_results,1);
      assert.deepEqual(result.items.map((item:any)=>item.path),[f.source]);
      if(mode==='content')assert.match(result.items[0].text,/VISIBLE_MARKER/);
    }
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',
      args(path.join(f.separate,'other.txt')),owner),/READ_ROOT_DENIED/);
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',
      args(path.join(f.excluded,'private.txt')),owner),/READ_ROOT_DENIED/);
    await assert.rejects(f.runtime.invoke('hostdeck_write_file',{
      ...args(f.source),content:'MUTATION_DENIED',mode:'overwrite'},owner),/PATH_DENIED/);
    assert.equal(await fs.readFile(f.source,'utf8'),'VISIBLE_MARKER');
  }finally{await f.cleanup();}
});

test('absent protected exclusion retains protection after creation, while siblings remain readable',async()=>{
  const f=await fixture();
  try {
    await f.access.resolve(f.source,owner,'read_file');
    await fs.mkdir(f.futureExcluded);
    const secret=path.join(f.futureExcluded,'secret.txt');
    await fs.writeFile(secret,'DO_NOT_DISCLOSE');
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(secret),owner),
      /READ_ROOT_DENIED/);
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args(f.source),owner)).content,
      'VISIBLE_MARKER');
  }finally{await f.cleanup();}
});

test('grant/session changes, config revision and revocation invalidate old pages and reads',async()=>{
  const f=await fixture();
  try{
    const started=await f.adapter.handle('hostdeck_search_files',{
      ...args(f.external),pattern:'owned',provider:'direct'},owner) as any;
    assert.equal((await finish(f.adapter,started.search_id)).total_results,1);
    for(const foreign of [{...owner,ownerId:'other'}, {...owner,revision:'other'},
      {...owner,sessionIds:[2]}, {...owner,executorId:'other'}]){
      await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),foreign),
        /READ_ROOT_DENIED/);
      await assert.rejects(f.adapter.handle('hostdeck_search_results',{
        device_id:owner.deviceId,search_id:started.search_id,offset:0,limit:10},foreign));
    }
    f.config.read_roots!.revision='read_config_rev_2';await f.writeConfig();
    await assert.rejects(f.adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:started.search_id,offset:0,limit:10},owner),
      /READ_ROOT_DENIED/);
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args(f.source),owner)).content,
      'VISIBLE_MARKER');
    delete f.config.read_roots;await f.writeConfig();
    await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),owner),
      /READ_ROOT_DENIED/);
    assert.equal((await f.runtime.invoke('hostdeck_read_file',args('local.txt'),owner)).content,
      'LOCAL_FIXTURE');
  }finally{await f.cleanup();}
});

test('native Hidden/System/reparse and mismatched directory handle always refuse',async()=>{
  const f=await fixture();
  try{
    for(const attr of ['hidden','system','reparse'] as const){
      f.setNativeAttribute(attr);
      await assert.rejects(f.runtime.invoke('hostdeck_read_file',args(f.source),owner),
        /READ_ROOT_DENIED/);
      await assert.rejects(f.adapter.handle('hostdeck_list_directory',{
        ...args(f.external),depth:1,limit:10},owner),/READ_ROOT_DENIED/);
    }
    f.setNativeAttribute('ok');
    f.forceMismatch(true);
    await assert.rejects(f.adapter.handle('hostdeck_list_directory',{
      ...args(f.external),depth:1,limit:10},owner),/READ_ROOT_CHANGED/);
    f.forceMismatch(false);
    const result=await f.adapter.handle('hostdeck_list_directory',{
      ...args(f.external),depth:1,limit:10},owner) as any;
    assert.equal(result.entries.length,1);
  }finally{await f.cleanup();}
});

test('replaced retained match suppresses both snippet and stale match count',async()=>{
  const f=await fixture();
  try{
    const start=await f.adapter.handle('hostdeck_search_files',{
      ...args(f.external),pattern:'VISIBLE_MARKER',mode:'content',provider:'direct'},owner) as any;
    const first=await finish(f.adapter,start.search_id);
    assert.equal(first.total_results,1);
    await fs.rename(f.source,path.join(f.external,'old.txt'));
    await fs.writeFile(f.source,'REPLACED_BODY');
    const next=await f.adapter.handle('hostdeck_search_results',{
      device_id:owner.deviceId,search_id:start.search_id,offset:0,limit:10},owner) as any;
    assert.deepEqual(next.items,[]);
    assert.equal(next.total_results,0);
  }finally{await f.cleanup();}
});
