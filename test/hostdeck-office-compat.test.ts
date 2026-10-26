import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DocumentAdapter } from '../src/hostdeck/documents.js';
import { replaceVisibleDocxXml, validateOfficeStructure } from '../src/hostdeck/office-xml.js';
import { isOpenpyxlCommentLayout } from '../src/hostdeck/office-xlsx.js';
import { publicError } from '../src/hostdeck/gateway.js';

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
        expected_replacements: 1 } }), (error: unknown) => {
      assert.match((error as Error).message, /Expected 1 occurrence\(s\) but found 3/);
      assert.equal(publicError(error), 'DOCUMENT_REPLACEMENT_COUNT');
      return true;
    });
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
    assert.match(read.content, /DOCX Outline:/);
    assert.match(read.content, /SPLIT_/);
    assert.match(read.content, /Headers\/Footers:/);
    assert.match(read.content, /HEADER_TARGET/);
    assert.match(read.content, /FOOTER_TARGET/);
    assert.doesNotMatch(read.content, /Edit with: edit_block\(/);
    assert.doesNotMatch(read.content, /Raw XML: use read_file with offset=1/);
    assert.doesNotMatch(read.content, /For bulk changes:|use start_process with a Python script/);
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

const workbookXml = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
const workbookRels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
  'Target="/xl/worksheets/sheet1.xml"/></Relationships>';
const worksheetXml = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
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
  'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
    '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
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

test('openpyxl-style date serial uses custom number format; numeric cells remain numbers and ZIP parts stable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-date-'));
  try {
    const dateRow = '<row r="2"><c r="A2" s="1" t="n"><v>46024</v></c>' +
      '<c r="B2" s="0" t="n"><v>19.5</v></c></row>';
    const document = worksheetXml.replace('</sheetData>', dateRow + '</sheetData>');
    const input = fixture({ ...workbookParts, 'xl/worksheets/sheet1.xml': document });
    const file = path.join(root, 'date.xlsx');
    await writeFile(file, input);
    const adapter = await DocumentAdapter.create({ workspace: root });
    const read = await adapter.handle('hostdeck_read_document', {
      path: file, sheet: 'Sheet1', range: 'A2:B2'
    }) as { content: unknown[][] };
    assert.deepEqual(read.content, [['2026-01-02T00:00:00.000Z', 19.5]]);
    const staged = await adapter.handle('hostdeck_edit_document', {
      path: file, change: { kind: 'table_range', sheet: 'Sheet1', range: 'A1', cells: [['EDITED']] }
    }) as { bytes: Uint8Array };
    assert.deepEqual(await readFile(file), input);
    const originalZip = uncompressedArchive(input), updatedZip = uncompressedArchive(staged.bytes);
    for (const [entry, hash] of originalZip) {
      if (entry !== 'xl/worksheets/sheet1.xml') assert.equal(updatedZip.get(entry), hash, entry);
    }
    const updated = new PizZip(staged.bytes).file('xl/worksheets/sheet1.xml').asText();
    assert.match(updated, /<c r="A2" s="1" t="n"><v>46024<\/v><\/c>/);
    assert.match(updated, /<c r="B2" s="0" t="n"><v>19\.5<\/v><\/c>/);
    const stagedPath = path.join(root, 'dated-staged.xlsx');
    await writeFile(stagedPath, staged.bytes);
    const readBack = await adapter.handle('hostdeck_read_document', {
      path: stagedPath, sheet: 'Sheet1', range: 'A2:B2'
    }) as { content: unknown[][] };
    assert.deepEqual(readBack.content, [['2026-01-02T00:00:00.000Z', 19.5]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('openpyxl date1904 correctly shifts epoch without changing date-typed response or normal numbers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-date1904-'));
  try {
    const book = workbookXml.replace('<sheets>', '<workbookPr date1904="1"/><sheets>');
    const dateRow = '<row r="2"><c r="A2" s="1" t="n"><v>44562</v></c>' +
      '<c r="B2" s="0" t="n"><v>42</v></c></row>';
    const document = worksheetXml.replace('</sheetData>', dateRow + '</sheetData>');
    const bytes = fixture({ ...workbookParts, 'xl/workbook.xml': book,
      'xl/worksheets/sheet1.xml': document });
    const file = path.join(root, 'date1904.xlsx');
    await writeFile(file, bytes);
    const adapter = await DocumentAdapter.create({ workspace: root });
    const read = await adapter.handle('hostdeck_read_document', {
      path: file, sheet: 'Sheet1', range: 'A2:B2'
    }) as { content: unknown[][] };
    assert.deepEqual(read.content, [['2026-01-02T00:00:00.000Z', 42]]);
    assert.deepEqual(await readFile(file), bytes);
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
      'word/document.xml': '<other xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SPLIT_TARGET</w:t></w:r></w:p></w:body></w:document></other>' });
    const file = path.join(root, 'wrong-root.docx');
    await writeFile(file, bytes);
    const adapter = await DocumentAdapter.create({ workspace: root });
    await assert.rejects(adapter.handle('hostdeck_edit_document', { path: file,
      change: { kind: 'text_replace', old_text: 'SPLIT_TARGET',
        new_text: 'REPLACED', expected_replacements: 1 } }), /DOCUMENT_INVALID_XML_ROOT_OR_NAMESPACE/);
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


test('Word namespace spoof and nested lookalike root never stage edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-ns-'));
  try {
    const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const invalidDocuments = [
      '<w:document xmlns:w="urn:unrelated"><w:body><w:p><w:r><w:t>SPLIT_TARGET</w:t></w:r></w:p></w:body></w:document>',
      '<w:document xmlns:w="' + ns + '"><w:body><w:p xmlns:w="urn:unrelated"><w:r><w:t>SPLIT_TARGET</w:t></w:r></w:p></w:body></w:document>',
      '<outer xmlns:w="' + ns + '"><w:document><w:body><w:p><w:r><w:t>SPLIT_TARGET</w:t></w:r></w:p></w:body></w:document></outer>',
      '<w:document xmlns:w="' + ns + '"><w:body><w:document><w:body><w:p><w:r><w:t>SPLIT_TARGET</w:t></w:r></w:p></w:body></w:document></w:body></w:document>',
    ];
    const adapter = await DocumentAdapter.create({ workspace: root });
    for (let i = 0; i < invalidDocuments.length; i++) {
      const before = fixture({ ...docxParts, 'word/document.xml': invalidDocuments[i] });
      const file = path.join(root, 'invalid-' + i + '.docx');
      await writeFile(file, before);
      await assert.rejects(adapter.handle('hostdeck_edit_document', { path: file,
        change: { kind: 'text_replace', old_text: 'SPLIT_TARGET',
          new_text: 'REPLACED', expected_replacements: 1 } }), /DOCUMENT_INVALID_XML_(?:ROOT_OR_NAMESPACE|NAMESPACE|NESTING)/);
      assert.deepEqual(await readFile(file), before, 'source must be unchanged on namespace rejection');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DOCX xml:space default becomes preserve for leading/trailing literal whitespace', async () => {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const xml = '<w:document xmlns:w="' + ns + '"><w:body>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="default">SPACE_MARKER</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  validateOfficeStructure(xml, 'document');
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-space-'));
  try {
    const original = fixture({ ...docxParts, 'word/document.xml': xml });
    const file = path.join(root, 'space.docx');
    await writeFile(file, original);
    const adapter = await DocumentAdapter.create({ workspace: root });
    const staged = await adapter.handle('hostdeck_edit_document', { path: file,
      change: { kind: 'text_replace', old_text: 'SPACE_MARKER', new_text: ' spaced ',
        expected_replacements: 1 } }) as { bytes: Uint8Array };
    const result = new PizZip(staged.bytes).file('word/document.xml').asText();
    assert.match(result, /<w:t xml:space="preserve"> spaced <\/w:t>/);
    assert.match(result, /<w:rPr><w:b\/><\/w:rPr>/);
    assert.deepEqual(await readFile(file), original);
    const prior = uncompressedArchive(original), after = uncompressedArchive(staged.bytes);
    for (const [part, hash] of prior) {
      if (part !== 'word/document.xml') assert.equal(after.get(part), hash, part);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workbook, worksheet and relationship namespace lookalikes fail closed on reads and edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-xlsx-ns-'));
  const alias = 'urn:unrelated';
  try {
    const cases: Array<{ name: string; parts: Record<string, string> }> = [
      { name: 'wrong-workbook-root', parts: {
        ...workbookParts, 'xl/workbook.xml': workbookXml.replace(
          'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="' + alias + '"') } },
      { name: 'nested-workbook', parts: { ...workbookParts,
        'xl/workbook.xml': '<outer>' + workbookXml.replace('<?xml version="1.0"?>', '') + '</outer>' } },
      { name: 'wrong-worksheet-root', parts: {
        ...workbookParts, 'xl/worksheets/sheet1.xml': worksheetXml.replace(
          'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="' + alias + '"') } },
      { name: 'nested-worksheet', parts: {
        ...workbookParts, 'xl/worksheets/sheet1.xml':
          '<outer>' + worksheetXml.replace('<?xml version="1.0"?>', '') + '</outer>' } },
      { name: 'nested-worksheet-inside-valid-root', parts: { ...workbookParts,
        'xl/worksheets/sheet1.xml': worksheetXml.replace('<sheetViews/>',
          '<worksheet><sheetData/></worksheet><sheetViews/>') } },
      { name: 'wrong-relationship-root', parts: { ...workbookParts,
        'xl/_rels/workbook.xml.rels': workbookRels.replace(
          'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"', 'xmlns="' + alias + '"') } },
      { name: 'fake-cell-namespace', parts: { ...workbookParts,
        'xl/worksheets/sheet1.xml': worksheetXml.replace('<c r="A1"', '<c xmlns="' + alias + '" r="A1"') } },
      { name: 'fake-sheet-namespace', parts: { ...workbookParts,
        'xl/workbook.xml': workbookXml.replace('<sheet name="Sheet1"', '<sheet xmlns="' + alias + '" name="Sheet1"') } },
    ];
    const adapter = await DocumentAdapter.create({ workspace: root });
    for (const { name, parts } of cases) {
      const file = path.join(root, name + '.xlsx'), original = fixture(parts);
      await writeFile(file, original);
      await assert.rejects(adapter.handle('hostdeck_read_document', { path: file }),
        /DOCUMENT_INVALID_XML_(?:ROOT_OR_NAMESPACE|NAMESPACE|NESTING)/, name + ' read');
      await assert.rejects(adapter.handle('hostdeck_edit_document', { path: file,
        change: { kind: 'table_range', sheet: 'Sheet1', range: 'A1',
          cells: [['CHANGED']] } }), /DOCUMENT_INVALID_XML_(?:ROOT_OR_NAMESPACE|NAMESPACE|NESTING)/, name + ' edit');
      assert.deepEqual(await readFile(file), original, name + ' source unchanged');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared and array formula targets are rejected before staging, but unrelated A1 preserves groups', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-office-formula-group-'));
  try {
    const grouped = worksheetXml.replace(
      '<c r="C1"><f>B1*2</f><v></v></c>',
      '<c r="C1"><f t="shared" si="4" ref="C1:C2">B1*2</f><v/></c>'
    ).replace(
      '</row></sheetData>',
      '</row><row r="2"><c r="C2"><f t="shared" si="4"/><v/></c></row></sheetData>'
    );
    const parts = { ...workbookParts, 'xl/worksheets/sheet1.xml': grouped };
    const original = fixture(parts), file = path.join(root, 'shared.xlsx');
    await writeFile(file, original);
    const adapter = await DocumentAdapter.create({ workspace: root });
    const read = await adapter.handle('hostdeck_read_document', {
      path: file, sheet: 'Sheet1', range: 'C1:C2'
    }) as { content: unknown[][] };
    const master = read.content[0][0] as Record<string, unknown>;
    const dependent = read.content[1][0] as Record<string, unknown>;
    assert.equal(master.status, 'UNSUPPORTED_FORMULA_GROUP');
    assert.equal(master.formulaType, 'shared');
    assert.equal(master.formula, '=B1*2');
    assert.equal(dependent.status, 'UNSUPPORTED_FORMULA_GROUP');
    assert.equal(dependent.formulaType, 'shared');
    assert.equal(dependent.formula, null);
    for (const target of ['C1', 'C2']) {
      await assert.rejects(adapter.handle('hostdeck_edit_document', { path: file,
        change: { kind: 'table_range', sheet: 'Sheet1', range: target, cells: [['broken']] } }),
        /XLSX_FORMULA_GROUP_EDIT_UNSUPPORTED/, target);
      assert.deepEqual(await readFile(file), original);
    }
    const staged = await adapter.handle('hostdeck_edit_document', { path: file,
      change: { kind: 'table_range', sheet: 'Sheet1', range: 'A1', cells: [['CHANGED']] } }) as { bytes: Uint8Array };
    const after = new PizZip(staged.bytes);
    const xml = after.file('xl/worksheets/sheet1.xml').asText();
    assert.match(xml, /<f t="shared" si="4" ref="C1:C2">B1\*2<\/f><v\/>/);
    assert.match(xml, /<c r="C2"><f t="shared" si="4"\/><v\/><\/c>/);
    const oldHashes = uncompressedArchive(original), newHashes = uncompressedArchive(staged.bytes);
    for (const [part, hash] of oldHashes) {
      if (part !== 'xl/worksheets/sheet1.xml') assert.equal(newHashes.get(part), hash, part);
    }
    assert.deepEqual(await readFile(file), original);
    const arrayParts = { ...workbookParts,
      'xl/worksheets/sheet1.xml': worksheetXml.replace('<f>B1*2</f>', '<f t="array" ref="C1:C2">B1*2</f>') };
    const arrayFile = path.join(root, 'array.xlsx');
    const arrayOriginal = fixture(arrayParts);
    await writeFile(arrayFile, arrayOriginal);
    await assert.rejects(adapter.handle('hostdeck_edit_document', { path: arrayFile,
      change: { kind: 'table_range', sheet: 'Sheet1', range: 'C1', cells: [['broken']] } }),
      /XLSX_FORMULA_GROUP_EDIT_UNSUPPORTED/);
    assert.deepEqual(await readFile(arrayFile), arrayOriginal);
  } finally { await rm(root, { recursive: true, force: true }); }
});
