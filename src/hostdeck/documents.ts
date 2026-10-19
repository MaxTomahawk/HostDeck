import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ExcelFileHandler } from '../utils/files/excel.js';
import { DocxFileHandler, pizzipPackage } from '../utils/files/docx.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2048;
const MAX_PDF_PAGES = 2000;
const require = createRequire(import.meta.url);
const toolNames = ['hostdeck_read_document', 'hostdeck_edit_document', 'hostdeck_write_pdf'] as const;

export interface DocumentContext { ownerId?: string; deviceId?: string; executorId?: string; }
export interface StagedDocumentWrite { destination: string; bytes: Uint8Array; mimeType: string; }

function inWorkspace(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateZip(buffer: Buffer): void {
  const start = Math.max(0, buffer.length - 65_557);
  let end = -1;
  for (let i = buffer.length - 22; i >= start; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0 || end + 22 > buffer.length) throw new Error('DOCUMENT_INVALID_ARCHIVE');
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw new Error('DOCUMENT_MULTIDISK_ARCHIVE_DENIED');
  const entries = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  let cursor = buffer.readUInt32LE(end + 16);
  const centralEnd = cursor + centralSize;
  if (entries > MAX_ARCHIVE_ENTRIES || centralEnd > end || cursor > end) throw new Error('DOCUMENT_ARCHIVE_LIMIT');
  let uncompressed = 0;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('DOCUMENT_INVALID_ARCHIVE');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength).replace(/\\/g, '/');
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) throw new Error('DOCUMENT_ARCHIVE_FEATURE_DENIED');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new Error('DOCUMENT_ARCHIVE_PATH_DENIED');
    if (expanded > 8 * 1024 * 1024 || (compressed === 0 ? expanded > 0 : expanded / compressed > 150)) throw new Error('DOCUMENT_ARCHIVE_EXPANSION_LIMIT');
    uncompressed += expanded;
    if (uncompressed > MAX_ARCHIVE_BYTES) throw new Error('DOCUMENT_ARCHIVE_EXPANSION_LIMIT');
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralEnd) throw new Error('DOCUMENT_INVALID_ARCHIVE');
}

async function checkOfficeArchive(file: string, extension: '.docx' | '.xlsx'): Promise<Buffer> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('DOCUMENT_FILE_LIMIT');
  const buffer = await fs.readFile(file);
  validateZip(buffer);
  if (extension === '.docx') {
    const zip = new (pizzipPackage.load())(buffer);
    const xmlEntries = Object.keys(zip.files).filter(name => name.endsWith('.xml') || name.endsWith('.rels'));
    let xmlBytes = 0;
    for (const name of xmlEntries) {
      const entry = zip.file(name);
      if (!entry) continue;
      const text = entry.asText();
      xmlBytes += Buffer.byteLength(text);
      if (xmlBytes > MAX_ARCHIVE_BYTES || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCUMENT_UNSAFE_XML');
    }
    if (!zip.file('word/document.xml')) throw new Error('DOCUMENT_INVALID_DOCX');
  }
  return buffer;
}

function pdfLibrary(): { PDFDocument: any; StandardFonts: Record<string, string> } {
  return require('pdf-lib');
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safePdfOptions(value: unknown): { page_size: 'A4' | 'Letter' | 'Legal'; landscape: boolean } {
  if (value === undefined) return { page_size: 'A4', landscape: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PDF_OPTIONS_INVALID');
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => !['page_size', 'landscape', 'print_background'].includes(key))) throw new Error('PDF_RENDER_OPTION_DENIED');
  if (options.page_size !== undefined && !['A4', 'Letter', 'Legal'].includes(String(options.page_size))) throw new Error('PDF_OPTIONS_INVALID');
  if (options.landscape !== undefined && typeof options.landscape !== 'boolean') throw new Error('PDF_OPTIONS_INVALID');
  if (options.print_background !== undefined && typeof options.print_background !== 'boolean') throw new Error('PDF_OPTIONS_INVALID');
  return { page_size: (options.page_size ?? 'A4') as 'A4' | 'Letter' | 'Legal', landscape: options.landscape === true };
}

async function createMarkdownPdf(markdown: string, value: unknown): Promise<Uint8Array> {
  const options = safePdfOptions(value);
  const { PDFDocument, StandardFonts } = pdfLibrary();
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  let size: [number, number] = options.page_size === 'Letter' ? [612, 792] : options.page_size === 'Legal' ? [612, 1008] : [595.28, 841.89];
  if (options.landscape) size = [size[1], size[0]];
  const margin = 48;
  const clean = (text: string) => text.normalize('NFKD').replace(/[^\x09\x0a\x0d\x20-\xff]/g, '?');
  const rows = markdown.split(/\r?\n/).map(raw => {
    const match = /^(#{1,6})\s+(.*)$/.exec(raw);
    return { text: clean(match ? match[2] : raw.replace(/^\s*[-*+]\s+/, '• ')), heading: !!match };
  });
  let page = document.addPage(size);
  let y = size[1] - margin;
  for (const row of rows) {
    const fontSize = row.heading ? 18 : 11;
    const font = row.heading ? bold : regular;
    const available = size[0] - margin * 2;
    const words = row.text.split(/\s+/);
    let line = '';
    const lines: string[] = [];
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, fontSize) > available) { lines.push(line); line = word; }
      else line = candidate;
    }
    if (line) lines.push(line);
    if (lines.length === 0) lines.push('');
    for (const lineText of lines) {
      if (y < margin + fontSize) { page = document.addPage(size); y = size[1] - margin; }
      if (lineText) page.drawText(lineText, { x: margin, y, size: fontSize, font });
      y -= fontSize + 5;
    }
    y -= row.heading ? 6 : 2;
  }
  return document.save({ useObjectStreams: false });
}

export class DocumentAdapter {
  readonly implementedTools = new Set<string>(toolNames);
  private constructor(private readonly workspace: string) {}

  static async create(options: { workspace: string }): Promise<DocumentAdapter> {
    if (!path.isAbsolute(options.workspace)) throw new Error('DOCUMENT_WORKSPACE_MUST_BE_ABSOLUTE');
    await fs.mkdir(options.workspace, { recursive: true });
    return new DocumentAdapter(await fs.realpath(options.workspace));
  }

  private resolveInputPath(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('DOCUMENT_PATH_INVALID');
    return path.resolve(path.isAbsolute(value) ? value : path.join(this.workspace, value));
  }

  private async checkParents(absolute: string): Promise<void> {
    const relative = path.relative(this.workspace, path.dirname(absolute));
    let cursor = this.workspace;
    for (const part of relative ? relative.split(path.sep) : []) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('DOCUMENT_REPARSE_POINT_DENIED');
      if (!stat.isDirectory()) throw new Error('DOCUMENT_PARENT_NOT_DIRECTORY');
    }
  }

  private async rejectPathLinks(absolute: string): Promise<void> {
    const parsed = path.parse(absolute);
    let cursor = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('DOCUMENT_REPARSE_POINT_DENIED');
    }
  }

  private async input(value: unknown): Promise<string> {
    const absolute = this.resolveInputPath(value);
    await this.rejectPathLinks(absolute);
    const resolved = await fs.realpath(absolute);
    if (!inWorkspace(this.workspace, resolved)) throw new Error('DOCUMENT_PATH_OUTSIDE_WORKSPACE');
    if (path.relative(this.workspace, resolved).split(path.sep).some(part => part.includes(':'))) throw new Error('DOCUMENT_ALTERNATE_STREAM_DENIED');
    await this.checkParents(resolved);
    const entry = await fs.lstat(resolved);
    if (entry.isSymbolicLink()) throw new Error('DOCUMENT_REPARSE_POINT_DENIED');
    if (!entry.isFile()) throw new Error('DOCUMENT_NOT_A_FILE');
    return resolved;
  }

  private async output(value: unknown, allowExisting: boolean): Promise<string> {
    const absolute = this.resolveInputPath(value);
    await this.rejectPathLinks(path.dirname(absolute));
    const parent = await fs.realpath(path.dirname(absolute));
    if (!inWorkspace(this.workspace, parent)) throw new Error('DOCUMENT_PATH_OUTSIDE_WORKSPACE');
    if (path.relative(this.workspace, parent).split(path.sep).some(part => part.includes(':'))) throw new Error('DOCUMENT_ALTERNATE_STREAM_DENIED');
    const resolved = path.join(parent, path.basename(absolute));
    if (!allowExisting) {
      try { await fs.lstat(resolved); throw new Error('DOCUMENT_DESTINATION_EXISTS'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } else {
      try {
        const targetStat = await fs.lstat(resolved);
        if (targetStat.isSymbolicLink()) throw new Error('DOCUMENT_REPARSE_POINT_DENIED');
        const target = await fs.realpath(resolved);
        if (!inWorkspace(this.workspace, target) || target !== resolved) throw new Error('DOCUMENT_PATH_OUTSIDE_WORKSPACE');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return resolved;
  }

  async handle(name: string, args: Record<string, unknown>, _context?: DocumentContext): Promise<unknown> {
    if (!this.implementedTools.has(name)) throw new Error('UNKNOWN_DOCUMENT_OPERATION');
    if (name === 'hostdeck_read_document') return this.read(args);
    if (name === 'hostdeck_edit_document') return this.edit(args);
    return this.writePdf(args);
  }

  private async read(args: Record<string, unknown>): Promise<unknown> {
    const file = await this.input(args.path);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.docx') {
      await checkOfficeArchive(file, '.docx');
      const result = await new DocxFileHandler().read(file, { offset: 0, length: 1000 });
      if (result.content.length > 2_000_000) throw new Error('DOCUMENT_READ_LIMIT');
      return { content: result.content, mimeType: 'text/plain', metadata: result.metadata };
    }
    if (ext === '.xlsx' || ext === '.xlsm') {
      const buffer = await checkOfficeArchive(file, '.xlsx');
      const result = await new ExcelFileHandler().read(file, { sheet: args.sheet as string | undefined, range: args.range as string | undefined, offset: 0, length: 1000 });
      const raw = String(result.content);
      const split = raw.lastIndexOf('\n\n');
      if (split < 0) throw new Error('DOCUMENT_READ_FAILED');
      let data: unknown;
      try { data = JSON.parse(raw.slice(split + 2)); } catch { throw new Error('DOCUMENT_READ_FAILED'); }
      return { content: data, mimeType: 'application/json', metadata: { ...result.metadata, fileSize: buffer.length } };
    }
    if (ext === '.pdf') {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) throw new Error('DOCUMENT_FILE_LIMIT');
      const bytes = await fs.readFile(file);
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      if (pdf.numPages > MAX_PDF_PAGES) throw new Error('PDF_PAGE_LIMIT');
      const result = await extractText(pdf);
      const selected = Array.isArray(args.page_indexes) ? args.page_indexes as number[] : result.text.map((_text, index) => index);
      if (selected.some(index => index < 0 || index >= result.totalPages)) throw new Error('PDF_PAGE_INDEX_OUT_OF_RANGE');
      const pages = selected.map(index => ({ page_index: index, text: result.text[index] ?? '' }));
      return { content: pages, mimeType: 'application/json', metadata: { totalPages: result.totalPages } };
    }
    throw new Error('DOCUMENT_FORMAT_UNSUPPORTED');
  }

  private async edit(args: Record<string, unknown>): Promise<StagedDocumentWrite> {
    const source = await this.input(args.path);
    const stat = await fs.stat(source);
    if (stat.size > MAX_FILE_BYTES) throw new Error('DOCUMENT_FILE_LIMIT');
    const ext = path.extname(source).toLowerCase();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hostdeck-document-stage-'));
    try {
      const temp = path.join(tempRoot, `working${ext}`);
      const sourceBytes = ext === '.docx' || ext === '.xlsx' || ext === '.xlsm'
        ? await checkOfficeArchive(source, ext === '.docx' ? '.docx' : '.xlsx')
        : await fs.readFile(source);
      await fs.writeFile(temp, sourceBytes);
      const change = args.change as Record<string, unknown>;
      if (!change || typeof change.kind !== 'string') throw new Error('DOCUMENT_CHANGE_INVALID');
      if (ext === '.docx' && change.kind === 'text_replace') {
        if (typeof change.old_text !== 'string' || typeof change.new_text !== 'string') throw new Error('DOCUMENT_CHANGE_INVALID');
        const handler = new DocxFileHandler();
        const result = await handler.editRange(temp, '', { oldStr: escapeXmlText(change.old_text), newStr: escapeXmlText(change.new_text), expectedReplacements: change.expected_replacements });
        if (!result.success) throw new Error(result.errors?.[0]?.error ?? 'DOCUMENT_EDIT_FAILED');
      } else if ((ext === '.xlsx' || ext === '.xlsm') && change.kind === 'table_range') {
        if (ext === '.xlsm') throw new Error('XLSM_EDIT_UNSUPPORTED_MACROS_PRESERVED');
        if (!Array.isArray(change.cells)) throw new Error('DOCUMENT_CHANGE_INVALID');
        const range = `${String(change.sheet)}!${String(change.range)}`;
        await new ExcelFileHandler().editRange(temp, range, change.cells);
      } else if (ext === '.pdf' && change.kind.startsWith('pdf_')) {
        const bytes = await this.editPdfBytes(sourceBytes, change);
        await fs.writeFile(temp, bytes);
      } else throw new Error('DOCUMENT_CHANGE_UNSUPPORTED');
      const bytes = await fs.readFile(temp);
      if (bytes.length > MAX_FILE_BYTES) throw new Error('DOCUMENT_OUTPUT_LIMIT');
      return { destination: source, bytes, mimeType: ext === '.pdf' ? 'application/pdf' : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
  }

  private async editPdfBytes(input: Buffer, change: Record<string, unknown>): Promise<Uint8Array> {
    const { PDFDocument } = pdfLibrary();
    const pdf = await PDFDocument.load(input, { updateMetadata: false });
    if (pdf.getPageCount() > MAX_PDF_PAGES) throw new Error('PDF_PAGE_LIMIT');
    if (change.kind === 'pdf_delete_pages') {
      const indexes = change.page_indexes as number[];
      if (new Set(indexes).size !== indexes.length || indexes.some(index => index < 0 || index >= pdf.getPageCount())) throw new Error('PDF_PAGE_INDEX_OUT_OF_RANGE');
      if (indexes.length >= pdf.getPageCount()) throw new Error('PDF_CANNOT_DELETE_ALL_PAGES');
      for (const index of [...indexes].sort((a, b) => b - a)) pdf.removePage(index);
    } else if (change.kind === 'pdf_insert_file') {
      const sourcePath = await this.input(change.source_path);
      if (path.extname(sourcePath).toLowerCase() !== '.pdf') throw new Error('PDF_SOURCE_FORMAT_INVALID');
      const sourceStat = await fs.stat(sourcePath);
      if (sourceStat.size > MAX_FILE_BYTES) throw new Error('DOCUMENT_FILE_LIMIT');
      const source = await PDFDocument.load(await fs.readFile(sourcePath), { updateMetadata: false });
      const index = change.page_index as number;
      if (source.getPageCount() > MAX_PDF_PAGES || index < 0 || index > pdf.getPageCount()) throw new Error('PDF_PAGE_INDEX_OUT_OF_RANGE');
      const copies = await pdf.copyPages(source, source.getPageIndices());
      copies.forEach((page: any, offset: number) => pdf.insertPage(index + offset, page));
    } else if (change.kind === 'pdf_insert_markdown') {
      const index = change.page_index as number;
      if (index < 0 || index > pdf.getPageCount()) throw new Error('PDF_PAGE_INDEX_OUT_OF_RANGE');
      const pages = await this.markdownPages(String(change.markdown ?? ''), change.options);
      if (pdf.getPageCount() + pages.getPageCount() > MAX_PDF_PAGES) throw new Error('PDF_PAGE_LIMIT');
      const copies = await pdf.copyPages(pages, pages.getPageIndices());
      copies.forEach((page: any, offset: number) => pdf.insertPage(index + offset, page));
    }
    return pdf.save({ useObjectStreams: false });
  }

  private async markdownPages(markdown: string, optionsValue: unknown): Promise<any> {
    const { PDFDocument, StandardFonts } = pdfLibrary();
    const options = safePdfOptions(optionsValue);
    const output = await PDFDocument.create();
    const regular = await output.embedFont(StandardFonts.Helvetica);
    const bold = await output.embedFont(StandardFonts.HelveticaBold);
    let size: [number, number] = options.page_size === 'Letter' ? [612, 792] : options.page_size === 'Legal' ? [612, 1008] : [595.28, 841.89];
    if (options.landscape) size = [size[1], size[0]];
    const clean = (text: string) => text.normalize('NFKD').replace(/[^\x09\x0a\x0d\x20-\xff]/g, '?');
    let page = output.addPage(size); let y = size[1] - 48;
    for (const raw of markdown.split(/\r?\n/)) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
      const text = clean(heading ? heading[2] : raw.replace(/^\s*[-*+]\s+/, '• '));
      const font = heading ? bold : regular; const fontSize = heading ? 18 : 11;
      const lines: string[] = []; let line = '';
      for (const word of text.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(candidate, fontSize) > size[0] - 96) { lines.push(line); line = word; } else line = candidate;
      }
      if (line) lines.push(line);
      if (!lines.length) lines.push('');
      for (const lineText of lines) {
        if (y < 60) { page = output.addPage(size); y = size[1] - 48; }
        if (lineText) page.drawText(lineText, { x: 48, y, size: fontSize, font });
        y -= fontSize + 5;
      }
      y -= heading ? 6 : 2;
    }
    return output;
  }

  private async writePdf(args: Record<string, unknown>): Promise<StagedDocumentWrite> {
    const destination = await this.output(args.path, false);
    if (path.extname(destination).toLowerCase() !== '.pdf') throw new Error('PDF_DESTINATION_REQUIRED');
    if (typeof args.markdown !== 'string' || Buffer.byteLength(args.markdown) > 100_000) throw new Error('PDF_MARKDOWN_LIMIT');
    const bytes = await createMarkdownPdf(args.markdown, args.options);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('DOCUMENT_OUTPUT_LIMIT');
    return { destination, bytes, mimeType: 'application/pdf' };
  }
}
