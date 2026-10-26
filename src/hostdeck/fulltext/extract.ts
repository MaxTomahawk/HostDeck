import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DocumentAdapter } from '../documents.js';
import { exceljsPackage } from '../../utils/files/excel.js';
import type { DocumentCoverage, FullTextBudgets, FullTextFormat } from './types.js';

const textFormats = new Set<FullTextFormat>(['.txt','.md','.csv','.json']);
const fullTextFormats = new Set<FullTextFormat>(['.txt','.md','.csv','.json','.docx','.xlsx','.pdf']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface ExtractedDocument {
  status: DocumentCoverage;
  format: FullTextFormat;
  bytes: number;
  sha256: string;
  /** Never populated on an unqualified or incomplete extraction. */
  text?: string;
}

function checkedText(value: string, budgets: FullTextBudgets): string {
  if (value.length > budgets.maxTextCharacters) throw new Error('FULLTEXT_TEXT_LIMIT');
  if (!value.trim()) throw new Error('FULLTEXT_OCR_REQUIRED');
  if (value.includes('\0')) throw new Error('FULLTEXT_BINARY_TEXT');
  return value.normalize('NFC');
}

/**
 * A deliberately narrow extraction adapter. Source DOCX/PDF parsing is reused
 * only on bounded, explicitly selected files; no new Office edit semantics.
 *
 * DOCX: existing safe archive validation/outline; complex drawings remain a
 * partial feature. XLSX: exact primitive values of all sheets; formulas,
 * comments-without-values and rich/opaque cells are NOT treated as proven text.
 * PDF: unpdf output known to reverse Arabic presentation glyphs; skip the
 * whole document when RTL/Arabic is present instead of corrupting an index.
 */
export async function extractDocument(file: string, root: string, budgets: FullTextBudgets): Promise<ExtractedDocument> {
  const format = path.extname(file).toLowerCase() as FullTextFormat;
  if (!fullTextFormats.has(format)) throw new Error('FULLTEXT_FORMAT_UNSUPPORTED');
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error('FULLTEXT_NOT_FILE');
  if (st.size > budgets.maxFileBytes) return { status:'size_limit', format, bytes:st.size, sha256:'' };
  const input = await fs.readFile(file);
  const sha256 = createHash('sha256').update(input).digest('hex');
  const base = { format, bytes:input.length, sha256 };
  let text: string;
  try {
    if (textFormats.has(format)) {
      try { text = utf8.decode(input); }
      catch { return { ...base, status:'invalid_utf8' }; }
    } else if (format === '.xlsx') {
      // ExcelJS is already a HostDeck dependency. Retain ALL sheet names and
      // primitive values, not just the existing read_document's first 1000 rows.
      // Reuse the existing HostDeck ZIP/container security checks before
      // using ExcelJS's all-sheets traversal. This is a read, not an edit.
      const checked = await DocumentAdapter.create({ workspace: root });
      await checked.handle('hostdeck_read_document', { path: file });
      const workbook = new (exceljsPackage.load().Workbook)();
      await workbook.xlsx.load(input);
      const values: string[] = [];
      let count = 0;
      for (const sheet of workbook.worksheets) {
        values.push('Sheet: ' + sheet.name);
        sheet.eachRow({ includeEmpty:false }, row => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty:false }, cell => {
            const value = cell.value;
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
              cells.push(String(value));
            } else if (value === null || value === undefined) {
              // Empty cells do not contain searchable text.
            } else {
              // Formula result, richText, hyperlinks, comments or dates cannot
              // be asserted accurate without a separate format qualification.
              throw new Error('FULLTEXT_UNSUPPORTED_OFFICE_VALUE');
            }
            count++;
            if (count > 50_000) throw new Error('FULLTEXT_TEXT_LIMIT');
          });
          values.push(cells.join('\t'));
          if (values.join('\n').length > budgets.maxTextCharacters) throw new Error('FULLTEXT_TEXT_LIMIT');
        });
      }
      text = values.join('\n');
    } else {
      const document = await DocumentAdapter.create({ workspace: root });
      const response = await document.handle('hostdeck_read_document', { path: file }) as {
        content?: unknown;
        metadata?: Record<string, unknown>;
      };
      if (format === '.docx') {
        if (typeof response.content !== 'string' || !response.content.includes('DOCX Outline:'))
          throw new Error('FULLTEXT_UNQUALIFIED_OFFICE_RESULT');
        text = response.content;
      } else {
        if (!Array.isArray(response.content) || response.content.some(
          item => !item || typeof item !== 'object' || typeof (item as {text?:unknown}).text !== 'string'))
          throw new Error('FULLTEXT_UNQUALIFIED_PDF_RESULT');
        text = (response.content as Array<{text:string}>).map(item => item.text).join('\n');
        // Independently reproduced failure: logical Arabic becomes reversed
        // presentation glyphs before unpdf concatenates page text.
        if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(text))
          return { ...base, status:'pdf_rtl_unqualified' };
        if (!text.trim()) return { ...base, status:'ocr_required' };
      }
    }
    text = checkedText(text, budgets);
    // Verify the source did not change during the parser's second read. A
    // rename/rewrite with unchanged length or mtime must not pass silently.
    const current = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    if (current !== sha256) throw new Error('FULLTEXT_SOURCE_CHANGED');
    return { ...base, status:'indexed', text };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'FULLTEXT_SOURCE_CHANGED') throw error; // caller retries safely
    if (code === 'FULLTEXT_UNSUPPORTED_OFFICE_VALUE' || code === 'FULLTEXT_UNQUALIFIED_OFFICE_RESULT')
      return { ...base, status:'unsupported_office_value' };
    if (code === 'FULLTEXT_TEXT_LIMIT') return { ...base, status:'text_limit' };
    if (code === 'FULLTEXT_OCR_REQUIRED') return { ...base, status:'ocr_required' };
    return { ...base, status:'extraction_failed' };
  }
}
