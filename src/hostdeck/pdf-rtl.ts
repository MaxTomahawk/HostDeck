/**
 * HD-REQ-0030: recover only qualified RTL glyph streams from PDF.js items.
 *
 * Chromium/Skia can emit Arabic *presentation glyphs*, one glyph per item,
 * with dir=rtl yet increasing left-to-right x coordinates. unpdf.extractText
 * concatenates those in visual order. Reconstruct from the per-glyph direction
 * AND geometry, never by reversing the entire PDF/page blindly.
 *
 * Ambiguous layouts are rejected, not returned as apparently correct text.
 * This deliberately does not claim full Unicode BiDi, OCR, layout analysis,
 * Arabic-Indic numerals, punctuation, or mixed-script numeric support.
 */
const RTL_SCRIPT = /\p{Script=Arabic}/u;
const RTL_LETTER = /^\p{Script=Arabic}$/u;
const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const VISUAL_PRESENTATION = /[\uFB50-\uFDFF\uFE70-\uFEFF]/u;
const ARABIC_TOKEN = /^\p{Script=Arabic}+$/u;
const LATIN_WORD = /^[A-Za-z]+$/;
const ASCII_NUMBER = /^[0-9]+$/;
const SPACE = /^ +$/;

export interface PdfDirectionalItem {
  str: string;
  dir?: string;
  width?: number;
  transform?: readonly number[];
  hasEOL?: boolean;
}

function unqualified(): never {
  throw new Error('PDF_RTL_ORDER_UNQUALIFIED');
}

function reversePresentationGlyphs(visual: string): string {
  const logical = [...visual].reverse().join('').normalize('NFKC');
  if (VISUAL_PRESENTATION.test(logical)) unqualified();
  return logical;
}

function repairLine(items: readonly PdfDirectionalItem[]): string {
  const visual = items.map(item => item.str).join('');
  if (!RTL_SCRIPT.test(visual)) return visual;
  if (visual.length > 8192 || !VISUAL_PRESENTATION.test(visual) || visual.trim() !== visual)
    unqualified();

  let previousX = -Infinity;
  let lineY: number | undefined;
  let rtlGlyphs = 0;
  let latin = false;
  let asciiDigits = false;
  for (const item of items) {
    if (!Array.isArray(item.transform) || item.transform.length < 6 ||
        !Number.isFinite(item.transform[4]) || !Number.isFinite(item.transform[5]) ||
        typeof item.width !== 'number' || !Number.isFinite(item.width) || item.width < 0)
      unqualified();
    const x = item.transform[4], y = item.transform[5];
    // Only a single, ordered visual baseline is qualified. Columns, rotations,
    // overlaps and position resets are not safely reversible from these items.
    if (x + 0.05 < previousX || (lineY !== undefined && Math.abs(y - lineY) > 0.4))
      unqualified();
    previousX = x;
    lineY ??= y;
    const chars = [...item.str];
    const isArabic = chars.some(c => RTL_SCRIPT.test(c));
    if (isArabic) {
      if (chars.length !== 1 || !RTL_LETTER.test(chars[0])) unqualified();
      const ch = chars[0];
      if (LETTER.test(ch)) {
        if (item.dir !== 'rtl' || item.width <= 0) unqualified();
        rtlGlyphs++;
      } else if (MARK.test(ch)) {
        // PDF.js emits zero-width Arabic combining marks with dir=ltr. Their
        // observed visual order is repaired only on an Arabic-only baseline.
        if (item.width !== 0) unqualified();
      } else unqualified(); // No numeric, punctuation or bidi control guesses.
    } else if (SPACE.test(item.str)) {
      // Spaces between RTL glyphs may have dir=ltr.
    } else if (LATIN_WORD.test(item.str)) {
      if (item.dir !== 'ltr') unqualified();
      latin = true;
    } else if (ASCII_NUMBER.test(item.str)) {
      if (item.dir !== 'ltr') unqualified();
      asciiDigits = true;
    } else unqualified();
  }
  if (!rtlGlyphs || (latin && asciiDigits)) unqualified();

  // We only accept these unambiguous token classes; literal FTS/Unicode bidi
  // metadata cannot tell us how other script punctuation was laid out.
  const parts = visual.split(/( +)/u);
  if (parts.some(part => part !== '' && !SPACE.test(part) &&
      !ARABIC_TOKEN.test(part) && !LATIN_WORD.test(part) && !ASCII_NUMBER.test(part)))
    unqualified();

  if (!latin) {
    // Visual RTL baseline: reverse the *token order* but keep ASCII numerals
    // internally left-to-right (e.g. visual "عالم 123 مرحبا").
    return parts.reverse().map(part =>
      ARABIC_TOKEN.test(part) ? reversePresentationGlyphs(part) : part).join('');
  }

  // LTR-major baseline: retain Latin positions and reverse only each adjoining
  // RTL island (including inter-word spaces), never the whole mixed line.
  const rebuilt: string[] = [];
  for (let i = 0; i < parts.length;) {
    if (!ARABIC_TOKEN.test(parts[i])) {
      rebuilt.push(parts[i++]);
      continue;
    }
    let end = i;
    while (end + 2 < parts.length && SPACE.test(parts[end + 1]) &&
           ARABIC_TOKEN.test(parts[end + 2])) end += 2;
    rebuilt.push(reversePresentationGlyphs(parts.slice(i, end + 1).join('')));
    i = end + 1;
  }
  return rebuilt.join('');
}

/**
 * Require exact concordance between the text assembled from PDF.js items and
 * unpdf's original page. If the upstream extractor performs other joining or
 * geometric reading-order logic, do not guess what an RTL layout meant.
 */
export function restoreQualifiedPdfArabic(
  rawPage: string, untypedItems: readonly unknown[],
): string {
  if (!RTL_SCRIPT.test(rawPage)) return rawPage;
  if (rawPage.length > 500_000 || untypedItems.length > 50_000) unqualified();
  const lines: PdfDirectionalItem[][] = [];
  let current: PdfDirectionalItem[] = [];
  for (const value of untypedItems) {
    if (!value || typeof value !== 'object' ||
        !('str' in value) || typeof (value as {str: unknown}).str !== 'string')
      unqualified();
    const item = value as PdfDirectionalItem;
    if (item.str) current.push(item);
    if (item.hasEOL) {
      lines.push(current);
      current = [];
    }
  }
  if (current.length) lines.push(current);
  if (lines.map(line => line.map(item => item.str).join('')).join('\n') !== rawPage)
    unqualified();
  return lines.map(repairLine).join('\n');
}
