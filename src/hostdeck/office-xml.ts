import { SaxesParser } from 'saxes';
import { RuntimeError } from './runtime-error.js';

/** Preserve OOXML structures while editing only ordinary visible text nodes. */
export function escapeOfficeXml(value: string): string {
  for (const char of value) {
    const n = char.codePointAt(0)!;
    if (n === 0 || (n < 32 && n !== 9 && n !== 10 && n !== 13) ||
        (n >= 0xd800 && n <= 0xdfff) || n === 0xfffe || n === 0xffff) {
      throw new RuntimeError('DOCUMENT_XML_CHARACTER_DENIED');
    }
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

export function decodeOfficeXml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));)/.test(value)) {
    throw new RuntimeError('DOCUMENT_UNSUPPORTED_XML_ENTITY');
  }
  return value.replace(/&(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<',
      '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (Object.prototype.hasOwnProperty.call(named, entity)) return named[entity];
    const hex = entity.startsWith('&#x');
    const n = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    if (!Number.isInteger(n) || n < 1 || n > 0x10ffff ||
        (n >= 0xd800 && n <= 0xdfff)) throw new RuntimeError('DOCUMENT_XML_CHARACTER_DENIED');
    return String.fromCodePoint(n);
  });
}

export function requireSafeOfficeXml(xml: string): void {
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml) || /<\?xml-stylesheet\b/i.test(xml) || /<!\[CDATA\[|<!--/.test(xml)) {
    throw new RuntimeError('DOCUMENT_UNSAFE_XML');
  }
}

interface TextNode { start: number; end: number; open: string; close: string; before: string; after: string; }

function rewriteParagraph(xml: string, oldText: string, newText: string): { xml: string; count: number } {
  // Field instruction and field result spans are not plain editable document text.
  if (/<w:(?:fldChar|fldSimple|instrText)\b/i.test(xml)) return { xml, count: 0 };
  const nodes: TextNode[] = [];
  for (const match of xml.matchAll(/(<w:t\b[^>]*>)([^<]*)(<\/w:t>)/g)) {
    const decoded = decodeOfficeXml(match[2]);
    nodes.push({ start: match.index!, end: match.index! + match[0].length,
      open: match[1], close: match[3], before: decoded, after: decoded });
  }
  const boundaries = /<w:(?:tab|br|cr|drawing|pict|object|sym|delText|del|footnoteReference|endnoteReference|hyperlink)\b/i;
  const groups: TextNode[][] = [];
  let group: TextNode[] = [];
  let previous: TextNode | undefined;
  for (const node of nodes) {
    if (previous && boundaries.test(xml.slice(previous.end, node.start))) {
      if (group.length) groups.push(group);
      group = [];
    }
    group.push(node);
    previous = node;
  }
  if (group.length) groups.push(group);
  let count = 0;
  for (const current of groups) {
    const combined = current.map(node => node.before).join('');
    const occurrences: number[] = [];
    for (let cursor = 0; cursor <= combined.length - oldText.length;) {
      const start = combined.indexOf(oldText, cursor);
      if (start < 0) break;
      occurrences.push(start);
      cursor = start + oldText.length;
    }
    count += occurrences.length;
    for (const start of occurrences.reverse()) {
      const stop = start + oldText.length;
      let accumulated = 0, first = -1, last = -1, beginAt = 0, endAt = 0;
      for (let i = 0; i < current.length; i++) {
        const upper = accumulated + current[i].before.length;
        if (first < 0 && start < upper) { first = i; beginAt = start - accumulated; }
        if (stop <= upper) { last = i; endAt = stop - accumulated; break; }
        accumulated = upper;
      }
      if (first < 0 || last < first) throw new RuntimeError('DOCX_TEXT_RANGE_INVALID');
      if (first === last) {
        const value = current[first].after;
        current[first].after = value.slice(0, beginAt) + newText + value.slice(endAt);
      } else {
        current[first].after = current[first].after.slice(0, beginAt) + newText;
        for (let i = first + 1; i < last; i++) current[i].after = '';
        current[last].after = current[last].after.slice(endAt);
      }
    }
  }
  if (count === 0) return { xml, count };
  let result = xml;
  for (const node of nodes.reverse()) {
    if (node.after === node.before) continue;
    let open = node.open;
    if (/^\s|\s$/u.test(node.after)) {
      if (/\bxml:space\s*=/.test(open)) {
        // xml:space="default" strips the very whitespace just inserted.
        open = open.replace(/\bxml:space\s*=\s*(["'])[\s\S]*?\1/, 'xml:space="preserve"');
      } else {
        open = open.slice(0, -1) + ' xml:space="preserve">';
      }
    }
    result = result.slice(0, node.start) + open + escapeOfficeXml(node.after) +
      node.close + result.slice(node.end);
  }
  return { xml: result, count };
}

export function replaceVisibleDocxXml(xml: string, oldText: string, newText: string): { xml: string; count: number } {
  requireSafeOfficeXml(xml);
  if (!oldText) throw new RuntimeError('DOCX_SEARCH_EMPTY');
  escapeOfficeXml(oldText);
  escapeOfficeXml(newText);
  let out = '', position = 0, count = 0;
  for (const item of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    out += xml.slice(position, item.index!);
    const replacement = rewriteParagraph(item[0], oldText, newText);
    out += replacement.xml;
    count += replacement.count;
    position = item.index! + item[0].length;
  }
  return { xml: out + xml.slice(position), count };
}

/** 
 * Namespace-aware, fully nesting-checked guard applied BEFORE any OOXML rewrite.
 * Parsing is validation-only: XML is never reserialized, and untouched ZIP entries
 * retain their decompressed bytes. Unsupported namespace aliases fail closed.
 */
export type OfficePart = 'document' | 'hdr' | 'ftr' | 'workbook' | 'worksheet' | 'relationships' | 'sst' | 'styleSheet';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SHEET_ELEMENTS = new Set(['workbook', 'workbookPr', 'sheets', 'sheet', 'worksheet', 'sheetData',
  'row', 'c', 'f', 'v', 'is', 't', 'si', 'sst', 'styleSheet', 'numFmts', 'numFmt', 'cellXfs', 'xf']);

interface OfficeElement { local: string; uri: string; prefix: string; }
export function validateOfficeStructure(xml: string, kind: OfficePart): void {
  requireSafeOfficeXml(xml);
  const word = kind === 'document' || kind === 'hdr' || kind === 'ftr';
  const relation = kind === 'relationships';
  const requiredUri = word ? WORD_NS : relation ? PACKAGE_REL_NS : SHEET_NS;
  const requiredName = relation ? 'Relationships' : kind;
  const requiredPrefix = word ? 'w' : '';
  const stack: OfficeElement[] = [];
  const parser = new SaxesParser<{ xmlns: true }>({ xmlns: true });
  let roots = 0, bodyCount = 0, sheetDataCount = 0;
  parser.on('doctype', () => { throw new RuntimeError('DOCUMENT_UNSAFE_XML'); });
  parser.on('processinginstruction', () => { throw new RuntimeError('DOCUMENT_UNSAFE_XML'); });
  parser.on('error', () => { throw new RuntimeError('DOCUMENT_INVALID_XML'); });
  parser.on('opentag', tag => {
    const parent = stack[stack.length - 1];
    const current: OfficeElement = { local: tag.local, prefix: tag.prefix, uri: tag.uri };
    if (!parent) {
      roots++;
      if (roots !== 1 || tag.local !== requiredName || tag.uri !== requiredUri ||
          tag.prefix !== requiredPrefix) throw new RuntimeError('DOCUMENT_INVALID_XML_ROOT_OR_NAMESPACE');
    }
    if (parent && tag.local === requiredName && tag.uri === requiredUri) {
      throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
    }
    if (word) {
      if (parent && tag.uri === WORD_NS && ['document', 'hdr', 'ftr'].includes(tag.local)) {
        throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
      }
      if ((tag.prefix === 'w' && tag.uri !== WORD_NS) ||
          (tag.uri === WORD_NS && tag.prefix !== 'w')) {
        throw new RuntimeError('DOCUMENT_INVALID_XML_NAMESPACE');
      }
      if (tag.uri === WORD_NS && tag.local === 'body') {
        if (kind !== 'document' || !parent || parent.local !== 'document' ||
            parent.uri !== WORD_NS) throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
        bodyCount++;
      }
      if (tag.uri === WORD_NS && tag.local === 'p') {
        if (stack.some(element => element.local === 'p' && element.uri === WORD_NS)) {
          throw new RuntimeError('DOCUMENT_UNSUPPORTED_NESTED_PARAGRAPH');
        }
        if (kind === 'document' &&
            !stack.some(element => element.local === 'body' && element.uri === WORD_NS)) {
          throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
        }
      }
      if (tag.uri === WORD_NS && tag.local === 't' &&
          (!parent || parent.local !== 'r' || parent.uri !== WORD_NS ||
            !stack.some(element => element.local === 'p' && element.uri === WORD_NS))) {
        throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
      }
    } else if (relation) {
      if ((tag.local === 'Relationship' || tag.local === 'Relationships') &&
          (tag.uri !== PACKAGE_REL_NS || tag.prefix !== '')) {
        throw new RuntimeError('DOCUMENT_INVALID_XML_NAMESPACE');
      }
      if (tag.local === 'Relationship' &&
          (!parent || parent.local !== 'Relationships' || parent.uri !== PACKAGE_REL_NS)) {
        throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
      }
    } else {
      if (SHEET_ELEMENTS.has(tag.local) && (tag.uri !== SHEET_NS || tag.prefix !== '')) {
        throw new RuntimeError('DOCUMENT_INVALID_XML_NAMESPACE');
      }
      if (kind === 'workbook') {
        if (tag.local === 'sheets' &&
            (!parent || parent.local !== 'workbook' || parent.uri !== SHEET_NS)) {
          throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
        }
        if (tag.local === 'sheet') {
          if (!parent || parent.local !== 'sheets' || parent.uri !== SHEET_NS) {
            throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
          }
          const relationshipId = tag.attributes['r:id'];
          if (!relationshipId || relationshipId.uri !== OFFICE_REL_NS) {
            throw new RuntimeError('DOCUMENT_INVALID_XML_NAMESPACE');
          }
        }
      } else if (kind === 'worksheet') {
        if (tag.local === 'sheetData') {
          if (!parent || parent.local !== 'worksheet' || parent.uri !== SHEET_NS) {
            throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
          }
          sheetDataCount++;
        }
        if (tag.local === 'row' &&
            (!parent || parent.local !== 'sheetData' || parent.uri !== SHEET_NS)) {
          throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
        }
        if (tag.local === 'c' &&
            (!parent || parent.local !== 'row' || parent.uri !== SHEET_NS)) {
          throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
        }
        if (['f', 'v', 'is'].includes(tag.local) &&
            (!parent || parent.local !== 'c' || parent.uri !== SHEET_NS)) {
          throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
        }
      } else if (kind === 'sst' && tag.local === 'si' &&
          (!parent || parent.local !== 'sst' || parent.uri !== SHEET_NS)) {
        throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
      } else if (kind === 'styleSheet') {
        if (['numFmts', 'cellXfs'].includes(tag.local) &&
            (!parent || parent.local !== 'styleSheet' || parent.uri !== SHEET_NS)) {
          throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
        }
        if (tag.local === 'numFmt' &&
            (!parent || parent.local !== 'numFmts' || parent.uri !== SHEET_NS)) {
          throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
        }
        if (tag.local === 'xf' && parent?.local === 'cellXfs' && parent.uri !== SHEET_NS) {
          throw new RuntimeError('DOCUMENT_INVALID_XML_NAMESPACE');
        }
      }
    }
    stack.push(current);
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  if (roots !== 1 || stack.length !== 0 ||
      (kind === 'document' && bodyCount !== 1) ||
      (kind === 'worksheet' && sheetDataCount !== 1)) {
    throw new RuntimeError('DOCUMENT_INVALID_XML_NESTING');
  }
}
