import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {FullTextNativeBridge} from '../src/hostdeck/fulltext-native-bridge.js';
import {inspectDesktopIdentity} from '../src/hostdeck/desktop.js';
import {ReadRootAccess,type ReadRootScope} from '../src/hostdeck/read-root-access.js';
import type {ProtectedReadRootSelection} from '../src/hostdeck/read-root-boundary.js';

const execFile=promisify(execFileCallback);
const parent=process.env.HOSTDECK_TEST_SEARCH_ROOT;
const worker=process.env.HOSTDECK_TEST_FULLTEXT_NATIVE_WORKER??
  path.resolve('windows/HostDeck.DesktopWorker/bin/Release/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');

test('real Windows subroot reads bind native FileID and block ancestor replacement, Hidden/System and junctions',{
  skip:process.platform!=='win32'||!parent||!existsSync(worker)
    ? 'Explicit owned fixture parent and current Windows worker required' : false,
  timeout:40_000,
},async()=>{
  const canonicalParent=await fs.realpath(parent!);
  const base=await fs.realpath(await fs.mkdtemp(path.join(canonicalParent,'hostdeck-read-native-')));
  const local=path.join(base,'workspace'),external=path.join(base,'external'),
    protectedRoot=path.join(base,'protected'),outside=path.join(base,'outside'),backup=path.join(base,'external-backup');
  const file=path.join(external,'owned-é-中文.txt');
  let bridge:FullTextNativeBridge|undefined,pin:Awaited<ReturnType<FullTextNativeBridge['pinFile']>>|undefined;
  let moved=false,junction=false;
  // Only the owner/root selection is synthetic. Attributes, native handles,
  // Win32 FileIDs, Node descriptors and bytes are actual Windows observations.
  async function setAttributes(attributes:number):Promise<void>{
    const payload=Buffer.from(JSON.stringify({file,attributes}),'utf8').toString('base64');
    const command="$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+payload+"'))|ConvertFrom-Json; [IO.File]::SetAttributes($data.file,[IO.FileAttributes]$data.attributes)";
    await execFile(path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile','-NonInteractive','-Command',command],{shell:false,windowsHide:true,timeout:5000,maxBuffer:8192});
  }
  try{
    for(const dir of [local,external,protectedRoot,outside])await fs.mkdir(dir);
    await fs.writeFile(file,'OWN NATIVE MARKER');
    await fs.writeFile(path.join(outside,'owned-é-中文.txt'),'OUTSIDE SYNTHETIC BYTES');
    const identity=await inspectDesktopIdentity(worker);
    assert.equal(identity.eligible,true);assert.equal(identity.elevated,false);assert.ok(identity.sid);
    bridge=new FullTextNativeBridge({workerExecutable:worker,
      workerSha256:createHash('sha256').update(await fs.readFile(worker)).digest('hex'),
      expectedExecutor:{sid:identity.sid,logonId:identity.logon_id,sessionId:identity.session_id}});
    const owner={ownerId:'native-fixture-owner',deviceId:'native-fixture-device',executorId:'native-fixture-executor'};
    let selected:ProtectedReadRootSelection|null={owner,revision:'fixture-revision',digest:'fixture-digest',
      roots:[external],excludedRoots:[],fixedVolumeRoots:[]};
    const access=new ReadRootAccess(local,[protectedRoot],{selected:async()=>selected},bridge);
    const resolved=await access.resolve(file,owner,'read_file');
    assert.equal(resolved.external,true);assert.ok(resolved.rootIdentity);
    const scope=resolved as ReadRootScope;
    assert.equal((await access.readBytes(scope,owner,'read_file',64)).toString(),'OWN NATIVE MARKER');
    const rootStat=await fs.stat(external,{bigint:true}),fileStat=await fs.stat(file,{bigint:true});
    const page=await bridge.directoryPage(external,rootStat.dev,rootStat.ino,0,10,async()=>true);
    assert.deepEqual(page.names,['owned-é-中文.txt']);assert.equal(page.more,false);
    pin=await bridge.pinFile(file,external,{dev:rootStat.dev,ino:rootStat.ino},false,async()=>true);
    const descriptor=await fs.open(file,'r');
    try{const actual=await descriptor.stat({bigint:true});assert.equal(actual.dev,pin.dev);assert.equal(actual.ino,pin.ino);}
    finally{await descriptor.close();}
    assert.equal(pin.dev,fileStat.dev);assert.equal(pin.ino,fileStat.ino);
    await assert.rejects(fs.rename(external,backup),(error:NodeJS.ErrnoException)=>
      ['EPERM','EACCES','EBUSY'].includes(error.code??''));
    await bridge.verifyFilePin(pin);await bridge.releaseFilePin(pin);pin=undefined;
    await fs.rename(file,file+'.moved');await fs.rename(file+'.moved',file);
    for(const flag of [2,4]){
      await setAttributes(32|flag);
      try{await assert.rejects(access.readBytes(scope,owner,'read_file',64),/READ_ROOT_DENIED/);}
      finally{await setAttributes(32);}
    }
    await fs.rename(external,backup);moved=true;
    await fs.symlink(outside,external,'junction');junction=true;
    await assert.rejects(access.readBytes(scope,owner,'read_file',64),/READ_ROOT_DENIED/);
    assert.equal((await fs.lstat(external)).isSymbolicLink(),true);
    await fs.rm(external,{force:true});junction=false;
    await fs.rename(backup,external);moved=false;
    selected=null;
    await assert.rejects(access.readBytes(scope,owner,'read_file',64),/READ_ROOT_DENIED/);
  }finally{
    if(pin&&bridge)await bridge.releaseFilePin(pin).catch(()=>{});
    await bridge?.close();
    if(junction){assert.equal((await fs.lstat(external)).isSymbolicLink(),true);await fs.rm(external,{force:true});}
    if(moved)await fs.rename(backup,external);
    assert.equal(await fs.realpath(base),base);assert.equal(path.dirname(base),canonicalParent);
    assert.ok(path.basename(base).startsWith('hostdeck-read-native-'));
    for(const dir of [local,external,protectedRoot,outside]){
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        assert.equal(entry.isFile(),true);assert.equal(entry.name,'owned-é-中文.txt');await fs.unlink(path.join(dir,entry.name));
      }
      await fs.rmdir(dir);
    }
    await fs.rmdir(base);
    assert.equal(await fs.stat(base).then(()=>true,()=>false),false);
  }
});

test('real Windows directory paging fails explicitly after a rename between native batches',{
  skip:process.platform!=='win32'||!parent||!existsSync(worker)
    ? 'Explicit owned fixture parent and current Windows worker required' : false,
  timeout:30_000,
},async()=>{
  const canonicalParent=await fs.realpath(parent!);
  const base=await fs.realpath(await fs.mkdtemp(path.join(canonicalParent,'hostdeck-read-pages-')));
  const local=path.join(base,'workspace'),external=path.join(base,'external'),
    protectedRoot=path.join(base,'protected');
  const names=Array.from({length:240},(_,i)=>`owned-${String(i).padStart(3,'0')}.txt`);
  let bridge:FullTextNativeBridge|undefined;
  try{
    for(const dir of [local,external,protectedRoot])await fs.mkdir(dir);
    for(const name of names)await fs.writeFile(path.join(external,name),'OWNED_PAGE_FIXTURE');
    const identity=await inspectDesktopIdentity(worker);
    assert.equal(identity.eligible,true);assert.equal(identity.elevated,false);assert.ok(identity.sid);
    bridge=new FullTextNativeBridge({workerExecutable:worker,
      workerSha256:createHash('sha256').update(await fs.readFile(worker)).digest('hex'),
      expectedExecutor:{sid:identity.sid,logonId:identity.logon_id,sessionId:identity.session_id}});
    const owner={ownerId:'native-page-owner',deviceId:'native-page-device',executorId:'native-page-executor'};
    // Selection is synthetic; all 240 files, directory batches and timestamps are real.
    const selected:ProtectedReadRootSelection={owner,revision:'fixture',digest:'fixture',
      roots:[external],excludedRoots:[],fixedVolumeRoots:[]};
    const access=new ReadRootAccess(local,[protectedRoot],{selected:async()=>selected},bridge);
    const scope=await access.resolve(external,owner,'name_search') as ReadRootScope;
    const stable=await access.withDirectory(scope,owner,'name_search',async entries=>{
      const seen:string[]=[];for await(const entry of entries)seen.push(entry.name);return seen;
    });
    assert.deepEqual(stable.sort(),names);
    assert.equal(new Set(stable).size,240);
    let seen=0,mutated=false;
    await assert.rejects(access.withDirectory(scope,owner,'name_search',async entries=>{
      for await(const _entry of entries){
        if(++seen===192){
          await fs.rename(path.join(external,names[239]),path.join(external,'renamed-owned-239.txt'));
          mutated=true;
        }
      }
    }),/READ_ROOT_CHANGED/);
    assert.equal(mutated,true);assert.equal(seen,192);
  }finally{
    await bridge?.close();
    assert.equal(await fs.realpath(base),base);assert.equal(path.dirname(base),canonicalParent);
    assert.ok(path.basename(base).startsWith('hostdeck-read-pages-'));
    for(const dir of [local,external,protectedRoot]){
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        assert.equal(entry.isFile(),true);
        assert.ok(names.includes(entry.name)||entry.name==='renamed-owned-239.txt');
        await fs.unlink(path.join(dir,entry.name));
      }
      await fs.rmdir(dir);
    }
    await fs.rmdir(base);
    assert.equal(await fs.stat(base).then(()=>true,()=>false),false);
  }
});

test('actual directory metadata refuses an ancestor junction restored around path checks',{
  skip:process.platform!=='win32'||!parent||!existsSync(worker)
    ? 'Explicit owned fixture parent and current Windows worker required' : false,
  timeout:25_000,
},async()=>{
  // Isolate the controlled fs timing hooks from every other test and process.
  const fixture=fileURLToPath(new URL('./fixtures/read-root-native-directory-race.mjs',import.meta.url));
  const {stdout}=await execFile(process.execPath,['--import','tsx',fixture,parent!,worker],
    {shell:false,windowsHide:true,timeout:20_000,maxBuffer:65536});
  const observed=JSON.parse(stdout.trim());
  assert.equal(observed.verdict,'PASS');
  assert.equal(observed.nativeDirectoryCalls,1);
  assert.equal(observed.rejection,'READ_ROOT_CHANGED');
  assert.equal(observed.outsideMetadataDisclosed,false);
  assert.equal(observed.cleanup,'exact owned files and directories absent; nonrecursive');
});
