import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {ProviderRegistry} from '../src/hostdeck/providers.js';
import {FileAdapter} from '../src/hostdeck/files.js';

const c={ownerId:'owner-a',deviceId:'device-a',executorId:'executor-a'};
async function fixture(run:(registry:ProviderRegistry,file:string,root:string)=>Promise<void>){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hostdeck-provider-receipts-')));
 try{const file=path.join(root,'preferences.sqlite');await run(await ProviderRegistry.open(file),file,root);}
 finally{assert.equal(path.dirname(root),await realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('hostdeck-provider-receipts-'));await rm(root,{recursive:true,force:true});}
}

test('provider receipts persist with scoped values and revisions across reopen',async()=>fixture(async(r,file)=>{
 const first=await r.set(c,'files.name','everything',0);
 assert.ok(first?.id,'setting acknowledgement must include a durable receipt');
 assert.equal(first.kind,'preference');assert.equal(first.target,'files.name');
 assert.equal(first.before,null);assert.equal(first.after,'everything');assert.equal(first.revision,1);
 const reopened=await ProviderRegistry.open(file),view=await reopened.snapshot(c);
 assert.equal(view.preferences[0].provider,'everything');assert.equal(view.preferences[0].revision,1);
 assert.equal(view.changes[0].id,first.id);
 for(const other of [{...c,ownerId:'other'},{...c,deviceId:'other'},{...c,executorId:'other'}]){
  const v=await reopened.snapshot(other);assert.deepEqual(v.changes,[]);assert.equal(v.preferences[0].provider,null);
 }
 const enabled=await reopened.setEnabled(c,'everything',false,0);
 assert.equal(enabled.before,null);assert.equal(enabled.after,false);assert.equal(enabled.revision,1);
 assert.equal((await reopened.snapshot(c)).preferences[0].revision,1,'independent target revisions');
}));

test('compare-and-set rejects ABA and safely restores a still-current receipt',async()=>fixture(async(r)=>{
 const first=await r.set(c,'files.name','everything',0);
 await r.set(c,'files.name','direct',1);await r.set(c,'files.name','everything',2);
 await assert.rejects(r.set(c,'files.name',first.before,first.revision),/PROVIDER_CONFLICT/);
 assert.equal(await r.preference(c,'files.name'),'everything');
 const restored=await r.set(c,'files.name',null,3);assert.equal(restored.revision,4);
 const unchanged=await r.set(c,'files.name',null,4);
 assert.equal(unchanged.changed,false);assert.equal(unchanged.revision,4);
 assert.notEqual(unchanged.id,restored.id,'no-op acknowledgement remains its own receipt');
}));

test('a failed durable receipt insertion rolls back the setting and revision together',async()=>fixture(async(r,file)=>{
 const db=new DatabaseSync(file);
 db.exec("CREATE TRIGGER reject_change BEFORE INSERT ON provider_changes BEGIN SELECT RAISE(FAIL,'fixture receipt failure'); END");db.close();
 await assert.rejects(r.set(c,'files.name','everything',0));
 const view=await r.snapshot(c);assert.equal(view.preferences[0].provider,null);
 assert.equal(view.preferences[0].revision,0);assert.deepEqual(view.changes,[]);
}));

test('separate native Node processes cannot both commit the same expected revision', {timeout:30_000},async()=>fixture(async(r,file,root)=>{
 const worker=path.join(root,'race.mjs');
 await writeFile(worker,`import{ProviderRegistry}from ${JSON.stringify(pathToFileURL(path.resolve('src/hostdeck/providers.ts')).href)};
 import fs from'node:fs/promises';const[file,ready,go,provider]=process.argv.slice(2);
 const r=await ProviderRegistry.open(file);await fs.writeFile(ready,'ready');
 const deadline=Date.now()+8000;while(true){try{await fs.access(go);break}catch{if(Date.now()>deadline)throw Error('fixture barrier');await new Promise(r=>setTimeout(r,10))}}
 try{const v=await r.set(${JSON.stringify(c)},'files.name',provider,0);console.log(JSON.stringify({ok:true,revision:v.revision}))}
 catch(e){console.log(JSON.stringify({ok:false,code:e.code}))}`);
 const go=path.join(root,'go');const ready=[path.join(root,'a.ready'),path.join(root,'b.ready')];
 const run=promisify(execFile);
 const jobs=['everything','direct'].map((provider,i)=>run(process.execPath,['--import','tsx',worker,file,ready[i],go,provider],{cwd:process.cwd(),timeout:15_000,windowsHide:true}));
 const deadline=Date.now()+10_000;
 while(true){const seen=await Promise.all(ready.map(f=>realpath(f).then(()=>true,()=>false)));if(seen.every(Boolean))break;if(Date.now()>deadline)throw Error('fixture readiness timeout');await new Promise(resolve=>setTimeout(resolve,10));}
 await writeFile(go,'go');const results=(await Promise.all(jobs)).map(x=>JSON.parse(x.stdout.trim()));
 assert.equal(results.filter(x=>x.ok).length,1);assert.equal(results.find(x=>!x.ok)?.code,'PROVIDER_CONFLICT');
 assert.equal((await r.snapshot(c)).changes.length,1);
}));

test('history retention is bounded without resetting monotonic target revisions',async()=>fixture(async(r,file)=>{
 await r.set({...c,ownerId:'owner-b'},'files.name','everything',0);
 for(let i=0;i<205;i++)await r.set(c,'files.name',i%2?'direct':'everything',i);
 const reopened=await ProviderRegistry.open(file),view=await reopened.snapshot(c);
 assert.equal(view.preferences[0].revision,205);assert.equal(view.changes.length,20);
 const db=new DatabaseSync(file);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_changes WHERE owner=?').get(c.ownerId)!.n,200);db.close();
 assert.equal((await reopened.snapshot({...c,ownerId:'owner-b'})).changes.length,1,'pruning must preserve other owners');
 await assert.rejects(reopened.set(c,'files.name',null,0),/PROVIDER_CONFLICT/);
}));

test('legacy preferences migrate unchanged; invalid preconditions never add receipts',async()=>fixture(async(r,_file,root)=>{
 const file=path.join(root,'legacy.sqlite'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE preferences(owner TEXT NOT NULL,device TEXT NOT NULL,executor TEXT NOT NULL,capability TEXT NOT NULL,provider TEXT NOT NULL,PRIMARY KEY(owner,device,executor,capability))');
 db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?)').run(c.ownerId,c.deviceId,c.executorId,'files.name','everything');db.close();
 r=await ProviderRegistry.open(file);const legacy=await r.snapshot(c);
 assert.equal(legacy.preferences[0].provider,'everything');assert.equal(legacy.preferences[0].revision,0);assert.deepEqual(legacy.changes,[]);
 for(const revision of [-1,0.5,Infinity,'0'])await assert.rejects(r.set(c,'files.name',null,revision as any),/PROVIDER_CONFIGURATION_INVALID/);
 await assert.rejects(r.setEnabled(c,'direct',false,0),/PROVIDER_IMMUTABLE/);
 assert.deepEqual((await r.snapshot(c)).changes,[]);
 const first=await r.set(c,'files.name',null,0);assert.equal(first.before,'everything');assert.equal(first.revision,1);
}));

test('legacy-writer changes invalidate old receipt revisions across rollback and rollforward',async()=>fixture(async(r,file)=>{
 const receipt=await r.set(c,'files.name','everything',0);
 const db=new DatabaseSync(file);
 const write=db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?) ON CONFLICT(owner,device,executor,capability) DO UPDATE SET provider=excluded.provider');
 write.run(c.ownerId,c.deviceId,c.executorId,'files.name','direct');
 write.run(c.ownerId,c.deviceId,c.executorId,'files.name','everything');db.close();
 const reopened=await ProviderRegistry.open(file),view=await reopened.snapshot(c);
 assert.equal(view.preferences[0].revision,3);assert.equal(view.changes.length,1,'legacy writers have no invented API receipts');
 await assert.rejects(reopened.set(c,'files.name',receipt.before,receipt.revision),/PROVIDER_CONFLICT/);
 assert.equal(await reopened.preference(c,'files.name'),'everything');
}));

test('actual file adapter exposes durable receipts and rechecks authorization before mutation',async()=>fixture(async(providers,_file,root)=>{
 const workspace=path.join(root,'workspace');await mkdir(workspace);let allowed=true;
 const adapter=await FileAdapter.create({workspace,providers,reauthorize:async()=>{if(!allowed)throw Error('DENIED');}});
 const call=(name:string,args:any={})=>adapter.handle('hostdeck_'+name,{device_id:c.deviceId,...args},c);
 const changed:any=await call('set_provider_preference',{capability:'files.name',provider:'everything',expected_revision:0});
 assert.equal(changed.change.revision,1);
 const compact:any=await call('list_providers');assert.equal(compact.changes,undefined,'ordinary status never includes unsolicited history');
 const view:any=await call('list_providers',{include_changes:true});assert.equal(view.functions[0].revision,1);assert.equal(view.changes[0].id,changed.change.id);
 await assert.rejects(call('set_provider_preference',{capability:'files.name',provider:'direct',expected_revision:0}),/PROVIDER_CONFLICT/);
 allowed=false;await assert.rejects(call('set_provider_enabled',{provider:'everything',enabled:false,expected_revision:0}),/DENIED/);
 assert.equal((await providers.snapshot(c)).changes.length,1);
}));
