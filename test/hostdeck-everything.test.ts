import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,mkdir,rm,rename,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {EverythingClient} from '../src/hostdeck/everything.js';
import {inspectDesktopIdentity} from '../src/hostdeck/desktop.js';
import {FileAdapter} from '../src/hostdeck/files.js';
import {ProviderRegistry} from '../src/hostdeck/providers.js';

test('native Everything discovery distinguishes no query app and rejects a wrong Windows session',async t=>{
 const worker=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
 if(process.platform!=='win32'||!existsSync(worker)){t.skip('Windows native worker required');return}
 const identity=await inspectDesktopIdentity(worker);
 const executable=process.env.HOSTDECK_TEST_EVERYTHING_EXECUTABLE;
 if(!executable){t.skip('exact Everything installation must be supplied');return}
 const sha256=createHash('sha256').update(await readFile(executable)).digest('hex');
 const client=new EverythingClient({worker,executable:executable.replaceAll('\\','/'),sha256,version:'1.5.0.1423b',instance:'',identity});
 const status=await client.status();
 assert.equal(status.installed,true);
 assert.equal(status.enabled,true);
 assert.equal(typeof status.running,'boolean');
 assert.ok(['ready','not_running','loading'].includes(status.reason));
 const wrong=new EverythingClient({worker,executable,sha256,version:'1.5.0.1423b',instance:'',identity:{...identity,session_id:identity.session_id+1}});
 await assert.rejects(wrong.status(),/EVERYTHING_WRONG_SESSION/);
 const altered=new EverythingClient({worker,executable,sha256:'0'.repeat(64),version:'1.5.0.1423b',instance:'',identity});
 await assert.rejects(altered.status(),/EVERYTHING_BINARY_CHANGED/);
});

test('real Everything IPC finds and refreshes an exact authorized Unicode corpus through HostDeck',async t=>{
 const executable=process.env.HOSTDECK_TEST_EVERYTHING_EXECUTABLE,fixtureRoot=process.env.HOSTDECK_TEST_SEARCH_ROOT;
 if(!executable||!fixtureRoot){t.skip('explicit existing installation and authorized indexed fixture root required');return}
 const worker=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
 const identity=await inspectDesktopIdentity(worker);
 const sha256=createHash('sha256').update(await readFile(executable)).digest('hex');
 const client=new EverythingClient({worker,executable,sha256,version:'1.5.0.1423b',instance:'',identity});
 assert.equal((await client.status()).reason,'ready');
 const parent=await realpath(await mkdtemp(path.join(fixtureRoot,'hostdeck-everything-')));
 const workspace=path.join(parent,'allowed');await mkdir(workspace);
 const names=['België 中文.txt',"apostrophe's.txt",'café.txt','cafe\u0301.txt','[brackets].txt'];
 for(const n of names)await writeFile(path.join(workspace,n),'Everything own é 中文 🙂');
 await mkdir(path.join(workspace,'nested'));await writeFile(path.join(workspace,'nested',names[0]),'collision');
 await mkdir(path.join(workspace,'folder'));await writeFile(path.join(parent,'excluded.txt'),'excluded');
 const registry=await ProviderRegistry.open(path.join(parent,'preferences.sqlite'));
 const adapter=await FileAdapter.create({workspace,providers:registry,everything:client,reauthorize:async()=>{}});
 const context={ownerId:'own-everything-test',deviceId:'test-device',executorId:'test-executor',sessionIds:[identity.session_id]};
 const call=(suffix:string,args:Record<string,unknown>={})=>adapter.handle('hostdeck_'+suffix,{device_id:context.deviceId,...args},context) as Promise<any>;
 const query=async(pattern:string,extra:Record<string,unknown>={})=>{
  const start=await call('search_files',{path:'.',pattern,provider:'everything',sort:'path',metadata:true,...extra});
  for(let n=0;n<200;n++){
   const result=await call('search_results',{search_id:start.search_id});
   if(result.complete){assert.equal(result.state,'complete',JSON.stringify(result));return result;}
   await new Promise(r=>setTimeout(r,10));
  }
  throw Error('bounded fixture query did not finish');
 };
 const eventually=async(pattern:string,expected:string[])=>{
  const deadline=Date.now()+8000;let result:any;
  do{result=await query(pattern);if(JSON.stringify(result.items.map((x:any)=>x.path).sort())===JSON.stringify(expected.slice().sort()))return result;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  assert.deepEqual(result.items.map((x:any)=>x.path).sort(),expected.slice().sort());
 };
 try{
  const expected=[...names,path.join('nested',names[0])];
  const hits=await eventually('.txt',expected);
  assert.equal(hits.provider,'everything');assert.match(hits.provenance.runtime_id,/^\d+:\d+$/);
  assert.equal(hits.provenance.version,'1.5.0.1423b');
  assert.equal(hits.total_results,expected.length);assert.equal(JSON.stringify(hits).includes('excluded.txt'),false);
  for(const hit of hits.items){const actual=await stat(path.join(workspace,hit.path));assert.equal(hit.size,actual.size);assert.equal(hit.modified,actual.mtime.toISOString());}
  assert.equal(await readFile(path.join(workspace,names[0]),'utf8'),'Everything own é 中文 🙂');
  const page=await call('search_results',{search_id:hits.search_id,offset:0,limit:2});
  const tail=await call('search_results',{search_id:hits.search_id,offset:2,limit:100});
  assert.deepEqual([...page.items,...tail.items],hits.items);
  assert.deepEqual((await query('ext:txt')).items,[]);
  assert.deepEqual((await query('cafe\u0301')).items.map((x:any)=>x.path),['cafe\u0301.txt']);
  const folders=await query('folder',{entry_type:'directories'});assert.deepEqual(folders.items.map((x:any)=>x.path),['folder']);
  await rename(path.join(workspace,names[0]),path.join(workspace,'renamed.txt'));
  await eventually('renamed.txt',['renamed.txt']);
  await writeFile(path.join(workspace,'renamed.txt'),'changed');assert.equal((await query('renamed.txt')).items[0].size,7);
  await rm(path.join(workspace,'renamed.txt'));await eventually('renamed.txt',[]);
  await call('set_provider_preference',{capability:'files.name',provider:'everything'});
  assert.equal(await registry.select(context,'files.name'),'everything');
  const abort=new AbortController();abort.abort();await assert.rejects(client.query(workspace,1000,abort.signal),/EVERYTHING_CANCELLED/);
 }finally{
  // Only this uniquely created fixture tree; root is resolved within the supplied fixture location.
  const relative=path.relative(await realpath(fixtureRoot),parent);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  await rm(parent,{recursive:true,force:false});assert.equal(existsSync(parent),false);
 }
});
