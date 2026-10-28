import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {FileAdapter} from '../src/hostdeck/files.js';
import {EverythingClient} from '../src/hostdeck/everything.js';

test('Everything sends a necessary name predicate before the provider cap; Node still checks each authorized hit', async () => {
  const parent=await realpath(await mkdtemp(path.join(os.tmpdir(),'hostdeck-query-filter-')));
  const workspace=path.join(parent,'allowed');await mkdir(workspace);
  const context={ownerId:'own-fixture',deviceId:'synthetic-device',executorId:'synthetic-executor',sessionIds:[1]};
  const names=['CAFÉ.txt','cafe\u0301.txt','中文.txt','[report]!.txt','report9.txt','plus+file.txt','draft(1).txt','ordinary.txt'];
  const candidates=names.map(name=>path.join(workspace,name));
  for(const file of candidates)await writeFile(file,'owned');
  const forbidden=path.join(parent,'excluded.txt');await writeFile(forbidden,'private');
  const requests:Array<{root:string;workspace:string;needle:string}>=[];
  // Simulate a >100001-name root where a root-only IPC offset-0 window
  // would miss the needle. No large corpus, actual Everything or drive read.
  const everything={sessionId:1,status:async()=>({reason:'ready'}),
    query:async(root:string,_timeout:number,_signal:AbortSignal,filter?:{workspace:string;needle:string})=>{
      if(!filter)return {paths:[],truncated:true,version:'fixture',instance:'',session_id:1,runtime_id:'fixture'};
      requests.push({root,workspace:filter.workspace,needle:filter.needle});
      const paths=candidates.filter(p=>p.toLocaleLowerCase('en').includes(filter.needle.toLocaleLowerCase('en')));
      return {paths:[forbidden,...paths],truncated:filter.needle==='bulk',version:'fixture',instance:'',session_id:1,runtime_id:'fixture'};
    }};
  const adapter=await FileAdapter.create({workspace,everything:everything as any,reauthorize:async()=>{}});
  const call=(name:string,args:Record<string,unknown>)=>adapter.handle('hostdeck_'+name,{device_id:context.deviceId,...args},context) as Promise<any>;
  const query=async(pattern:string,literal=true)=>{
    const start=await call('search_files',{path:'.',pattern,provider:'everything',literal,metadata:true,sort:'path'});
    for(let i=0;i<100;i++){
      const page=await call('search_results',{search_id:start.search_id});
      if(page.complete)return page;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw Error('synthetic Everything query did not finish');
  };
  try {
    const accent=await query('café');
    assert.equal(accent.state,'complete');
    assert.deepEqual(accent.items.map((r:any)=>r.path),['CAFÉ.txt']);
    assert.equal(accent.total_results,1);
    assert.equal(accent.items[0].metadata_source,'filesystem_readback');
    assert.ok(accent.items[0].size===5&&accent.items[0].modified);

    assert.deepEqual((await query('cafe\u0301')).items.map((r:any)=>r.path),['cafe\u0301.txt']);
    assert.deepEqual((await query('中文')).items.map((r:any)=>r.path),['中文.txt']);
    assert.deepEqual((await query('[report]!')).items.map((r:any)=>r.path),['[report]!.txt']);
    assert.deepEqual((await query('plus+file')).items.map((r:any)=>r.path),['plus+file.txt']);
    assert.deepEqual((await query('draft(1)')).items.map((r:any)=>r.path),['draft(1).txt']);
    // The native mandatory "report" fragment can over-include the bracket
    // filename; the existing Node regexp remains the final semantic check.
    assert.deepEqual((await query('^report\\d\\.txt$',false)).items.map((r:any)=>r.path),['report9.txt']);
    assert.deepEqual((await query('^\\u4e2d\\u6587',false)).items.map((r:any)=>r.path),['中文.txt']);
    assert.deepEqual((await query('ext:txt')).items,[]);
    const partial=await query('bulk');assert.equal(partial.state,'partial');
    assert.equal(partial.truncated,true);assert.equal(partial.total_results,0);

    assert.deepEqual(requests.map(r=>r.needle),
      ['café','cafe\u0301','中文','[report]!','plus+file','draft(1)','report','中文','ext:txt','bulk']);
    assert.ok(requests.every(r=>r.root===workspace&&r.workspace===workspace));
    assert.equal(JSON.stringify(accent).includes('excluded.txt'),false);

    const count=requests.length;
    await assert.rejects(query('(report)+',false),/SEARCH_REGEX_FEATURE_DENIED/);
    await assert.rejects(query('report|other',false),/SEARCH_REGEX_FEATURE_DENIED/);
    await assert.rejects(query('^\\d$',false),/EVERYTHING_QUERY_SEMANTICS_UNSUPPORTED/);
    await assert.rejects(query('[0-9]',false),/EVERYTHING_QUERY_SEMANTICS_UNSUPPORTED/);
    await assert.rejects(query('\\s',false),/EVERYTHING_QUERY_SEMANTICS_UNSUPPORTED/);
    await assert.rejects(query('[',false),/SEARCH_PATTERN_INVALID/);
    assert.equal(requests.length,count,'invalid or unsupported regex never starts a vendor query');
  } finally {await rm(parent,{recursive:true,force:true});}
});

test('Everything client sends filtered query in the existing owned IPC envelope',async()=>{
  const child=new EventEmitter() as any;
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
  let sent='';
  child.stdin.on('data',(chunk:Buffer)=>{sent+=chunk.toString('utf8');});
  child.stdin.on('finish',()=>{
    child.stdout.write(JSON.stringify({result:{
      paths:[],truncated:false,version:'fixture',instance:'',session_id:1,runtime_id:'fixture'
    }}));
    child.emit('close',0);
  });
  const patched=mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
  try {
    const client=new EverythingClient({worker:'fixture-worker',executable:'fixture-exe',sha256:'a'.repeat(64),
      version:'fixture',instance:'',identity:{session_id:1,sid:'fixture-sid',logon_id:'fixture-logon'} as any});
    const filter={workspace:'C:\\fixture-workspace',needle:'é 中文 [report]! ext:txt'};
    const result=await client.query('C:\\fixture-workspace\\owned',1000,new AbortController().signal,filter);
    assert.deepEqual(result.paths,[]);
    const request=JSON.parse(sent);
    assert.deepEqual({operation:request.operation,root:request.root,workspace:request.workspace,
      name_filter:request.name_filter,timeout_ms:request.timeout_ms},
      {operation:'query',root:'C:\\fixture-workspace\\owned',workspace:filter.workspace,
        name_filter:filter.needle,timeout_ms:1000});
    assert.equal(request.session_id,1);assert.equal(request.sid,'fixture-sid');
    assert.equal(request.logon_id,'fixture-logon');assert.equal(request.instance,'');
    assert.equal(request.sha256,'a'.repeat(64));
  }finally{
    patched.mock.restore();syncBuiltinESMExports();
    child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();
  }
});

test('pinned native IPC2 source applies escaped predicate ahead of the unchanged cap',async()=>{
  // Static wire/source assertion only: a real Windows IPC2 engine is not run.
  const source=await readFile(path.resolve('windows/HostDeck.DesktopWorker/EverythingIpc.cs'),'utf8');
  assert.match(source,/IpcMatchPath = 0x04, IpcRegex = 0x08/);
  assert.match(source,/Put\(8, IpcMatchPath \| IpcRegex\); Put\(12, 0\); Put\(16, MaxItems\)/);
  assert.match(source,/var query = FilteredRootExpression\(root, workspace, needle\);/);
  assert.match(source,/var workspacePrefix = RootExpression\(workspace\);/);
  assert.match(source,/var rootPrefix = RootExpression\(root\);/);
  assert.ok(source.includes(String.raw`@"[\s\S]*"`));
  assert.match(source,/Regex\.Escape\(needle\)/);
  assert.match(source,/truncated = total > count/);
});
