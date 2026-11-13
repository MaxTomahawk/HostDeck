import {syntheticFullTextAttributes} from './fixtures/fulltext-test-native-attributes.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,rename,rm,realpath,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FullTextEngine} from '../src/hostdeck/fulltext/engine.js';
import type {FullTextConfig,FullTextPrincipal,FullTextAuthorizer} from '../src/hostdeck/fulltext/types.js';

const principal:FullTextPrincipal={ownerId:'reparse-fixture',deviceId:'fixture-device',executorId:'fixture-executor'};

type Swap = (root:string,doc:string,outside:string)=>Promise<void>;

async function exercise(label:string,swap:Swap,allowedCodes:RegExp):Promise<void>{
  const tmp=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-swap-')));
  const root=path.join(tmp,'selected-root'),state=path.join(tmp,'protected-state'),outside=path.join(tmp,'outside-root');
  await Promise.all([mkdir(root),mkdir(state),mkdir(outside)]);
  const doc=path.join(root,'marker.txt');
  const config:FullTextConfig={indexFile:path.join(state,'own-index.sqlite'),roots:[root],formats:['.txt'],
    budgets:{maxOperationsPerStep:2,maxStepMilliseconds:9_000}};
  let indexChecks=0,swapped=false,engine:FullTextEngine|undefined;
  const authorize:FullTextAuthorizer=async r=>{
    if(r.principal.ownerId!==principal.ownerId)return false;
    if(r.action==='index'){
      indexChecks++;
      // The second index authorization is AFTER content extraction and
      // BEFORE precommit. The first read already passed safeRealpath.
      if(indexChecks===2){await swap(root,doc,outside);swapped=true;}
    }
    return true;
  };
  try{
    await writeFile(doc,'original owned content');
    await writeFile(path.join(outside,'unapproved.txt'),'PRIVATE_MARKER_NOT_FOR_INDEX');
    const preview=await FullTextEngine.preview(config,principal,authorize);
    engine=await FullTextEngine.openConfirmed(config,principal,authorize,preview.digest,syntheticFullTextAttributes);
    const id=(await engine.start(principal)).runId;
    // First step traverses directory, second step reaches owned file.
    const first=await engine.step(principal,id,1);
    assert.equal(first.state,'running');
    const second=await engine.step(principal,id,1);
    assert.equal(swapped,true,label+': race hook did not trigger');
    assert.equal(second.state,'paused',label+': source change incorrectly marked complete');
    assert.match(second.reason??'',allowedCodes,label+': expected safe failure');
    // Reparse/origin race must not commit *any* document text or metadata.
    const db=new DatabaseSync(config.indexFile,{readOnly:true});
    try{
      const docs=db.prepare('SELECT path,sha256,state FROM docs').all();
      const fts=db.prepare('SELECT body FROM docs_fts').all();
      assert.deepEqual(docs,[],label+': unapproved metadata entered main index');
      assert.deepEqual(fts,[],label+': unapproved content entered FTS index');
      const run=db.prepare('SELECT state FROM runs WHERE id=?').get(id) as {state:string};
      assert.equal(run.state,'paused');
    }finally{db.close();}
    if (label.startsWith('root')) {
      await assert.rejects(engine.search(principal,'PRIVATE_MARKER_NOT_FOR_INDEX'),
        /FULLTEXT_REPARSE_DENIED|FULLTEXT_ROOT_IDENTITY_CHANGED|FULLTEXT_OUTSIDE_ROOT/);
    } else {
      assert.deepEqual((await engine.search(principal,'PRIVATE_MARKER_NOT_FOR_INDEX')).results,[],
        'Even under a changed file identity, no unapproved results may be returned');
    }
  }finally{
    engine?.close();
    await rm(tmp,{recursive:true,force:true});
  }
}

test('root replaced with same-name different directory during source extraction: no index writes',async()=>{
  await exercise('root identity replacement',async(root,doc,outside)=>{
    await rename(root,root+'-original');
    await mkdir(root);
    await writeFile(doc,'PRIVATE_MARKER_NOT_FOR_INDEX');
  },/FULLTEXT_ROOT_IDENTITY_CHANGED/);
});

test('file replaced with a same-name different inode during extraction: no index writes',async()=>{
  await exercise('file identity replacement',async(root,doc,outside)=>{
    await rename(doc,path.join(outside,'old-fixture.txt'));
    await writeFile(doc,'PRIVATE_MARKER_NOT_FOR_INDEX');
  },/FULLTEXT_SOURCE_IDENTITY_CHANGED/);
});

test('file reparse into outside root during extraction is denied before index commit',async t=>{
  // This negative requires only a disposable file symlink, not a real drive.
  // On Windows without symlink privilege, root/file identity tests above still
  // run; NEVER pretend a skipped junction/symlink was tested.
  const tmp=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-linkprobe-')));
  try {
    await writeFile(path.join(tmp,'target.txt'),'owned');
    try{await symlink(path.join(tmp,'target.txt'),path.join(tmp,'probe.txt'),'file');}
    catch {t.skip('Windows fixture symlink privilege absent; reparse negative NOT_RUN');return;}
  } finally {await rm(tmp,{recursive:true,force:true});}
  await exercise('file reparse',async(root,doc,outside)=>{
    await rm(doc);
    await symlink(path.join(outside,'unapproved.txt'),doc,'file');
  },/FULLTEXT_REPARSE_DENIED|FULLTEXT_SOURCE_IDENTITY_CHANGED/);
});
