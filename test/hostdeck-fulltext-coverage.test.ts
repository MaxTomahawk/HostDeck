import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DocxFileHandler,pizzipPackage} from '../src/utils/files/docx.js';
import {exceljsPackage} from '../src/utils/files/excel.js';
import {extractDocument} from '../src/hostdeck/fulltext/extract.js';
import {resolveBudgets} from '../src/hostdeck/fulltext/policy.js';
import type {FullTextConfig} from '../src/hostdeck/fulltext/types.js';

/**
 * HD-WP-05: independent OOXML groundtruth, not an Outline-prefix PASS.
 * Original baseline FAIL: >500-char DOCX paragraph tail omitted by outline;
 * no complete header/footer/footnote/comment extraction; XLSX objects
 * (date, richText, hyperlink, note, formula) rejected as unsupported.
 * Groundtruth also qualified against own python-docx/openpyxl ZIP/XML files
 * before this repair; only bundled deterministic fixtures run in CI/local Node.
 */
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R='http://schemas.openxmlformats.org/package/2006/relationships';
const O='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const limits=resolveBudgets({roots:[],indexFile:path.join(os.tmpdir(),'unused-index.sqlite'),formats:['.docx','.xlsx']} as FullTextConfig);
function part(root:string,content:string):string {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    +'<w:'+root+' xmlns:w="'+W+'">'
    +'<w:p><w:r><w:t xml:space="preserve">'+content+'</w:t></w:r></w:p>'
    +'</w:'+root+'>';
}
function related(name:string,marker:string):string {
  const root= name==='header'?'hdr':name==='footer'?'ftr':name==='footnotes'?'footnotes'
    :name==='endnotes'?'endnotes':'comments';
  const content='<w:p><w:r><w:t>'+marker+'</w:t></w:r></w:p>';
  if(root==='footnotes'||root==='endnotes'){
    const singular=root.slice(0,-1);
    return '<?xml version="1.0" encoding="UTF-8"?>'
      +'<w:'+root+' xmlns:w="'+W+'"><w:'+singular+' w:id="5">'+content
      +'</w:'+singular+'></w:'+root+'>';
  }
  if(root==='comments'){
    return '<?xml version="1.0" encoding="UTF-8"?>'
      +'<w:comments xmlns:w="'+W+'"><w:comment w:id="0" w:author="Fixture">'+content
      +'</w:comment></w:comments>';
  }
  return part(root,marker);
}
async function docxFixture(file:string):Promise<{tail:string;markers:string[]}>{
  await new DocxFileHandler().write(file,'BASE_DOCX_é_中文');
  const zip=new (pizzipPackage.load())(await readFile(file));
  const long='L'.repeat(530);
  const tail='BODY_TAIL_é_中文_الشرق';
  const body=zip.file('word/document.xml')!.asText();
  assert.ok(body.includes('</w:body>'),'source document lacks Word body');
  zip.file('word/document.xml',body.replace('</w:body>',
    '<w:p><w:r><w:t>'+long+tail+'</w:t></w:r></w:p></w:body>'));
  const names=['header','footer','footnotes','endnotes','comments'];
  const targets=['header1.xml','footer1.xml','footnotes.xml','endnotes.xml','comments.xml'];
  const markers=['HEADER_é_中文','FOOTER_é_中文','FOOTNOTE_é_中文',
    'ENDNOTE_é_中文','COMMENT_é_中文'];
  let rels=zip.file('word/_rels/document.xml.rels')?.asText()
    ??'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="'+R+'"></Relationships>';
  const inserts=names.map((name,i)=>'<Relationship Id="fixture'+i+'" Type="'+O+'/'+name
    +'" Target="'+targets[i]+'"/>').join('');
  assert.ok(rels.includes('</Relationships>'));
  rels=rels.replace('</Relationships>',inserts+'</Relationships>');
  zip.file('word/_rels/document.xml.rels',rels);
  for(let i=0;i<targets.length;i++){
    const prefix=i===0?'H'.repeat(120):i===1?'F'.repeat(120):'';
    zip.file('word/'+targets[i],related(names[i],prefix+markers[i]));
  }
  // Proper independent OPC content types, so this is a valid multi-part
  // document rather than merely a ZIP with unreferenced Word filenames.
  const typeNames=['header','footer','footnotes','endnotes','comments'];
  const types=typeNames.map((type,i)=>'<Override PartName="/word/'+targets[i]
    +'" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.'+type+'+xml"/>').join('');
  const manifest=zip.file('[Content_Types].xml')!.asText();
  assert.ok(manifest.includes('</Types>'));
  zip.file('[Content_Types].xml',manifest.replace('</Types>',types+'</Types>'));
  await writeFile(file,zip.generate({type:'nodebuffer',compression:'DEFLATE'}));
  const reread=new (pizzipPackage.load())(await readFile(file));
  assert.ok(reread.file('word/document.xml')!.asText().includes(tail));
  for(let i=0;i<targets.length;i++)assert.ok(reread.file('word/'+targets[i])!.asText().includes(markers[i]));
  return {tail,markers};
}

test('DOCX full source text includes long paragraph, tables/section parts, not Outline preview',async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-coverage-docx-')));
  try{
    const f=path.join(root,'own.docx'),original=await docxFixture(f);
    const r=await extractDocument(f,root,limits);
    assert.equal(r.status,'indexed');
    assert.equal(r.coverage,'partial','qualified text is not a complete multimedia DOCX claim');
    assert.ok(r.text?.includes(original.tail),'the historical >500-character body suffix was dropped');
    for(const marker of original.markers)
      assert.ok(r.text?.includes(marker),'OOXML relationship part missing: '+marker);
    assert.ok(!r.text?.includes('DOCX Outline:'),'editing outline must never be indexed as document body');
    assert.ok(r.limitations?.includes('docx_nontext_or_unqualified_parts_not_covered'));
    const tiny={...limits,maxTextCharacters:140};
    const bounded=await extractDocument(f,root,tiny);
    assert.equal(bounded.status,'text_limit','no silent 500-character/first-1000-line clipping');
    assert.equal(bounded.text,undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('XLSX independent XML formula/cache/note versus parsed dates, rich text and links',async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-coverage-xlsx-')));
  try{
    const f=path.join(root,'own.xlsx');
    const book=new (exceljsPackage.load().Workbook)();
    const ws=book.addWorksheet('Unicode_é_中文');
    ws.getCell('A1').value=new Date('2024-05-06T07:08:09.000Z');
    ws.getCell('A1').numFmt='yyyy-mm-dd hh:mm:ss';
    ws.getCell('A2').value={richText:[{text:'RICH_é_'},{text:'中文'}]};
    ws.getCell('A3').value={text:'LINK_LABEL_é_中文',hyperlink:'https://example.org/fixture?q=2'};
    ws.getCell('A4').value='NOTE_ANCHOR';
    ws.getCell('A4').note='NOTE_é_中文';
    ws.getCell('A5').value={formula:'A6*2',result:99}; // intentionally stale XML cache
    ws.getCell('A6').value=6;
    ws.getCell('A7').value={formula:'A6+1'};
    ws.getCell('A8').value={error:'#DIV/0!'};
    await writeFile(f,Uint8Array.from(await book.xlsx.writeBuffer()));
    const zip=new (pizzipPackage.load())(await readFile(f));
    const xml=zip.file('xl/worksheets/sheet1.xml')!.asText();
    assert.match(xml,/<f>A6\*2<\/f>/,'raw OOXML formula source');
    assert.match(xml,/<v>99<\/v>/,'independent XML stale cache, not calculated by HostDeck');
    const commentParts=Object.keys(zip.files).filter(x=>/^xl\/comments[1-9]\d*\.xml$/.test(x));
    assert.equal(commentParts.length,1,'ExcelJS must write its actual xl/comments1.xml-style part');
    const commentsXml=zip.file(commentParts[0])!.asText();
    assert.ok(commentsXml.includes('NOTE_é_中文'),'ZIP comment XML must contain fixture note');
    const r=await extractDocument(f,root,limits);
    assert.equal(r.status,'indexed');
    assert.equal(r.coverage,'partial');
    for(const fragment of ['2024-05-06','RICH_é_中文','LINK_LABEL_é_中文',
      'https://example.org/fixture?q=2','NOTE_é_中文',
      'Formula source: =A6*2','Cached result (not calculated): 99',
      'Formula source: =A6+1'])
      assert.ok(r.text?.includes(fragment),'qualified source field not searchable: '+fragment);
    assert.ok(r.limitations?.includes('formula_cache_missing'),'missing cache must not be calculated');
    assert.ok(r.limitations?.includes('xlsx_unsupported_cell_value'),
      'Excel error object must not become invented text or full-coverage PASS');
    assert.ok(!r.text?.includes('Cached result (not calculated): 7'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Office archive guard rejects unsafe XML and never returns partial indexed text',async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-coverage-unsafe-')));
  try{
    const f=path.join(root,'unsafe.docx');
    await new DocxFileHandler().write(f,'SOURCE_SAFE');
    const z=new (pizzipPackage.load())(await readFile(f));
    z.file('word/unsupported.xml','<!DOCTYPE foo [<!ENTITY injected "X">]><foo>&injected;</foo>');
    await writeFile(f,z.generate({type:'nodebuffer',compression:'DEFLATE'}));
    const r=await extractDocument(f,root,limits);
    assert.notEqual(r.status,'indexed');
    assert.equal(r.text,undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});
