import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {DocxFileHandler} from '../src/utils/files/docx.js';
import {ExcelFileHandler} from '../src/utils/files/excel.js';
import {FullTextEngine} from '../src/hostdeck/fulltext/engine.js';
import {extractDocument} from '../src/hostdeck/fulltext/extract.js';
import {resolveBudgets} from '../src/hostdeck/fulltext/policy.js';
import {syntheticFullTextAttributes} from './fixtures/fulltext-test-native-attributes.js';
import type {FullTextAuthorizer,FullTextConfig,FullTextPrincipal} from '../src/hostdeck/fulltext/types.js';

const principal:FullTextPrincipal={ownerId:'coverage-fixture',deviceId:'test-device',executorId:'test-executor'};
const revoked=new Set<string>();
const authorize:FullTextAuthorizer=async request=>request.principal.ownerId===principal.ownerId
  && request.principal.deviceId===principal.deviceId
  && request.principal.executorId===principal.executorId && !revoked.has(request.path);

async function ownFixture(formats:FullTextConfig['formats']):Promise<{base:string;root:string;config:FullTextConfig}> {
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-evidence-')));
  const root=path.join(base,'selected-groundtruth'),state=path.join(base,'own-index-state');
  await mkdir(root);await mkdir(state);
  return {base,root,config:{indexFile:path.join(state,'index.sqlite'),roots:[root],formats,
    budgets:{maxOperationsPerStep:12,maxStepMilliseconds:9_000}}};
}
async function cleanupOwnFixture(base:string):Promise<void>{
  const temporaryRoot=await realpath(os.tmpdir());
  const canonical=await realpath(base);
  assert.equal(canonical,base,'fixture root must not be redirected');
  assert.equal(path.dirname(canonical),temporaryRoot,'fixture must remain directly below temp');
  assert.ok(path.basename(canonical).startsWith('hd-fulltext-evidence-'),'unexpected fixture name');
  await rm(canonical,{recursive:true,force:true});
}
async function finish(engine:FullTextEngine):Promise<void>{
  const run=(await engine.start(principal)).runId;
  for(let i=0;i<30;i++){
    const receipt=await engine.step(principal,run,12);
    if(receipt.state==='complete')return;
    assert.equal(receipt.state,'running',receipt.reason??'fixture stopped');
  }
  assert.fail('bounded fixture never completed');
}

test('indexed Office limitations survive SQLite/search/status/reopen; ACL denies evidence',async()=>{
  revoked.clear();
  const {base,root,config}=await ownFixture(['.txt','.docx','.xlsx','.pdf']);
  let engine:FullTextEngine|undefined;
  try{
    const txt=path.join(root,'own.txt'),docx=path.join(root,'own.docx'),
      xlsx=path.join(root,'own.xlsx'),pdfPath=path.join(root,'own.pdf'),
      empty=path.join(root,'empty.pdf');
    await writeFile(txt,'plainmarker actual qualified bytes');
    await new DocxFileHandler().write(docx,'Marigold DOCX groundtruth');
    await new ExcelFileHandler().write(xlsx,JSON.stringify([['A','B'],['Citrus','Fruitmarker']]));
    const textPdf=await PDFDocument.create();textPdf.addPage().drawText('Orchid PDF groundtruth');
    await writeFile(pdfPath,await textPdf.save());
    const scanned=await PDFDocument.create();scanned.addPage();
    await writeFile(empty,await scanned.save());

    const budget=resolveBudgets(config);
    const docxExtract=await extractDocument(docx,root,budget);
    const xlsxExtract=await extractDocument(xlsx,root,budget);
    assert.equal(docxExtract.coverage,'partial');
    assert.equal(xlsxExtract.coverage,'partial');
    assert.equal(docxExtract.status,'indexed');
    assert.equal(xlsxExtract.status,'indexed');
    const expectedDocx=[...new Set([...(docxExtract.limitations??[]),'structured_text_layer_only'])].sort();
    const expectedXlsx=[...new Set([...(xlsxExtract.limitations??[]),'structured_text_layer_only'])].sort();

    const preview=await FullTextEngine.preview(config,principal,authorize);
    engine=await FullTextEngine.openConfirmed(config,principal,authorize,preview.digest,syntheticFullTextAttributes);
    await finish(engine);
    const docxHit=(await engine.search(principal,'Marigold')).results[0]!;
    const xlsxHit=(await engine.search(principal,'Fruitmarker')).results[0]!;
    const txtHit=(await engine.search(principal,'plainmarker')).results[0]!;
    const pdfHit=(await engine.search(principal,'Orchid')).results[0]!;
    assert.equal(docxHit.documentCoverage,'partial');
    assert.deepEqual(docxHit.limitations,expectedDocx);
    assert.equal(xlsxHit.documentCoverage,'partial');
    assert.deepEqual(xlsxHit.limitations,expectedXlsx);
    assert.equal(txtHit.documentCoverage,'qualified_text');
    assert.deepEqual(txtHit.limitations,[]);
    assert.equal(pdfHit.documentCoverage,'partial');
    assert.ok(pdfHit.limitations.includes('pdf_text_layer_only_ocr_unverified'));

    const status=await engine.status(principal);
    const visible=new Map(status.visibleDocumentCoverage.map(row=>[row.path,row]));
    assert.deepEqual(visible.get(docx)?.limitations,expectedDocx);
    assert.equal(visible.get(docx)?.documentCoverage,'partial');
    assert.equal(visible.get(empty)?.state,'ocr_required');
    assert.equal(visible.get(empty)?.documentCoverage,'unqualified');
    assert.ok(visible.get(empty)?.limitations.includes('ocr_required'));
    for(const code of expectedDocx){
      assert.ok((status.visibleFormatCoverage.find(row=>row.format==='.docx')?.reasons[code]??0)>0,code);
    }
    const db=new DatabaseSync(config.indexFile,{readOnly:true});
    try{
      const stored=db.prepare('SELECT coverage,limitations_json FROM docs WHERE path=?')
        .get(docx) as {coverage:string;limitations_json:string};
      assert.equal(stored.coverage,'partial');
      assert.deepEqual(JSON.parse(stored.limitations_json),expectedDocx);
    }finally{db.close();}

    engine.close();engine=undefined;
    engine=await FullTextEngine.openConfirmed(config,principal,authorize,preview.digest,syntheticFullTextAttributes);
    assert.deepEqual((await engine.search(principal,'Marigold')).results[0]?.limitations,expectedDocx);
    revoked.add(docx);
    assert.equal((await engine.search(principal,'Marigold')).results.length,0);
    const restricted=await engine.status(principal);
    assert.ok(!restricted.visibleDocumentCoverage.some(row=>row.path===docx));
    assert.equal(restricted.coverage,'partial_or_unverified');
  }finally{revoked.clear();engine?.close();await cleanupOwnFixture(base);}
});

test('legacy indexed Office rows remain unverified until a source-backed rescan',async()=>{
  revoked.clear();
  const {base,root,config}=await ownFixture(['.docx']);
  let engine:FullTextEngine|undefined;
  try{
    const file=path.join(root,'legacy.docx');
    await new DocxFileHandler().write(file,'legacyfixture actual DOCX source');
    const db=new DatabaseSync(config.indexFile);
    try{
      db.exec(`
        CREATE TABLE docs (id INTEGER PRIMARY KEY,path TEXT UNIQUE NOT NULL,root TEXT NOT NULL,
          format TEXT NOT NULL,state TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,
          indexed_at TEXT NOT NULL,seen_scan TEXT NOT NULL);
        CREATE VIRTUAL TABLE docs_fts USING fts5(body,grams,tokenize='unicode61 remove_diacritics 2');
        CREATE TABLE runs (id TEXT PRIMARY KEY,state TEXT NOT NULL,incomplete INTEGER NOT NULL DEFAULT 0,
          traversal_incomplete INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,
          read_bytes INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      `);
      db.prepare('INSERT INTO docs(path,root,format,state,sha256,bytes,indexed_at,seen_scan) VALUES(?,?,?,?,?,?,?,?)')
        .run(file,root,'.docx','indexed','legacy-hash',32,'2026-10-27','past-run');
      db.prepare('INSERT INTO docs_fts(rowid,body,grams) VALUES(1,?,?)').run('legacyfixture actual DOCX source','');
      db.prepare('INSERT INTO runs(id,state,created_at,updated_at) VALUES(?,?,?,?)')
        .run('past-run','complete','2026-10-27','2026-10-27');
      assert.deepEqual(db.prepare('PRAGMA table_info(docs)').all().map((row:any)=>row.name)
        .filter((name:string)=>name==='coverage'||name==='limitations_json'),[]);
    }finally{db.close();}
    const preview=await FullTextEngine.preview(config,principal,authorize);
    engine=await FullTextEngine.openConfirmed(config,principal,authorize,preview.digest,syntheticFullTextAttributes);
    const legacy=(await engine.search(principal,'legacyfixture')).results[0]!;
    assert.equal(legacy.documentCoverage,'legacy_unverified');
    assert.deepEqual(legacy.limitations,['legacy_coverage_unverified']);
    assert.equal((await engine.status(principal)).coverage,'partial_or_unverified');
    assert.equal((await engine.status(principal)).visibleDocumentCoverage[0]?.documentCoverage,'legacy_unverified');
    await finish(engine);
    const updated=(await engine.search(principal,'legacyfixture')).results[0]!;
    assert.equal(updated.documentCoverage,'partial');
    assert.ok(updated.limitations.includes('structured_text_layer_only'));
    assert.equal((await engine.status(principal)).coverage,'partial_or_unverified');
  }finally{engine?.close();await cleanupOwnFixture(base);}
});
