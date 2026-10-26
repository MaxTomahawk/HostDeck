import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rename, rm, access, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FullTextEngine } from '../src/hostdeck/fulltext/engine.js';
import { hanBigrams, parseFullTextQuery, satisfiesHanSubstrings } from '../src/hostdeck/fulltext/query.js';
import type { FullTextConfig, FullTextPrincipal, FullTextAuthorizer } from '../src/hostdeck/fulltext/types.js';

const principal: FullTextPrincipal = { ownerId:'fixture-owner', deviceId:'fixture-device', executorId:'fixture-executor', sessionId:1 };

async function completeScan(engine: FullTextEngine, id: string): Promise<{renamed:number;changed:number;deleted:number}> {
  let renamed=0,changed=0,deleted=0;
  for (let i=0; i<100; i++) {
    const r=await engine.step(principal,id,2);
    renamed+=r.renamedThisStep; changed+=r.changedThisStep; deleted+=r.removedAtCompletion;
    if (r.state==='complete') return {renamed,changed,deleted};
    assert.equal(r.state,'running', `Unexpected incomplete full-text step: ${r.state} ${r.reason??''}`);
  }
  assert.fail('Bounded fixture did not complete scan');
}

test('manual SQLite FTS5: explicit roots, Han bigrams, updates, rename/delete and live ACLs',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-fixture-'));
  const corpus=path.join(tmp,'selected-corpus'),state=path.join(tmp,'state');
  await mkdir(corpus); await mkdir(state);
  const file=(name:string)=>path.join(corpus,name);
  const database=path.join(state,'own-index.sqlite');
  const config:FullTextConfig={indexFile:database,roots:[corpus],
    formats:['.txt'],budgets:{maxOperationsPerStep:4,maxStepMilliseconds:8_000}};
  const denied=new Set<string>();
  const auth:FullTextAuthorizer=async req=>req.principal.ownerId===principal.ownerId &&
    req.principal.deviceId===principal.deviceId && !denied.has(req.path);
  let engine: FullTextEngine|undefined;
  try{
    const noRoots={...config,roots:[]};
    const empty=await FullTextEngine.preview(noRoots,principal,auth);
    assert.equal(empty.activated,false);
    assert.equal(empty.requiresSelectedRoots,true);
    await assert.rejects(FullTextEngine.openConfirmed(noRoots,principal,auth,empty.digest),/FULLTEXT_SELECTION_NOT_CONFIRMED/);
    assert.equal(await access(database).then(()=>true,()=>false),false,'preview must not create any index');
    const preview=await FullTextEngine.preview(config,principal,auth);
    assert.equal(preview.activated,false);
    assert.equal(preview.machine.gpuUsed,false);
    await assert.rejects(FullTextEngine.openConfirmed(config,principal,auth,'invalid-digest'),/FULLTEXT_SELECTION_NOT_CONFIRMED/);
    await writeFile(file('alpha.txt'),'alpha oldmarker unique'); 
    await writeFile(file('han.txt'),'开头中文文件末尾'); 
    await writeFile(file('latin.txt'),'België Café cafe\u0301'); 
    await writeFile(file('arabic.txt'),'السلام عليكم');
    await writeFile(file('delete.txt'),'todelete oldmarker');
    engine=await FullTextEngine.openConfirmed(config,principal,auth,preview.digest);
    await completeScan(engine,(await engine.start(principal)).runId);
    const status=await engine.status(principal);
    assert.equal(status.state,'complete');
    assert.equal(status.visibleDocuments,5);
    assert.equal(status.coverage,'complete_bounded_scan');
    const han=await engine.search(principal,'中文');
    assert.deepEqual(han.results.map(item=>path.basename(item.path)),['han.txt']);
    assert.ok(han.results[0].snippet.includes('中文'));
    assert.ok((await engine.search(principal,'Belgie')).results.some(item=>item.path===file('latin.txt')));
    assert.ok((await engine.search(principal,'cafe')).results.some(item=>item.path===file('latin.txt')));
    assert.ok((await engine.search(principal,'السلام')).results.some(item=>item.path===file('arabic.txt')));
    await assert.rejects(engine.search(principal,'中'),/FULLTEXT_QUERY_INVALID|FULLTEXT_HAN_MIN_TWO/);
    const other={...principal,ownerId:'another-user'};
    await assert.rejects(engine.search(other,'alpha'),/FULLTEXT_DENIED/);

    // A removed ACL does not leak matching filenames, snippets or a full count.
    denied.add(file('alpha.txt'));
    assert.equal((await engine.search(principal,'alpha')).results.every(hit=>hit.path!==file('alpha.txt')),true);
    const filtered=await engine.status(principal);
    assert.equal(filtered.visibleDocuments,4);
    assert.equal(filtered.coverage,'partial_or_unverified');
    denied.delete(file('alpha.txt'));
    denied.add(corpus);
    await assert.rejects(engine.search(principal,'alpha'),/FULLTEXT_DENIED/);
    denied.delete(corpus);

    // In the next explicitly requested scan: changed text, same-byte rename,
    // and an actual file deletion are independently visible.
    await rename(file('alpha.txt'),file('renamed-alpha.txt'));
    await writeFile(file('han.txt'),'文档更新后保留中文文件');
    await rm(file('delete.txt'));
    const delta=await completeScan(engine,(await engine.start(principal)).runId);
    assert.ok(delta.renamed>=1,'unique same-content rename was not recognized');
    assert.ok(delta.changed>=1,'changed source hash was not detected');
    assert.equal(delta.deleted,1);
    assert.deepEqual((await engine.search(principal,'oldmarker')).results.map(item=>path.basename(item.path)),['renamed-alpha.txt']);
    assert.equal((await engine.search(principal,'todelete')).results.length,0);
    assert.equal((await engine.search(principal,'开头')).results.length,0);
    assert.deepEqual((await engine.search(principal,'中文')).results.map(item=>path.basename(item.path)),['han.txt']);

    // Persisted crash/restart states are not claimed as succeeded. No watcher.
    const pending=await engine.start(principal);
    engine.close();engine=undefined;
    engine=await FullTextEngine.openConfirmed(config,principal,auth,preview.digest);
    assert.equal((await engine.status(principal)).state,'interrupted');
    await engine.resume(principal,pending.runId);
    await completeScan(engine,pending.runId);
    const pause=await engine.start(principal);
    await engine.pause(principal,pause.runId);
    await assert.rejects(engine.step(principal,pause.runId),/FULLTEXT_NOT_RUNNING/);
    await engine.cancel(principal,pause.runId);
    assert.equal((await engine.status(principal)).state,'cancelled');
  }finally{
    engine?.close();
    await rm(tmp,{recursive:true,force:true});
  }
});

test('Han query semantics are explicit; never claim general CJK substring recall',()=>{
  assert.equal(hanBigrams('中文文件'),'中文 文文 文件');
  assert.equal(parseFullTextQuery('中文').ftsMatch,'grams:"中文"');
  assert.equal(parseFullTextQuery('中文文件').ftsMatch,'grams:"中文" AND grams:"文文" AND grams:"文件"');
  assert.ok(satisfiesHanSubstrings('中文文件',['中文']));
  assert.equal(satisfiesHanSubstrings('中文别处文件',['中文文件']),false);
  assert.throws(()=>parseFullTextQuery('中'),/FULLTEXT_QUERY_INVALID|FULLTEXT_HAN_MIN_TWO/);
  assert.throws(()=>parseFullTextQuery('http://'),/FULLTEXT_QUERY_INVALID|FULLTEXT_QUERY_LIMIT/);
});

test('no automatic indexing of a volume root; symlinks cannot leave own corpus',async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-link-'));
  const corpus=path.join(tmp,'corpus'),state=path.join(tmp,'state'),external=path.join(tmp,'external');
  await Promise.all([mkdir(corpus),mkdir(state),mkdir(external)]);
  const config:FullTextConfig={indexFile:path.join(state,'index.sqlite'),roots:[corpus],formats:['.txt']};
  const auth:FullTextAuthorizer=async()=>true;
  let engine:FullTextEngine|undefined;
  try{
    await assert.rejects(FullTextEngine.preview({...config,roots:[path.parse(corpus).root]},principal,auth),/FULLTEXT_VOLUME_ROOT_DENIED/);
    try { await symlink(external,path.join(corpus,'link'),'junction'); }
    catch(error) {
      t.diagnostic('Symlink/junction fixture unavailable under current OS user; that negative remains NOT_RUN');
      return;
    }
    await writeFile(path.join(external,'hidden.txt'),'SECRET_OUTSIDE_ROOT_FIXTURE');
    const preview=await FullTextEngine.preview(config,principal,auth);
    engine=await FullTextEngine.openConfirmed(config,principal,auth,preview.digest);
    const scan=await engine.start(principal);
    for(let i=0;i<10;i++){
      const receipt=await engine.step(principal,scan.runId);
      if(receipt.state==='complete')break;
      assert.equal(receipt.state,'running');
    }
    assert.equal((await engine.search(principal,'SECRET_OUTSIDE_ROOT_FIXTURE')).results.length,0);
    assert.equal((await engine.status(principal)).coverage,'partial_or_unverified');
  }finally{engine?.close();await rm(tmp,{recursive:true,force:true});}
});
