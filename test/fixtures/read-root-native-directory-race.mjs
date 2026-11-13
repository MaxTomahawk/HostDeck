// Exact owned fixture. Only selection and race timing are synthetic; native
// attributes/handles and actual junction-backed lstat/stat observations are real.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {FullTextNativeBridge} from '../../src/hostdeck/fulltext-native-bridge.js';
import {ReadRootAccess} from '../../src/hostdeck/read-root-access.js';
import {inspectDesktopIdentity} from '../../src/hostdeck/desktop.js';
const cfg={workspace:process.argv[2]},worker=process.argv[3];
assert.ok(cfg.workspace&&worker&&path.isAbsolute(cfg.workspace)&&path.isAbsolute(worker));
const report={run:'OWNED-NATIVE-DIRECTORY-RACE',startedUtc:new Date().toISOString(),selection:'synthetic exact owned roots; actual native attribute and directory handles, live Windows junction swaps and actual lstat/stat metadata',verdict:'NOT_RUN'};
const originalStat=fs.stat,originalLstat=fs.lstat;
let base,bridge,moved=false,junction=false,checking=true,swapParent,backup,outsideParent;
async function swapped(use){
  await fs.rename(swapParent,backup);moved=true;
  try{await fs.symlink(outsideParent,swapParent,'junction');junction=true;return await use();}
  finally{if(junction){await fs.rm(swapParent,{force:true});junction=false}if(moved){await fs.rename(backup,swapParent);moved=false}}
}
try{
  base=await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(cfg.workspace),'hd-directory-race035-')));
  const local=path.join(base,'workspace'),external=path.join(base,'selected'),protectedRoot=path.join(base,'protected');
  outsideParent=path.join(base,'outside');swapParent=path.join(external,'sub');backup=path.join(external,'sub-backup');
  const target=path.join(swapParent,'leaf'),outsideLeaf=path.join(outsideParent,'leaf');
  for(const dir of [local,external,protectedRoot,outsideParent,swapParent,target,outsideLeaf])await fs.mkdir(dir);
  await fs.writeFile(path.join(outsideLeaf,'SYNTHETIC-OUTSIDE-NAME.txt'),'SYNTHETIC');
  await fs.utimes(target,new Date('2020-01-01T00:00:00Z'),new Date('2020-01-01T00:00:00Z'));
  await fs.utimes(outsideLeaf,new Date('2001-01-01T00:00:00Z'),new Date('2001-01-01T00:00:00Z'));
  const identity=await inspectDesktopIdentity(worker);
  bridge=new FullTextNativeBridge({workerExecutable:worker,workerSha256:createHash('sha256').update(await fs.readFile(worker)).digest('hex'),expectedExecutor:{sid:identity.sid,logonId:identity.logon_id,sessionId:identity.session_id}});
  const owner={ownerId:'own-fixture',deviceId:'own-device',executorId:'own-executor'};
  const selection={owner,revision:'own-revision',digest:'own-digest',roots:[external],excludedRoots:[],fixedVolumeRoots:[]};
  const access=new ReadRootAccess(local,[protectedRoot],{selected:async()=>selection},bridge);
  const scope=await access.resolve(target,owner,'file_info');
  const assertScope=access.assertScope.bind(access);
  access.assertScope=async(...args)=>{checking=true;try{return await assertScope(...args)}finally{checking=false}};
  fs.stat=async(file,...args)=>!checking&&String(file)===target?swapped(()=>originalStat(file,...args)):originalStat(file,...args);
  fs.lstat=async(file,...args)=>!checking&&String(file)===target?swapped(()=>originalLstat(file,...args)):originalLstat(file,...args);
  const directoryPage=bridge.directoryPage.bind(bridge);
  bridge.directoryPage=async(...args)=>{report.nativeDirectoryCalls=(report.nativeDirectoryCalls??0)+1;return swapped(()=>directoryPage(...args))};
  let rejected=false;
  try{report.returnedMetadata=await access.metadata(scope,owner,'file_info');}
  catch(error){report.rejection=error.message;rejected=true;}
  report.outsideMetadataDisclosed=report.returnedMetadata?.modified==='2001-01-01T00:00:00.000Z';
  assert.equal(rejected,true,'Directory metadata must reject the actual outside opened directory even when path checks see the restored authorized chain');
  report.verdict='PASS';
}catch(error){report.verdict='FAIL';report.error={name:error.name,message:error.message};process.exitCode=1;}
finally{
  fs.stat=originalStat;fs.lstat=originalLstat;
  if(junction){await fs.rm(swapParent,{force:true});junction=false}if(moved){await fs.rename(backup,swapParent);moved=false}
  await bridge?.close();
  if(base){
    assert.equal(await fs.realpath(base),base);assert.equal(path.dirname(base),await fs.realpath(cfg.workspace));assert.ok(path.basename(base).startsWith('hd-directory-race035-'));
    await fs.unlink(path.join(base,'outside/leaf/SYNTHETIC-OUTSIDE-NAME.txt'));
    for(const relative of ['selected/sub/leaf','selected/sub','selected','outside/leaf','outside','workspace','protected'])await fs.rmdir(path.join(base,relative));
    await fs.rmdir(base);assert.equal(await fs.stat(base).then(()=>true,()=>false),false);report.cleanup='exact owned files and directories absent; nonrecursive';
  }
  report.endedUtc=new Date().toISOString();console.log(JSON.stringify(report));
}
