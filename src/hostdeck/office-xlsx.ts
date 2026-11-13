/**
 * Conservative openpyxl-comment workbook compatibility path.
 * The original workbook ZIP is read as-is. For cell edits only the selected
 * worksheet XML is rewritten; comment, VML, relationships, formulas and styles
 * in every other entry retain their uncompressed bytes.
 * Complex or non-existing target cells fail closed instead of triggering
 * an ExcelJS whole-workbook round trip.
 */
import path from 'node:path';
import { RuntimeError } from './runtime-error.js';
import { pizzipPackage } from '../utils/files/docx.js';
import { decodeOfficeXml, escapeOfficeXml, requireSafeOfficeXml, validateOfficeStructure } from './office-xml.js';

function open(buffer: Buffer): any { return new (pizzipPackage.load())(buffer); }
function part(zip: any, name: string): string {
  const file = zip.file(name);
  if (!file) throw new RuntimeError('XLSX_PART_MISSING');
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
  if (!m) throw new RuntimeError('XLSX_CELL_ADDRESS_INVALID');
  const col = columns(m[1]), row = Number(m[2]);
  if (col < 1 || col > 16384 || row > 1048576) throw new RuntimeError('XLSX_CELL_ADDRESS_INVALID');
  return { row, col };
}
function key(row: number, col: number): string {
  let letters = '';
  while (col) { col--; letters = String.fromCharCode(65 + col % 26) + letters; col = Math.floor(col / 26); }
  return letters + row;
}
function cellRange(value: string): { row: number; col: number; endRow: number; endCol: number } {
  const m = /^([A-Z]{1,3}[1-9]\d{0,6})(?::([A-Z]{1,3}[1-9]\d{0,6}))?$/i.exec(value);
  if (!m) throw new RuntimeError('XLSX_EXPLICIT_RANGE_REQUIRED');
  const start = address(m[1]), end = address(m[2] ?? m[1]);
  if (end.row < start.row || end.col < start.col) throw new RuntimeError('XLSX_INVALID_RANGE');
  return { row: start.row, col: start.col, endRow: end.row, endCol: end.col };
}
interface Cell { name: string; start: number; end: number; attrs: string; inner: string; }
function cells(xml: string): Cell[] {
  const found: Cell[] = [];
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const name = attribute(match[1], 'r');
    if (!name) throw new RuntimeError('XLSX_MISSING_CELL_REFERENCE');
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
/** SpreadsheetML style metadata used only for date-aware reads.
 * Edits never reserialize these parts or reinterpret existing number formats.
 */
interface OfficeDateStyles {
  formatsByStyle: number[];
  customFormats: Map<number, string>;
  date1904: boolean;
  hasStyles: boolean;
}
const builtinDateFormatIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateNumberFormat(value: string): boolean {
  // Match calendar/time tokens, excluding quoted/escaped literal text and colors.
  const tokens = value.replace(/"(?:[^"]|"")*"/g, '')
    .replace(/\\./g, '').replace(/[_*]./g, '')
    .replace(/\[[^\]]*\]/g, token => /^\[(?:h+|m+|s+)\]$/i.test(token)
      ? token.slice(1, -1) : '');
  return /[ymdhs]/i.test(tokens);
}

function dateStyles(zip: any): OfficeDateStyles {
  const workbook = part(zip, 'xl/workbook.xml');
  validateOfficeStructure(workbook, 'workbook');
  const property = /<workbookPr\b[^>]*\/?>/.exec(workbook);
  const configured = property ? attribute(property[0], 'date1904') : undefined;
  if (configured !== undefined && !['0', '1', 'false', 'true'].includes(configured)) {
    throw new RuntimeError('XLSX_DATE_SYSTEM_UNSUPPORTED');
  }
  const date1904 = configured === '1' || configured === 'true';
  if (!zip.file('xl/styles.xml')) {
    return { formatsByStyle: [], customFormats: new Map(), date1904, hasStyles: false };
  }
  const xml = part(zip, 'xl/styles.xml');
  validateOfficeStructure(xml, 'styleSheet');
  const customFormats = new Map<number, string>();
  const formats = /<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(xml);
  if (formats) {
    for (const item of formats[1].matchAll(/<numFmt\b[^>]*\/?>/g)) {
      const id = attribute(item[0], 'numFmtId');
      const format = attribute(item[0], 'formatCode');
      if (!id || !/^\d+$/.test(id) || format === undefined) {
        throw new RuntimeError('XLSX_NUMBER_FORMAT_INVALID');
      }
      const numFmtId = Number(id);
      if (!Number.isSafeInteger(numFmtId) || customFormats.has(numFmtId)) {
        throw new RuntimeError('XLSX_NUMBER_FORMAT_INVALID');
      }
      customFormats.set(numFmtId, format);
    }
  }
  const styles = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  const formatsByStyle: number[] = [];
  if (styles) for (const item of styles[1].matchAll(/<xf\b[^>]*\/?>/g)) {
    const raw = attribute(item[0], 'numFmtId') ?? '0';
    if (!/^\d+$/.test(raw)) throw new RuntimeError('XLSX_NUMBER_FORMAT_INVALID');
    const id = Number(raw);
    if (!Number.isSafeInteger(id)) throw new RuntimeError('XLSX_NUMBER_FORMAT_INVALID');
    formatsByStyle.push(id);
  }
  return { formatsByStyle, customFormats, date1904, hasStyles: true };
}

function dateAwareNumber(cell: Cell, numeric: number, raw: string, styles: OfficeDateStyles): number | string | Record<string, unknown> {
  const style = attribute(cell.attrs, 's');
  if (style !== undefined && !/^\d+$/.test(style)) {
    throw new RuntimeError('XLSX_STYLE_INDEX_INVALID');
  }
  const index = style === undefined ? 0 : Number(style);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RuntimeError('XLSX_STYLE_INDEX_INVALID');
  }
  const formatId = styles.formatsByStyle[index];
  if (formatId === undefined) {
    return style === undefined ? numeric
      : { status: 'UNSUPPORTED_CELL_STYLE', serial: numeric, styleIndex: index };
  }
  const custom = styles.customFormats.get(formatId);
  if (formatId >= 164 && custom === undefined) {
    return { status: 'UNSUPPORTED_NUMBER_FORMAT', serial: numeric, numberFormatId: formatId };
  }
  const isDate = builtinDateFormatIds.has(formatId) ||
    (custom !== undefined && isDateNumberFormat(custom));
  if (!isDate) return numeric;
  const timestamp = Math.round((numeric - 25569 + (styles.date1904 ? 1462 : 0)) * 86_400_000);
  // The fictitious 29 February 1900 Excel serial cannot be mapped faithfully.
  if (!Number.isFinite(timestamp) || numeric < 0 ||
      (!styles.date1904 && numeric === 60)) {
    return { status: 'UNSUPPORTED_DATE_SERIAL', serial: raw, numberFormatId: formatId,
      date1904: styles.date1904 };
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return { status: 'UNSUPPORTED_DATE_SERIAL', serial: raw, numberFormatId: formatId,
      date1904: styles.date1904 };
  }
  // Matches ExcelJS's established HostDeck JSON date representation.
  return date.toISOString();
}

function cellValue(cell: Cell, shared: string[], styles: OfficeDateStyles): unknown {
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
    if (!Number.isSafeInteger(index) || index < 0 || index >= shared.length) throw new RuntimeError('XLSX_SHARED_STRING_INVALID');
    return shared[index];
  }
  if (raw === undefined || raw === '') return null;
  if (type === 'b') return raw === '1';
  if (type === 'str' || type === 'e') return raw;
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new RuntimeError('XLSX_UNSUPPORTED_VALUE');
  return dateAwareNumber(cell, number, raw, styles);
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
  if (!selectedSheet) throw new RuntimeError('XLSX_SHEET_NOT_FOUND');
  const relations = new Map<string, { target: string; external: boolean }>();
  for (const m of refs.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attribute(m[0], 'Id'), target = attribute(m[0], 'Target');
    if (id && target) relations.set(id, { target, external: attribute(m[0], 'TargetMode') === 'External' });
  }
  const relation = relations.get(selectedSheet.rel);
  if (!relation || relation.external) throw new RuntimeError('XLSX_SHEET_RELATION_DENIED');
  const target = relation.target;
  if (target.split('/').includes('..') || target.includes('\\')) throw new RuntimeError('XLSX_SHEET_RELATION_DENIED');
  const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('xl', target));
  if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(file) || !zip.file(file)) {
    throw new RuntimeError('XLSX_SHEET_RELATION_DENIED');
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
  const styles = dateStyles(zip);
  const values = new Map<string, unknown>();
  let lastRow = 1, lastCol = 1;
  for (const cell of cells(worksheet)) {
    if (values.has(cell.name)) throw new RuntimeError('XLSX_DUPLICATE_CELL');
    values.set(cell.name, cellValue(cell, shared, styles));
    const location = address(cell.name);
    lastRow = Math.max(lastRow, location.row);
    lastCol = Math.max(lastCol, location.col);
  }
  const selectedRange = range ? cellRange(range) :
    { row: 1, col: 1, endRow: lastRow, endCol: lastCol };
  const count = (selectedRange.endRow - selectedRange.row + 1) *
    (selectedRange.endCol - selectedRange.col + 1);
  if (count > 20000 || selectedRange.endRow - selectedRange.row + 1 > 1000) {
    throw new RuntimeError('DOCUMENT_READ_LIMIT');
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
    throw new RuntimeError('DOCUMENT_CHANGE_INVALID');
  }
  const bound = cellRange(range);
  if (newCells.length > bound.endRow - bound.row + 1 ||
      newCells.some(row => row.length > bound.endCol - bound.col + 1)) {
    throw new RuntimeError('XLSX_CONTENT_EXCEEDS_RANGE');
  }
  const modifications = new Map<string, string | number | boolean | null>();
  for (let row = 0; row < newCells.length; row++) {
    for (let col = 0; col < newCells[row].length; col++) {
      const value = newCells[row][col];
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))) {
        throw new RuntimeError('XLSX_CELL_VALUE_UNSUPPORTED');
      }
      modifications.set(key(bound.row + row, bound.col + col), value as string | number | boolean | null);
    }
  }
  if (!modifications.size) throw new RuntimeError('XLSX_EMPTY_EDIT');
  const zip = open(input), info = sheetDetails(zip, sheet);
  let xml = part(zip, info.file);
  validateOfficeStructure(xml, 'worksheet');
  const existing = cells(xml);
  const seen = new Set<string>();
  const changes: Array<{ start: number; end: number; content: string }> = [];
  for (const cell of existing) {
    if (!modifications.has(cell.name)) continue;
    if (seen.has(cell.name)) throw new RuntimeError('XLSX_DUPLICATE_CELL');
    seen.add(cell.name);
    // Never delete a shared/array/dataTable formula master or dependent. Even
    // replacing only one member invalidates the group's si/ref references.
    // Reject every attributed <f> conservatively (including unknown kinds).
    const formulaElement = /<f\b([^>]*?)(?:\/>|>)/.exec(cell.inner);
    if (formulaElement && formulaElement[1].trim()) {
      throw new RuntimeError('XLSX_FORMULA_GROUP_EDIT_UNSUPPORTED');
    }
    // Reject unsupported cell-owned markup rather than deleting it silently.
    const remainder = cell.inner.replace(/<f\b[^>]*>[\s\S]*?<\/f>|<f\b[^>]*\/>|<v\b[^>]*>[\s\S]*?<\/v>|<v\s*\/>|<is\b[^>]*>[\s\S]*?<\/is>/g, '').trim();
    if (remainder || /\s(?:cm|vm|ph)\s*=/.test(cell.attrs)) {
      throw new RuntimeError('XLSX_UNSUPPORTED_CELL_CONTENT');
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
        if (!value.slice(1).trim()) throw new RuntimeError('XLSX_FORMULA_EMPTY');
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
  if (seen.size !== modifications.size) throw new RuntimeError('XLSX_EXISTING_CELL_REQUIRED');
  for (const change of changes.reverse()) {
    xml = xml.slice(0, change.start) + change.content + xml.slice(change.end);
  }
  zip.file(info.file, xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
