/**
 * Conservative openpyxl-comment workbook compatibility path.
 * The original workbook ZIP is read as-is. For cell edits only the selected
 * worksheet XML is rewritten; comment, VML, relationships, formulas and styles
 * in every other entry retain their uncompressed bytes.
 * Complex or non-existing target cells fail closed instead of triggering
 * an ExcelJS whole-workbook round trip.
 */
import path from 'node:path';
import { pizzipPackage } from '../utils/files/docx.js';
import { decodeOfficeXml, escapeOfficeXml, requireSafeOfficeXml, validateOfficeStructure } from './office-xml.js';

function open(buffer: Buffer): any { return new (pizzipPackage.load())(buffer); }
function part(zip: any, name: string): string {
  const file = zip.file(name);
  if (!file) throw new Error('XLSX_PART_MISSING');
  const xml = file.asText();
  requireSafeOfficeXml(xml);
  return xml;
}
function attribute(xml: string, name: string): string | undefined {
  for (const m of xml.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    if (m[1] === name) return decodeOfficeXml(m[3]);
  }
  return undefined;
}
function columns(value: string): number {
  let index = 0;
  for (const ch of value.toUpperCase()) index = index * 26 + ch.charCodeAt(0) - 64;
  return index;
}
function address(value: string): { row: number; col: number } {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(value);
  if (!m) throw new Error('XLSX_CELL_ADDRESS_INVALID');
  const col = columns(m[1]), row = Number(m[2]);
  if (col < 1 || col > 16384 || row > 1048576) throw new Error('XLSX_CELL_ADDRESS_INVALID');
  return { row, col };
}
function key(row: number, col: number): string {
  let letters = '';
  while (col) { col--; letters = String.fromCharCode(65 + col % 26) + letters; col = Math.floor(col / 26); }
  return letters + row;
}
function cellRange(value: string): { row: number; col: number; endRow: number; endCol: number } {
  const m = /^([A-Z]{1,3}[1-9]\d{0,6})(?::([A-Z]{1,3}[1-9]\d{0,6}))?$/i.exec(value);
  if (!m) throw new Error('XLSX_EXPLICIT_RANGE_REQUIRED');
  const start = address(m[1]), end = address(m[2] ?? m[1]);
  if (end.row < start.row || end.col < start.col) throw new Error('XLSX_INVALID_RANGE');
  return { row: start.row, col: start.col, endRow: end.row, endCol: end.col };
}
interface Cell { name: string; start: number; end: number; attrs: string; inner: string; }
function cells(xml: string): Cell[] {
  const found: Cell[] = [];
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const name = attribute(match[1], 'r');
    if (!name) throw new Error('XLSX_MISSING_CELL_REFERENCE');
    address(name);
    found.push({ name: name.toUpperCase(), start: match.index!, end: match.index! + match[0].length,
      attrs: match[1], inner: match[2] ?? '' });
  }
  return found;
}
function tag(contents: string, name: string): string | undefined {
  const re = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>');
  const found = re.exec(contents);
  return found ? decodeOfficeXml(found[1]) : undefined;
}
function inline(contents: string): string {
  let value = '';
  for (const m of contents.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)) value += decodeOfficeXml(m[1]);
  return value;
}
function cellValue(cell: Cell, shared: string[]): unknown {
  const type = attribute(cell.attrs, 't');
  const formula = tag(cell.inner, 'f'), raw = tag(cell.inner, 'v');
  const formulaTag = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(cell.inner);
  if (formulaTag && formulaTag[1].trim()) {
    // Shared/array/dataTable and other attributed formula groups cannot be
    // expanded or recalculated by this bounded reader. Never emit null as a
    // seemingly successful value for a shared-formula dependent without cache.
    const formulaType = attribute(formulaTag[1], 't') ?? 'unsupported';
    const cachedResultAvailable = raw !== undefined && raw !== '';
    return {
      formulaType,
      formula: formula === undefined || formula === '' ? null : '=' + formula,
      calculated: false,
      cachedResultAvailable,
      status: 'UNSUPPORTED_FORMULA_GROUP',
      ...(cachedResultAvailable ? { cachedResult: type === 'b' ? raw === '1'
        : type === 'str' || type === 'e' ? raw : Number.isFinite(Number(raw)) ? Number(raw) : raw } : {}),
    };
  }
  if (formula !== undefined && (raw === undefined || raw === '')) {
    return { formula: '=' + formula, calculated: false, cachedResultAvailable: false };
  }
  if (type === 'inlineStr') return inline(cell.inner);
  if (type === 's') {
    const index = Number(raw);
    if (!Number.isSafeInteger(index) || index < 0 || index >= shared.length) throw new Error('XLSX_SHARED_STRING_INVALID');
    return shared[index];
  }
  if (raw === undefined || raw === '') return null;
  if (type === 'b') return raw === '1';
  if (type === 'str' || type === 'e') return raw;
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error('XLSX_UNSUPPORTED_VALUE');
  return number;
}
function sheetDetails(zip: any, selected?: string): { name: string; file: string; names: string[] } {
  const workbook = part(zip, 'xl/workbook.xml');
  const refs = part(zip, 'xl/_rels/workbook.xml.rels');
  validateOfficeStructure(workbook, 'workbook');
  validateOfficeStructure(refs, 'relationships');
  const available: Array<{ name: string; rel: string }> = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attribute(m[0], 'name'), rel = attribute(m[0], 'r:id');
    if (name && rel) available.push({ name, rel });
  }
  const selectedSheet = selected === undefined || selected === '' ? available[0]
    : /^\d+$/.test(selected) ? available[Number(selected)] : available.find(x => x.name === selected);
  if (!selectedSheet) throw new Error('XLSX_SHEET_NOT_FOUND');
  const relations = new Map<string, { target: string; external: boolean }>();
  for (const m of refs.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attribute(m[0], 'Id'), target = attribute(m[0], 'Target');
    if (id && target) relations.set(id, { target, external: attribute(m[0], 'TargetMode') === 'External' });
  }
  const relation = relations.get(selectedSheet.rel);
  if (!relation || relation.external) throw new Error('XLSX_SHEET_RELATION_DENIED');
  const target = relation.target;
  if (target.split('/').includes('..') || target.includes('\\')) throw new Error('XLSX_SHEET_RELATION_DENIED');
  const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('xl', target));
  if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(file) || !zip.file(file)) {
    throw new Error('XLSX_SHEET_RELATION_DENIED');
  }
  return { name: selectedSheet.name, file, names: available.map(x => x.name) };
}

export function isOpenpyxlCommentLayout(input: Buffer): boolean {
  const zip = open(input);
  return Object.keys(zip.files).some(name => /^xl\/comments\/comment\d+\.xml$/i.test(name) ||
    /^xl\/drawings\/commentsDrawing\d+\.vml$/i.test(name));
}

export function readOpenpyxlCommentWorkbook(input: Buffer, sheet?: string, range?: string): {
  data: unknown[][]; sheetName: string; sheetNames: string[];
} {
  const zip = open(input), info = sheetDetails(zip, sheet);
  const worksheet = part(zip, info.file);
  validateOfficeStructure(worksheet, 'worksheet');
  let shared: string[] = [];
  if (zip.file('xl/sharedStrings.xml')) {
    const strings = part(zip, 'xl/sharedStrings.xml');
    validateOfficeStructure(strings, 'sst');
    shared = [...strings.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => inline(m[1]));
  }
  const values = new Map<string, unknown>();
  let lastRow = 1, lastCol = 1;
  for (const cell of cells(worksheet)) {
    if (values.has(cell.name)) throw new Error('XLSX_DUPLICATE_CELL');
    values.set(cell.name, cellValue(cell, shared));
    const location = address(cell.name);
    lastRow = Math.max(lastRow, location.row);
    lastCol = Math.max(lastCol, location.col);
  }
  const selectedRange = range ? cellRange(range) :
    { row: 1, col: 1, endRow: lastRow, endCol: lastCol };
  const count = (selectedRange.endRow - selectedRange.row + 1) *
    (selectedRange.endCol - selectedRange.col + 1);
  if (count > 20000 || selectedRange.endRow - selectedRange.row + 1 > 1000) {
    throw new Error('DOCUMENT_READ_LIMIT');
  }
  const data: unknown[][] = [];
  for (let row = selectedRange.row; row <= selectedRange.endRow; row++) {
    const valuesRow: unknown[] = [];
    for (let col = selectedRange.col; col <= selectedRange.endCol; col++) {
      valuesRow.push(values.get(key(row, col)) ?? null);
    }
    data.push(valuesRow);
  }
  return { data, sheetName: info.name, sheetNames: info.names };
}

export function editOpenpyxlCommentWorkbook(input: Buffer, sheet: string, range: string,
    newCells: unknown[][]): Buffer {
  if (!Array.isArray(newCells) || !newCells.every(row => Array.isArray(row))) {
    throw new Error('DOCUMENT_CHANGE_INVALID');
  }
  const bound = cellRange(range);
  if (newCells.length > bound.endRow - bound.row + 1 ||
      newCells.some(row => row.length > bound.endCol - bound.col + 1)) {
    throw new Error('XLSX_CONTENT_EXCEEDS_RANGE');
  }
  const modifications = new Map<string, string | number | boolean | null>();
  for (let row = 0; row < newCells.length; row++) {
    for (let col = 0; col < newCells[row].length; col++) {
      const value = newCells[row][col];
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('XLSX_CELL_VALUE_UNSUPPORTED');
      }
      modifications.set(key(bound.row + row, bound.col + col), value as string | number | boolean | null);
    }
  }
  if (!modifications.size) throw new Error('XLSX_EMPTY_EDIT');
  const zip = open(input), info = sheetDetails(zip, sheet);
  let xml = part(zip, info.file);
  validateOfficeStructure(xml, 'worksheet');
  const existing = cells(xml);
  const seen = new Set<string>();
  const changes: Array<{ start: number; end: number; content: string }> = [];
  for (const cell of existing) {
    if (!modifications.has(cell.name)) continue;
    if (seen.has(cell.name)) throw new Error('XLSX_DUPLICATE_CELL');
    seen.add(cell.name);
    // Never delete a shared/array/dataTable formula master or dependent. Even
    // replacing only one member invalidates the group's si/ref references.
    // Reject every attributed <f> conservatively (including unknown kinds).
    const formulaElement = /<f\b([^>]*?)(?:\/>|>)/.exec(cell.inner);
    if (formulaElement && formulaElement[1].trim()) {
      throw new Error('XLSX_FORMULA_GROUP_EDIT_UNSUPPORTED');
    }
    // Reject unsupported cell-owned markup rather than deleting it silently.
    const remainder = cell.inner.replace(/<f\b[^>]*>[\s\S]*?<\/f>|<f\b[^>]*\/>|<v\b[^>]*>[\s\S]*?<\/v>|<v\s*\/>|<is\b[^>]*>[\s\S]*?<\/is>/g, '').trim();
    if (remainder || /\s(?:cm|vm|ph)\s*=/.test(cell.attrs)) {
      throw new Error('XLSX_UNSUPPORTED_CELL_CONTENT');
    }
    let opening = cell.attrs.replace(/\s+t\s*=\s*(["'])[\s\S]*?\1/, '');
    const value = modifications.get(cell.name)!;
    let type = '', contents = '';
    if (value === null) {
      changes.push({ start: cell.start, end: cell.end, content: '<c' + opening + '/>' });
      continue;
    }
    if (typeof value === 'string') {
      if (value.startsWith('=')) {
        if (!value.slice(1).trim()) throw new Error('XLSX_FORMULA_EMPTY');
        contents = '<f>' + escapeOfficeXml(value.slice(1)) + '</f><v/>';
      } else {
        type = ' t="inlineStr"';
        contents = '<is><t xml:space="preserve">' + escapeOfficeXml(value) + '</t></is>';
      }
    } else if (typeof value === 'boolean') {
      type = ' t="b"';
      contents = '<v>' + (value ? '1' : '0') + '</v>';
    } else contents = '<v>' + String(value) + '</v>';
    changes.push({ start: cell.start, end: cell.end, content: '<c' + opening + type + '>' + contents + '</c>' });
  }
  if (seen.size !== modifications.size) throw new Error('XLSX_EXISTING_CELL_REQUIRED');
  for (const change of changes.reverse()) {
    xml = xml.slice(0, change.start) + change.content + xml.slice(change.end);
  }
  zip.file(info.file, xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
