import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile , realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { DocxFileHandler } from '../src/utils/files/docx.js';
import { ExcelFileHandler } from '../src/utils/files/excel.js';
import { FullTextEngine } from '../src/hostdeck/fulltext/engine.js';
import { extractDocument } from '../src/hostdeck/fulltext/extract.js';
import { resolveBudgets } from '../src/hostdeck/fulltext/policy.js';
import type { FullTextConfig, FullTextPrincipal, FullTextAuthorizer } from '../src/hostdeck/fulltext/types.js';

const principal:FullTextPrincipal={ownerId:'documents-test',deviceId:'own-device',executorId:'own-worker'};
const authorize:FullTextAuthorizer=async req=>req.principal.ownerId==='documents-test';

test('ground-truth DOCX/XLSX/PDF extractors use existing qualified parsers; no implicit OCR',async()=>{
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-docs-')));
  const corpus=path.join(base,'chosen-documents'),state=path.join(base,'private-state');
  await mkdir(corpus);await mkdir(state);
  const config:FullTextConfig={indexFile:path.join(state,'private-index.sqlite'),roots:[corpus],
    formats:['.docx','.xlsx','.pdf'],budgets:{maxOperationsPerStep:8,maxStepMilliseconds:10_000}};
  let engine:FullTextEngine|undefined;
  try {
    const docx=path.join(corpus,'document.docx');
    await new DocxFileHandler().write(docx,'Marigold fixture in DOCX.');
    const xlsx=path.join(corpus,'spreadsheet.xlsx');
    await new ExcelFileHandler().write(xlsx,JSON.stringify([['Label','Value'],['Citrus','Fruitmarker']]));
    const pdf=await PDFDocument.create();
    pdf.addPage().drawText('Orchid fixture in PDF');
    const pdfPath=path.join(corpus,'report.pdf');
    await writeFile(pdfPath,await pdf.save());
    const blank=await PDFDocument.create();
    blank.addPage();
    const imageOnly=path.join(corpus,'empty-page.pdf');
    await writeFile(imageOnly,await blank.save());

    const budget=resolveBudgets(config);
    assert.equal((await extractDocument(docx,corpus,budget)).status,'indexed');
    assert.equal((await extractDocument(xlsx,corpus,budget)).status,'indexed');
    assert.equal((await extractDocument(pdfPath,corpus,budget)).status,'indexed');
    assert.equal((await extractDocument(imageOnly,corpus,budget)).status,'ocr_required');

    const preview=await FullTextEngine.preview(config,principal,authorize);
    engine=await FullTextEngine.openConfirmed(config,principal,authorize,preview.digest);
    const id=(await engine.start(principal)).runId;
    let last='running';
    for(let i=0;i<20;i++){
      const receipt=await engine.step(principal,id,6);last=receipt.state;
      if(last==='complete')break;
      assert.equal(last,'running', receipt.reason??'unexpected scan pause');
    }
    assert.equal(last,'complete');
    assert.equal((await engine.search(principal,'Marigold')).results[0]?.path,docx);
    assert.equal((await engine.search(principal,'Fruitmarker')).results[0]?.path,xlsx);
    assert.equal((await engine.search(principal,'Orchid')).results[0]?.path,pdfPath);
    assert.equal((await engine.search(principal,'empty-page')).results.length,0);
    assert.equal((await engine.status(principal)).coverage,'partial_or_unverified',
      'Blank PDF must keep incomplete/OCR-unknown status visible');
  }finally{
    engine?.close();
    await rm(base,{recursive:true,force:true});
  }
});

test('text extractor refuses invalid UTF-8 instead of indexing replacement characters',async()=>{
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-invalid-')));
  const file=path.join(base,'invalid.txt');
  try {
    await writeFile(file,Buffer.from([0x61,0x80,0x62]));
    const cfg:FullTextConfig={indexFile:path.join(base,'outside.sqlite'),roots:[],formats:['.txt']};
    const r=await extractDocument(file,base,resolveBudgets(cfg));
    assert.equal(r.status,'invalid_utf8');
    assert.equal(r.text,undefined);
  }finally{await rm(base,{recursive:true,force:true});}
});
