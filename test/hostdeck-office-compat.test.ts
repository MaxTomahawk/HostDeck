import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DocumentAdapter } from '../src/hostdeck/documents.js';
import { replaceVisibleDocxXml } from '../src/hostdeck/office-xml.js';
import { isOpenpyxlCommentLayout } from '../src/hostdeck/office-xlsx.js';

const require = createRequire(import.meta.url);
const PizZip = require('pizzip');

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function fixture(components: Record<string, string>): Buffer {
  const zip = new PizZip();
  for (const [file, value] of Object.entries(components)) zip.file(file, value);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function uncompressedArchive(zipBytes: Uint8Array): Map<string, string> {
  const zip = new PizZip(zipBytes);
  return new Map(Object.keys(zip.files).filter(name => !zip.files[name].dir)
    .map(name => [name, sha(zip.file(name).asUint8Array())]));
}

const bodyXml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>😀 SPLIT_</w:t></w:r>' +
  '<w:r><w:rPr><w:i/></w:rPr><w:t>TARGET</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>KEEP</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>ONE</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>TWO</w:t></w:r></w:p>' +
  '<w:p><w:fldSimple w:instr="PRINTDATE"><w:r><w:t>FIELD_TARGET</w:t></w:r></w:fldSimple></w:p>' +
  '</w:body></w:document>';
const headerXml = '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:p><w:r><w:t>HEADER_TARGET</w:t></w:r></w:p></w:hdr>';
const footerXml = '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:p><w:r><w:t>FOOTER_TARGET</w:t></w:r></w:p></w:ftr>';
const docxParts = {
  '[Content_Types].xml': '<Types/>',
  '_rels/.rels': '<Relationships/>',
  'word/document.xml': bodyXml,
  'word/header1.xml': headerXml,
  'word/footer1.xml': footerXml,
  'word/media/image1.png': 'FIXTURE_IMAGE_BYTES_NOT_RENDERED',
  'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
};

test('run-spanning DOCX edit stays literal; first run style, emoji, all untouched ZIP parts preserved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-run-'));
  try {
    const input = path.join(root, 'multi.docx'), original = fixture(docxParts);
    await writeFile(input, original);
    const adapter = await DocumentAdapter.create({ workspace: root });
    const stage = await adapter.handle('hostdeck_edit_document', { path: input,
      change: { kind: 'text_replace', old_text: 'SPLIT_TARGET',
        new_text: 'A & <w:t> literal', expected_replacements: 1 } }) as { bytes: Uint8Array };
    assert.deepEqual(await readFile(input), original, 'original source remains byte-identical');
    const next = new PizZip(stage.bytes);
    const text = next.file('word/document.xml').asText();
    assert.match(text, /😀 A &amp; &lt;w:t&gt; literal/);
    assert.match(text, /<w:rPr><w:b\/><\/w:rPr>/, 'first run style kept');
    assert.match(text, /<w:rPr><w:i\/><\/w:rPr>/, 'second run style kept');
    assert.match(text, /<w:t><\/w:t>/, 'second text run retained empty, not dropped');
    assert.match(text, /<w:t>KEEP<\/w:t>/);
    assert.match(text, /FIELD_TARGET/, 'field result must not be edited');
    const before = uncompressedArchive(original), after = uncompressedArchive(stage.bytes);
    assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort());
    for (const [file, hash] of before) {
      if (file === 'word/document.xml') continue;
      assert.equal(after.get(file), hash, file + ' must remain unmodified');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DOCX global expected count checked before any staged changes; headers and footers supported', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-count-'));
  try {
    const input = path.join(root, 'content.docx'), original = fixture(docxParts);
    await writeFile(input, original);
    const adapter = await DocumentAdapter.create({ workspace: root });
    await assert.rejects(adapter.handle('hostdeck_edit_document', { path: input,
      change: { kind: 'text_replace', old_text: '_TARGET', new_text: '_REPLACED',
        expected_replacements: 1 } }), /Expected 1 occurrence\(s\) but found 3/);
    assert.deepEqual(await readFile(input), original);
    const result = await adapter.handle('hostdeck_edit_document', { path: input,
      change: { kind: 'text_replace', old_text: '_TARGET', new_text: '_REPLACED',
        expected_replacements: 3 } }) as { bytes: Uint8Array };
    const zip = new PizZip(result.bytes);
    assert.match(zip.file('word/document.xml').asText(), /SPLIT_REPLACED/);
    assert.match(zip.file('word/header1.xml').asText(), /HEADER_REPLACED/);
    assert.match(zip.file('word/footer1.xml').asText(), /FOOTER_REPLACED/);
    assert.deepEqual(await readFile(input), original);
    const read = await adapter.handle('hostdeck_read_document', { path: input }) as { content: string };
    assert.match(read.content, /hostdeck_edit_document/);
    assert.doesNotMatch(read.content, /edit_block|use start_process with a Python script/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DOCX never crosses paragraphs, tabs or field instructions; entity text is not markup', () => {
  assert.equal(replaceVisibleDocxXml(
    '<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p>',
    'AB', 'X').count, 0);
  assert.equal(replaceVisibleDocxXml(
    '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:tab/><w:t>B</w:t></w:r></w:p>',
    'AB', 'X').count, 0);
  assert.equal(replaceVisibleDocxXml(
    '<w:p><w:r><w:t>A</w:t></w:r><w:fldSimple w:instr="DATE"><w:r><w:t>B</w:t></w:r></w:fldSimple></w:p>',
    'AB', 'X').count, 0);
  const edited = replaceVisibleDocxXml('<w:p><w:r><w:t>X &amp; Y</w:t></w:r></w:p>',
    'X & Y', '<w:t> & emoji 😀');
  assert.equal(edited.count, 1);
  assert.match(edited.xml, /&lt;w:t&gt; &amp; emoji 😀/);
  assert.throws(() => replaceVisibleDocxXml('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///x">]><w:p/>',
    'x', 'y'), /DOCUMENT_UNSAFE_XML/);
});

const workbookXml = '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
const workbookRels = '<Relationships><Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
  'Target="/xl/worksheets/sheet1.xml"/></Relationships>';
const worksheetXml = '<?xml version="1.0"?><worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheetViews/><sheetData><row r="1">' +
  '<c r="A1" s="1" t="inlineStr"><is><t>ORIGINAL</t></is></c>' +
  '<c r="B1" s="1" t="n"><v>7</v></c>' +
  '<c r="C1"><f>B1*2</f><v></v></c><c r="D1"><f>B1+1</f><v>8</v></c>' +
  '</row></sheetData><legacyDrawing r:id="rIdC"/></worksheet>';
const workbookParts = {
  '[Content_Types].xml': '<Types/>',
  '_rels/.rels': '<Relationships/>',
  'xl/workbook.xml': workbookXml,
  'xl/_rels/workbook.xml.rels': workbookRels,
  'xl/worksheets/sheet1.xml': worksheetXml,
  'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships>' +
    '<Relationship Id="rIdComment" Target="/xl/comments/comment1.xml"/>' +
    '<Relationship Id="rIdC" Target="/xl/drawings/commentsDrawing1.vml"/></Relationships>',
  'xl/comments/comment1.xml': '<comments><commentList><comment ref="A1"><text><t>KEEP_NOTE</t></text></comment></commentList></comments>',
  'xl/drawings/commentsDrawing1.vml': '<xml><shape id="note1"/></xml>',
  'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf/><xf numFmtId="0"/></cellXfs></styleSheet>',
  'docProps/core.xml': '<coreProperties><creator>TEST</creator></coreProperties>',
};

test('openpyxl comment + VML ZIP survives targeted A1 edit; B1/C1/D1 and styles preserved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-notes-'));
  try {
    const input = path.join(root, 'commented.xlsx'), original = fixture(workbookParts);
    assert.equal(isOpenpyxlCommentLayout(original), true);
    await writeFile(input, original);
    const adapter = await DocumentAdapter.create({ workspace: root });
    const originalRead = await adapter.handle('hostdeck_read_document',
      { path: input, sheet: 'Sheet1', range: 'A1:D1' }) as { content: unknown[][] };
    assert.deepEqual(originalRead.content, [['ORIGINAL', 7,
      { formula: '=B1*2', calculated: false, cachedResultAvailable: false }, 8]]);
    const stage = await adapter.handle('hostdeck_edit_document', { path: input,
      change: { kind: 'table_range', sheet: 'Sheet1', range: 'A1',
        cells: [['CHANGED & <safe>']] } }) as { bytes: Uint8Array };
    assert.deepEqual(await readFile(input), original, 'staging never writes the original');
    const next = new PizZip(stage.bytes), before = uncompressedArchive(original), after = uncompressedArchive(stage.bytes);
    assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort());
    for (const [file, hash] of before) {
      if (file === 'xl/worksheets/sheet1.xml') continue;
      assert.equal(after.get(file), hash, 'preserve all other parts including note/VML/styles: ' + file);
    }
    const sheet = next.file('xl/worksheets/sheet1.xml').asText();
    assert.match(sheet, /CHANGED &amp; &lt;safe&gt;/);
    assert.match(sheet, /<c r="A1" s="1" t="inlineStr">/);
    assert.match(sheet, /<c r="B1" s="1" t="n"><v>7<\/v><\/c>/);
    assert.match(sheet, /<f>B1\*2<\/f><v><\/v>/);
    assert.match(sheet, /<f>B1\+1<\/f><v>8<\/v>/);
    const staged = path.join(root, 'staged.xlsx');
    await writeFile(staged, stage.bytes);
    const reRead = await adapter.handle('hostdeck_read_document',
      { path: staged, range: 'A1:D1' }) as { content: unknown[][] };
    assert.deepEqual(reRead.content, [['CHANGED & <safe>', 7,
      { formula: '=B1*2', calculated: false, cachedResultAvailable: false }, 8]]);
    await assert.rejects(adapter.handle('hostdeck_edit_document', { path: input,
      change: { kind: 'table_range', sheet: 'Sheet1', range: 'E1',
        cells: [['new']] } }), /XLSX_EXISTING_CELL_REQUIRED/);
    assert.deepEqual(await readFile(input), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ExcelJS 4.4.0 formula values distinguish missing caches from existing cached primitives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-formula-'));
  try {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.getCell('A1').value = 7;
    sheet.getCell('B1').value = { formula: 'A1*2' };
    sheet.getCell('C1').value = { formula: 'A1+1', result: 8 };
    const file = path.join(root, 'formulas.xlsx');
    await workbook.xlsx.writeFile(file);
    const adapter = await DocumentAdapter.create({ workspace: root });
    const read = await adapter.handle('hostdeck_read_document', {
      path: file, sheet: 'Sheet1', range: 'A1:C1'
    }) as { content: unknown[][] };
    assert.deepEqual(read.content, [[7,
      { formula: '=A1*2', calculated: false, cachedResultAvailable: false }, 8]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DOCX wrong root is rejected without changing source bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-invalid-root-'));
  try {
    const bytes = fixture({ ...docxParts,
      'word/document.xml': '<w:p><w:r><w:t>SPLIT_TARGET</w:t></w:r></w:p>' });
    const file = path.join(root, 'wrong-root.docx');
    await writeFile(file, bytes);
    const adapter = await DocumentAdapter.create({ workspace: root });
    await assert.rejects(adapter.handle('hostdeck_edit_document', { path: file,
      change: { kind: 'text_replace', old_text: 'SPLIT_TARGET',
        new_text: 'REPLACED', expected_replacements: 1 } }), /DOCUMENT_INVALID_DOCX/);
    assert.deepEqual(await readFile(file), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OOXML unsafe root/DTD guard rejects affected comment workbook with source retained', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-dtd-'));
  try {
    const evil = { ...workbookParts,
      'xl/workbook.xml': '<!DOCTYPE workbook [<!ENTITY data SYSTEM "file:///secrets">]>' + workbookXml };
    const file = path.join(root, 'unsafe.xlsx'), original = fixture(evil);
    await writeFile(file, original);
    const adapter = await DocumentAdapter.create({ workspace: root });
    await assert.rejects(adapter.handle('hostdeck_read_document', { path: file }), /DOCUMENT_UNSAFE_XML/);
    await assert.rejects(adapter.handle('hostdeck_edit_document', { path: file,
      change: { kind: 'table_range', sheet: 'Sheet1', range: 'A1', cells: [['test']] } }), /DOCUMENT_UNSAFE_XML/);
    assert.deepEqual(await readFile(file), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
