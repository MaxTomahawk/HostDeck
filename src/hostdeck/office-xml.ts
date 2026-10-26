/** Preserve OOXML structures while editing only ordinary visible text nodes. */
export function escapeOfficeXml(value: string): string {
  for (const char of value) {
    const n = char.codePointAt(0)!;
    if (n === 0 || (n < 32 && n !== 9 && n !== 10 && n !== 13) ||
        (n >= 0xd800 && n <= 0xdfff) || n === 0xfffe || n === 0xffff) {
      throw new Error('DOCUMENT_XML_CHARACTER_DENIED');
    }
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

export function decodeOfficeXml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));)/.test(value)) {
    throw new Error('DOCUMENT_UNSUPPORTED_XML_ENTITY');
  }
  return value.replace(/&(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<',
      '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const hex = entity.startsWith('&#x');
    const n = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    if (!Number.isInteger(n) || n < 1 || n > 0x10ffff ||
        (n >= 0xd800 && n <= 0xdfff)) throw new Error('DOCUMENT_XML_CHARACTER_DENIED');
    return String.fromCodePoint(n);
  });
}

export function requireSafeOfficeXml(xml: string): void {
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml) || /<\?xml-stylesheet\b/i.test(xml)) {
    throw new Error('DOCUMENT_UNSAFE_XML');
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
      if (first < 0 || last < first) throw new Error('DOCX_TEXT_RANGE_INVALID');
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
    if (/^\s|\s$/u.test(node.after) && !/\bxml:space\s*=/.test(open)) {
      open = open.slice(0, -1) + ' xml:space="preserve">';
    }
    result = result.slice(0, node.start) + open + escapeOfficeXml(node.after) +
      node.close + result.slice(node.end);
  }
  return { xml: result, count };
}

export function replaceVisibleDocxXml(xml: string, oldText: string, newText: string): { xml: string; count: number } {
  requireSafeOfficeXml(xml);
  if (!oldText) throw new Error('DOCX_SEARCH_EMPTY');
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
