import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DocumentAdapter } from '../src/hostdeck/documents.js';
import { DocxFileHandler } from '../src/utils/files/docx.js';
import { ExcelFileHandler } from '../src/utils/files/excel.js';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('pdf-lib');

test('reads DOCX, XLSX and exact PDF pages; edits stage bytes without mutating source', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-documents-test-'));
  const docxPath = path.join(workspace, 'sample.docx');
  const xlsxPath = path.join(workspace, 'sample.xlsx');
  const pdfPath = path.join(workspace, 'sample.pdf');
  try {
    await new DocxFileHandler().write(docxPath, 'Hello & world');
    await new ExcelFileHandler().write(xlsxPath, JSON.stringify([["Name", "Count"], ["apples", 3]]));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const text of ['Page one marker', 'Page two marker']) pdf.addPage().drawText(text, { x: 40, y: 700, font });
    await (await import('node:fs/promises')).writeFile(pdfPath, await pdf.save());

    const adapter = await DocumentAdapter.create({ workspace });
    const doc = await adapter.handle('hostdeck_read_document', { path: docxPath }) as { content: string };
    assert.match(doc.content, /Hello &amp; world|Hello & world/);
    assert.match((await adapter.handle('hostdeck_read_document', { path: 'sample.docx' }) as { content: string }).content, /Hello &amp; world|Hello & world/);
    const sheet = await adapter.handle('hostdeck_read_document', { path: xlsxPath }) as { content: unknown };
    assert.deepEqual(sheet.content, [["Name", "Count"], ["apples", 3]]);
    const pages = await adapter.handle('hostdeck_read_document', { path: pdfPath, page_indexes: [1] }) as { content: Array<{ page_index: number; text: string }> };
    assert.equal(pages.content.length, 1);
    assert.equal(pages.content[0].page_index, 1);
    assert.match(pages.content[0].text, /Page two marker/);

    const originalDocx = await readFile(docxPath);
    await assert.rejects(adapter.handle('hostdeck_edit_document', { path: docxPath, change: { kind: 'text_replace', old_text: 'Hello', new_text: 'Changed', expected_replacements: 2 } }), /Expected 2 occurrence/);
    assert.deepEqual(await readFile(docxPath), originalDocx);
    const edited = await adapter.handle('hostdeck_edit_document', { path: docxPath, change: { kind: 'text_replace', old_text: 'Hello', new_text: 'Changed & safe', expected_replacements: 1 } }) as { destination: string; bytes: Uint8Array };
    assert.equal(await import('node:fs/promises').then(fs => fs.realpath(edited.destination)), await import('node:fs/promises').then(fs => fs.realpath(docxPath)));
    assert.notDeepEqual(edited.bytes, originalDocx);
    assert.deepEqual(await readFile(docxPath), originalDocx);
    const stagedDocx = path.join(workspace, 'staged.docx');
    await (await import('node:fs/promises')).writeFile(stagedDocx, edited.bytes);
    assert.match((await new DocxFileHandler().read(stagedDocx)).content as string, /Changed &amp; safe|Changed & safe/);

    const pdfEdit = await adapter.handle('hostdeck_edit_document', { path: pdfPath, change: { kind: 'pdf_delete_pages', page_indexes: [0] } }) as { bytes: Uint8Array };
    assert.equal((await PDFDocument.load(pdfEdit.bytes)).getPageCount(), 1);
    const inserted = await adapter.handle('hostdeck_edit_document', { path: 'sample.pdf', change: { kind: 'pdf_insert_file', source_path: 'sample.pdf', page_index: 1 } }) as { bytes: Uint8Array };
    assert.equal((await PDFDocument.load(inserted.bytes)).getPageCount(), 4);
    await assert.rejects(adapter.handle('hostdeck_edit_document', { path: pdfPath, change: { kind: 'pdf_delete_pages', page_indexes: [0, 0] } }), /PDF_PAGE_INDEX_OUT_OF_RANGE/);
    const created = await adapter.handle('hostdeck_write_pdf', { path: 'created.pdf', markdown: '# Safe title\n\nText' }) as { destination: string; bytes: Uint8Array };
    assert.equal((await PDFDocument.load(created.bytes)).getPageCount(), 1);
    assert.equal(await (await import('node:fs/promises')).stat(created.destination).then(() => true, () => false), false);
    await assert.rejects(adapter.handle('hostdeck_write_pdf', { path: path.join(workspace, 'unsafe.pdf'), markdown: 'x', options: { launch_options: { executablePath: 'unknown' } } }), /PDF_RENDER_OPTION_DENIED/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
