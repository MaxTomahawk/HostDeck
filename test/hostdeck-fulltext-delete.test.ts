import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {FullTextEngine} from '../src/hostdeck/fulltext/engine.js';
import type {FullTextAuthorizer,FullTextConfig,FullTextPrincipal} from '../src/hostdeck/fulltext/types.js';

const caller:FullTextPrincipal={ownerId:'delete-oracle',deviceId:'fixture-device',executorId:'fixture-executor'};
const marker='HD_DELETE_001_PROVEN_OLD_TEXT';

async function ownFixture(budgets:FullTextConfig['budgets']={}){
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-delete-')));
  const root=path.join(base,'explicitly-selected'), state=path.join(base,'private-index');
  await mkdir(root);await mkdir(state);
  const config:FullTextConfig={indexFile:path.join(state,'index.sqlite'),roots:[root],formats:['.txt','.pdf'],
    budgets:{maxOperationsPerStep:4,maxStepMilliseconds:8_000,...budgets}};
  const old=path.join(root,'old.txt');
  await writeFile(old,marker);
  return {base,root,config,old};
}

async function complete(engine:FullTextEngine,id:string){
  let removed=0,last;
  for(let attempt=0;attempt<80;attempt++){
    const step=await engine.step(caller,id,4);
    removed+=step.removedAtCompletion;
    last=step;
    if(step.state==='complete')return {removed,last};
    assert.equal(step.state,'running','unexpected bounded scan interruption: '+(step.reason??step.state));
  }
  assert.fail('fixture scan did not complete in bounded steps');
}

function rows(index:string){
  const db=new DatabaseSync(index,{readOnly:true});
  try{
    const docs=db.prepare('SELECT path,state,seen_scan FROM docs ORDER BY path').all() as
      Array<{path:string;state:string;seen_scan:string}>;
    const text=db.prepare('SELECT body FROM docs_fts').all() as Array<{body:string}>;
    const run=db.prepare('SELECT state,incomplete,traversal_incomplete FROM runs ORDER BY rowid DESC LIMIT 1')
      .get() as {state:string;incomplete:number;traversal_incomplete:number};
    return {docs,text,run};
  }finally{db.close();}
}

/** HD-B007-FULLTEXT-DELETE-001: original RED: removed=0 and obsolete text retained. */
test('OCR-required blank PDF keeps recall partial but fully traversed delete purges TXT bytes',async()=>{
  const f=await ownFixture();
  const allow:FullTextAuthorizer=async()=>true;
  let engine:FullTextEngine|undefined;
  try{
    const pdf=await PDFDocument.create();pdf.addPage();
    const scanned=path.join(f.root,'empty.pdf');
    await writeFile(scanned,await pdf.save());
    const preview=await FullTextEngine.preview(f.config,caller,allow);
    engine=await FullTextEngine.openConfirmed(f.config,caller,allow,preview.digest);
    await complete(engine,(await engine.start(caller)).runId);
    const before=rows(f.config.indexFile);
    assert.equal(before.docs.length,2);
    assert.equal(before.docs.find(x=>x.path===scanned)?.state,'ocr_required');
    assert.ok(before.text.some(x=>x.body.includes(marker)));
    assert.equal(before.run.incomplete,1,'empty PDF must retain incomplete content coverage');
    assert.equal(before.run.traversal_incomplete,0,'all selected directories were enumerated');

    await rm(f.old);
    const {removed,last}=await complete(engine,(await engine.start(caller)).runId);
    assert.equal(last.coverage,'partial','OCR is still unavailable');
    assert.equal(removed,1,'complete traversal must purge exactly the deleted TXT');
    const after=rows(f.config.indexFile);
    assert.deepEqual(after.docs.map(x=>({path:x.path,state:x.state})),[{path:scanned,state:'ocr_required'}]);
    assert.equal(after.text.length,0,'deleted private content must not persist in SQLite FTS');
    assert.equal(after.run.incomplete,1,'do not advertise complete document recall');
    assert.equal(after.run.traversal_incomplete,0,'traversal itself was complete');
    assert.deepEqual((await engine.search(caller,marker)).results,[]);
    const status=await engine.status(caller);
    assert.equal(status.visibleDocuments,0);
    assert.equal(status.coverage,'partial_or_unverified');
  }finally{engine?.close();await rm(f.base,{recursive:true,force:true});}
});

for(const mode of ['acl','depth','entry_limit'] as const){
  test('partial '+mode+' traversal preserves unmatched prior index rows',async()=>{
    const budgets=mode==='entry_limit'?{maxEntriesPerDirectory:1}:
      mode==='depth'?{maxDepth:1}:{};
    const f=await ownFixture(budgets);
    const blocked=path.join(f.root,'blocked');
    let deny=false;
    const allow:FullTextAuthorizer=async r=>!(deny&&mode==='acl'&&r.action==='scan'&&r.path===blocked);
    let engine:FullTextEngine|undefined;
    try{
      const preview=await FullTextEngine.preview(f.config,caller,allow);
      engine=await FullTextEngine.openConfirmed(f.config,caller,allow,preview.digest);
      await complete(engine,(await engine.start(caller)).runId);
      await rm(f.old);
      if(mode==='acl'){
        await mkdir(blocked);deny=true;
      } else if(mode==='depth'){
        await mkdir(blocked);await mkdir(path.join(blocked,'deeper'));
      } else{
        await writeFile(path.join(f.root,'extra-a.txt'),'other fixture');
        await writeFile(path.join(f.root,'extra-b.txt'),'more fixture');
      }
      const {removed,last}=await complete(engine,(await engine.start(caller)).runId);
      const after=rows(f.config.indexFile);
      assert.equal(removed,0,'unsafe traversal must not purge an old row');
      assert.equal(last.coverage,'partial');
      assert.equal(after.run.traversal_incomplete,1,mode+' did not set traversal-incomplete');
      assert.ok(after.docs.some(x=>x.path===f.old),'prior metadata must be retained');
      assert.ok(after.text.some(x=>x.body.includes(marker)),'prior FTS content must be retained on unsafe purge');
    }finally{engine?.close();await rm(f.base,{recursive:true,force:true});}
  });
}


test('legacy incomplete-only run migrates fail-closed; only new traversals start eligible for purge',async()=>{
  const f=await ownFixture();
  let engine:FullTextEngine|undefined;
  try{
    const legacy=new DatabaseSync(f.config.indexFile);
    try{
      legacy.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, state TEXT NOT NULL,
          incomplete INTEGER NOT NULL DEFAULT 0,
          processed INTEGER NOT NULL DEFAULT 0, read_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO runs(id,state,incomplete,created_at,updated_at)
        VALUES('legacy-fixture','complete',1,'2026-10-26T00:00:00Z','2026-10-26T00:00:00Z');
      `);
    }finally{legacy.close();}
    const allow:FullTextAuthorizer=async()=>true;
    const preview=await FullTextEngine.preview(f.config,caller,allow);
    engine=await FullTextEngine.openConfirmed(f.config,caller,allow,preview.digest);
    const db=new DatabaseSync(f.config.indexFile,{readOnly:true});
    try{
      const old=db.prepare('SELECT incomplete,traversal_incomplete FROM runs WHERE id=?').get('legacy-fixture') as
        {incomplete:number;traversal_incomplete:number};
      assert.equal(old.incomplete,1);
      assert.equal(old.traversal_incomplete,1,
        'legacy content/traversal ambiguity must never authorize deletion');
    }finally{db.close();}
    const id=(await engine.start(caller)).runId;
    const pending=new DatabaseSync(f.config.indexFile,{readOnly:true});
    try{
      assert.equal((pending.prepare('SELECT traversal_incomplete FROM runs WHERE id=?').get(id) as
        {traversal_incomplete:number}).traversal_incomplete,0);
    }finally{pending.close();}
    await complete(engine,id);
  }finally{engine?.close();await rm(f.base,{recursive:true,force:true});}
});
