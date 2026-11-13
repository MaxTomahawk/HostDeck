import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DocumentAdapter} from '../src/hostdeck/documents.js';
import {DocxFileHandler} from '../src/utils/files/docx.js';
const require=createRequire(import.meta.url),Zip=require('pizzip'),Excel=require('exceljs');

test('DOCX visible text replacement spans styled runs, preserves other parts and counts all matches before staging',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-docx-runs-'));
 try{
  const file=path.join(root,'runs.docx');await new DocxFileHandler().write(file,'placeholder');
  const zip=new Zip(await readFile(file));
  const xml='<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>🙂 before SPLIT_</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>TARGET after &amp; tail</w:t></w:r></w:p><w:p><w:r><w:t>Unrelated text</w:t></w:r></w:p></w:body></w:document>';
  zip.file('word/document.xml',xml);zip.file('word/header1.xml','<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header unchanged</w:t></w:r></w:p></w:hdr>');
  await writeFile(file,zip.generate({type:'nodebuffer'}));const original=await readFile(file),adapter=await DocumentAdapter.create({workspace:root});
  await assert.rejects(adapter.handle('hostdeck_edit_document',{path:'runs.docx',change:{kind:'text_replace',old_text:'SPLIT_TARGET',new_text:'changed & safe',expected_replacements:2}}),/Expected 2 occurrence/);
  assert.deepEqual(await readFile(file),original);
  const staged=await adapter.handle('hostdeck_edit_document',{path:'runs.docx',change:{kind:'text_replace',old_text:'SPLIT_TARGET',new_text:'changed & safe',expected_replacements:1}}) as {bytes:Uint8Array};
  const edited=new Zip(staged.bytes),document=edited.file('word/document.xml').asText();
  assert.match(document,/<w:t[^>]*>🙂 before changed &amp; safe<\/w:t>/);assert.match(document,/<w:t[^>]*> after &amp; tail<\/w:t>/);
  assert.ok(document.includes('<w:rPr><w:i/></w:rPr>'));assert.ok(document.includes('<w:rPr><w:b/></w:rPr>'));
  for(const name of Object.keys(zip.files).filter(name=>!zip.files[name].dir&&name!=='word/document.xml'))assert.deepEqual(edited.file(name).asUint8Array(),zip.file(name).asUint8Array(),name);
  assert.deepEqual(await readFile(file),original);
  await writeFile(path.join(root,'edited.docx'),staged.bytes);
  const read=await adapter.handle('hostdeck_read_document',{path:'edited.docx'}) as {content:string};assert.match(read.content,/changed &amp; safe|changed & safe/);assert.doesNotMatch(read.content,/edit_block|use read_file/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('DOCX replacement treats XML-like input as literal visible text',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-docx-literal-'));
 try{
  const file=path.join(root,'literal.docx');await new DocxFileHandler().write(file,'One & two');const adapter=await DocumentAdapter.create({workspace:root});
  const staged=await adapter.handle('hostdeck_edit_document',{path:'literal.docx',change:{kind:'text_replace',old_text:'One & two',new_text:'<w:t>literal</w:t>',expected_replacements:1}}) as {bytes:Uint8Array};
  const xml=new Zip(staged.bytes).file('word/document.xml').asText();assert.ok(xml.includes('&lt;w:t&gt;literal&lt;/w:t&gt;'));assert.equal((xml.match(/<w:t[ >]/g)||[]).length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('XLSX comments with absolute openpyxl-style part targets read and survive staged cell edits',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-xlsx-comments-'));
 try{
  const book=new Excel.Workbook(),sheet=book.addWorksheet('Data');sheet.getCell('A1').value='original';sheet.getCell('B1').value=7;sheet.getCell('C1').value={formula:'B1*2'};sheet.getCell('D1').value={formula:'B1+1',result:8};sheet.getCell('B1').note='Comment é 中文';
  const zip=new Zip(await book.xlsx.writeBuffer());
  zip.file('xl/comments/comment1.xml',zip.file('xl/comments1.xml').asUint8Array());zip.remove('xl/comments1.xml');
  zip.file('xl/drawings/commentsDrawing1.vml',zip.file('xl/drawings/vmlDrawing1.vml').asUint8Array());zip.remove('xl/drawings/vmlDrawing1.vml');
  const rel='xl/worksheets/_rels/sheet1.xml.rels';zip.file(rel,zip.file(rel).asText().replace('../comments1.xml','/xl/comments/comment1.xml').replace('../drawings/vmlDrawing1.vml','/xl/drawings/commentsDrawing1.vml'));
  zip.file('[Content_Types].xml',zip.file('[Content_Types].xml').asText().replace('/xl/comments1.xml','/xl/comments/comment1.xml'));
  const file=path.join(root,'comments.xlsx');await writeFile(file,zip.generate({type:'nodebuffer'}));const original=await readFile(file),adapter=await DocumentAdapter.create({workspace:root});
  const read=await adapter.handle('hostdeck_read_document',{path:'comments.xlsx'}) as {content:any[][]};
  assert.equal(read.content[0][0],'original');assert.deepEqual(read.content[0][2],{formula:'=B1*2',calculated:false,cachedResultAvailable:false});assert.equal(read.content[0][3],8);
  const staged=await adapter.handle('hostdeck_edit_document',{path:'comments.xlsx',change:{kind:'table_range',sheet:'Data',range:'A1',cells:[['changed']]}}) as {bytes:Uint8Array};
  const edited=new Zip(staged.bytes);for(const name of ['xl/comments/comment1.xml','xl/drawings/commentsDrawing1.vml'])assert.deepEqual(edited.file(name).asUint8Array(),zip.file(name).asUint8Array(),name);
  assert.deepEqual(await readFile(file),original);await writeFile(path.join(root,'edited.xlsx'),staged.bytes);
  assert.equal((await adapter.handle('hostdeck_read_document',{path:'edited.xlsx'}) as {content:any[][]}).content[0][0],'changed');
 }finally{await rm(root,{recursive:true,force:true});}
});
