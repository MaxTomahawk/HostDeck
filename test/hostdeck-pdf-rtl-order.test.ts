import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  restoreQualifiedPdfArabic,
  type PdfDirectionalItem,
} from '../src/hostdeck/pdf-rtl.js';

// Fixed, synthetic text-item transcript from the independent RED PDF fixture:
// Markdown: "# PDF bidi fixture\n\nالسلام عليكم\n\nBelgië, 中文".
// Old unpdf result: "PDF bidi fixture\nﻢﻜﻴﻠﻋ مﻼﺴﻟا\nBelgië, 中文".
// Its PDF.js getTextContent contains one RTL presentation glyph per item,
// sorted in increasing x. Original failure remains documented; the expected
// string below is logical source text, NOT reversed/normalized test input.
const raw = 'PDF bidi fixture\nﻢﻜﻴﻠﻋ مﻼﺴﻟا\nBelgië, 中文';
const expected = 'PDF bidi fixture\nالسلام عليكم\nBelgië, 中文';
const visualGlyphs = [...'ﻢﻜﻴﻠﻋ مﻼﺴﻟا'];
const positions = [
  41.99999825, 49.03829751, 55.07265243, 57.74623252,
  60.41981261, 66.86219506, 69.91695504, 76.39154127,
  83.02182434, 91.48818601, 94.48926161,
];
const baseline = 719.66998509375;
const item = (
  str: string, x: number, y: number, dir: 'ltr' | 'rtl',
  width = 6, hasEOL = false,
): PdfDirectionalItem =>
  ({ str, dir, width, hasEOL, transform: [1,0,0,1,x,y] });

const actualPdfItems: PdfDirectionalItem[] = [
  item('PDF bidi fixture', 41.99999825, 771.41998294, 'ltr', 123.038081),
  item('', 41.99999825, baseline, 'ltr', 0, true),
  ...visualGlyphs.map((glyph, index) =>
    item(glyph, positions[index], baseline, glyph === ' ' ? 'ltr' : 'rtl',
      glyph === ' ' ? 4 : 6)),
  item('', 41.99999825, 679.16998678, 'ltr', 0, true),
  item('België, 中文', 41.99999825, 679.16998678, 'ltr', 58.6631989),
];

function captureInline(visual: string): PdfDirectionalItem[] {
  let x = 42;
  const out: PdfDirectionalItem[] = [];
  for (const segment of visual.match(/\p{Script=Arabic}|[0-9]+|[A-Za-z]+| +/gu) ?? []) {
    const glyph = /^\p{Script=Arabic}$/u.test(segment);
    out.push(item(segment, x, baseline, glyph ? 'rtl' : 'ltr', glyph ? 6 : 8));
    x += 10;
  }
  return out;
}

test('HD-REQ-0030 RED baseline is not logical; item-qualified repair preserves unrelated Unicode', () => {
  assert.equal(raw.includes('السلام عليكم'), false, 'must preserve the original RED failure');
  assert.equal(restoreQualifiedPdfArabic(raw, actualPdfItems), expected);
  assert.ok(expected.includes('België, 中文'));
});

test('HD-B007 root RED: mixed Latin island cannot establish paragraph base direction', () => {
  // Root's genuine source-review RED: the same increasing-x RTL glyph
  // transcript admits incompatible logical orders. The previous synthetic
  // label "an LTR Arabic island retain digit and Latin order" was NOT
  // paragraph-direction evidence. Do not turn it into a false repair PASS.
  const observed = 'ﻢﻟﺎﻋ API ﺎﺒﺣﺮﻣ';
  const items = captureInline(observed);
  assert.equal(items.map(i=>i.str).join(''),observed);
  const rtlItems = items.filter(i=>i.dir==='rtl');
  assert.ok(rtlItems.length > 0 && rtlItems.every(i=>i.str.length===1));
  assert.ok(items.some(i=>i.str==='API' && i.dir==='ltr'));
  assert.ok(items.every((i,index)=>index===0 ||
    (i.transform?.[4] ?? -Infinity) >= (items[index-1].transform?.[4] ?? Infinity)));
  assert.throws(
    () => restoreQualifiedPdfArabic(observed,items),
    /PDF_RTL_ORDER_UNQUALIFIED/,
    'RTL-major "مرحبا API عالم" must NOT be silently changed to "عالم API مرحبا"');

  // Preserve the previous reported mixed-script fixtures as negative
  // oracles. Their old positive assertions were never qualified.
  for (const mixed of [
    'ﻢﻟﺎﻋ 123 ﺎﺒﺣﺮﻣ',
    'Hello ﺎﺒﺣﺮﻣ World',
    'ﻢﻟﺎﻋ API ﺎﺒﺣﺮﻣ',
  ]) {
    assert.throws(
      () => restoreQualifiedPdfArabic(mixed,captureInline(mixed)),
      /PDF_RTL_ORDER_UNQUALIFIED/,
      'Arabic+Latin/numerals must fail closed without base-direction evidence');
  }
});

test('previously logical Unicode Arabic is not falsely claimed as repaired', () => {
  const logical = 'السلام عليكم';
  assert.throws(
    () => restoreQualifiedPdfArabic(logical,captureInline(logical)),
    /PDF_RTL_ORDER_UNQUALIFIED/,
    'No presentation glyph or base-direction proof: keep the original oracle open');
});

test('unknown Arabic diacritics, direction, markup and geometry fail closed', () => {
  // Visual form without a qualified presentation glyph is not evidence that
  // a logical sequence can safely be reconstructed.
  assert.throws(
    () => restoreQualifiedPdfArabic('ةَدْرَو',captureInline('ةَدْرَو')),
    /PDF_RTL_ORDER_UNQUALIFIED/);
  const marked = [...'ﻋَﻠﻰ'].map((glyph,index) =>
    item(glyph,42+index*6,baseline, /^\p{M}$/u.test(glyph)?'ltr':'rtl',
      /^\p{M}$/u.test(glyph)?0:6));
  assert.throws(
    () => restoreQualifiedPdfArabic('ﻋَﻠﻰ',marked),
    /PDF_RTL_ORDER_UNQUALIFIED/, 'Combining marks are not qualified by glyph reversal');
  assert.throws(
    () => restoreQualifiedPdfArabic('ﻢﻜﻴﻠﻋ ؟',captureInline('ﻢﻜﻴﻠﻋ ؟')),
    /PDF_RTL_ORDER_UNQUALIFIED/);
  assert.throws(
    () => restoreQualifiedPdfArabic('ﻢﻜﻴﻠﻋ',captureInline('ﻢﻜﻴﻠﻋ').map(i=>({...i,dir:'ltr'}))),
    /PDF_RTL_ORDER_UNQUALIFIED/);
  assert.throws(
    () => restoreQualifiedPdfArabic('ﻢﻜﻴﻠﻋ',captureInline('ﻢﻜﻴﻠﻋ').map((i,j)=>({
      ...i,transform:[1,0,0,1,100-j*10,baseline],
    }))),
    /PDF_RTL_ORDER_UNQUALIFIED/);
  assert.throws(
    () => restoreQualifiedPdfArabic(raw,actualPdfItems.slice(0,-1)),
    /PDF_RTL_ORDER_UNQUALIFIED/);
  assert.throws(
    () => restoreQualifiedPdfArabic('ﻢﻜﻴﻠﻋ',[{type:'beginMarkedContent'}]),
    /PDF_RTL_ORDER_UNQUALIFIED/);
});

test('normal LTR, Latin accent and CJK text remain byte-for-byte unchanged', () => {
  const plain = 'Page one\nBelgië, 中文';
  assert.equal(restoreQualifiedPdfArabic(plain,[]),plain);
});
