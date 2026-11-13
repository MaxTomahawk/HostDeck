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
        !item.transform.slice(0,6).every(Number.isFinite) ||
        item.transform[0] <= 0 || item.transform[3] <= 0 ||
        Math.abs(item.transform[1]) > 0.000001 || Math.abs(item.transform[2]) > 0.000001 ||
        typeof item.width !== 'number' || !Number.isFinite(item.width) || item.width < 0)
      unqualified();
    const x = item.transform[4], y = item.transform[5];
    // Only the constrained glyph baseline below is reconstructed. This is not
    // general paragraph, column or layout reconstruction.
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
        // Zero-width combining marks may be emitted before/after their base
        // with producer-specific ordering. The original mark/ligature oracle
        // is still OPEN: never imply that reversing this case is verified.
        unqualified();
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
  // PDF.js per-glyph dir=rtl, a common y, and increasing visual x do NOT
  // establish the paragraph base direction. The presence of an LTR island
  // (Latin OR ASCII digits) cannot be used to infer an LTR-major paragraph:
  // the same visual stream can have multiple incompatible logical orders.
  // Reject all such mixed-direction lines until explicit base-direction
  // evidence is qualified. Do not silently return a plausible false repair.
  if (!rtlGlyphs || latin || asciiDigits) unqualified();

  // We only accept these unambiguous token classes; literal FTS/Unicode bidi
  // metadata cannot tell us how other script punctuation was laid out.
  const parts = visual.split(/( +)/u);
  if (parts.some(part => part !== '' && !SPACE.test(part) &&
      !ARABIC_TOKEN.test(part) && !LATIN_WORD.test(part) && !ASCII_NUMBER.test(part)))
    unqualified();

  // Only the presentation-glyph, Arabic-and-spaces-only baseline has a
  // qualified reconstruction route. Never infer paragraph direction from
  // Latin/numeric presence or from a plausible normalized output.
  return parts.reverse().map(part =>
    ARABIC_TOKEN.test(part) ? reversePresentationGlyphs(part) : part).join('');
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
