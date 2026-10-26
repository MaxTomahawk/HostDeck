/**
 * SQLite FTS5 unicode61/remove_diacritics=2 is used for ordinary terms.
 * Chinese Han queries of 2+ code points use separately stored overlapping
 * bigrams. FTS5 trigram does NOT solve a 2-code-point substring query.
 */
const HAN_RUN = /\p{Script=Han}+/gu;
const HAN_ONLY = /^\p{Script=Han}+$/u;

export function hanBigrams(text: string, maxCharacters = 200_000): string {
  const result: string[] = [];
  for (const match of text.slice(0, maxCharacters).matchAll(HAN_RUN)) {
    const chars = [...match[0]];
    for (let i = 0; i + 1 < chars.length; i++) result.push(chars[i] + chars[i + 1]);
  }
  return result.join(' ');
}

export interface ParsedFullTextQuery {
  ftsMatch: string;
  hanRuns: string[];
  terms: string[];
  normalization: 'unicode61_remove_diacritics_2_plus_exact_han';
}

function quoted(value: string): string {
  // Every user token becomes an escaped literal phrase, never raw FTS syntax.
  return '"' + value.replace(/"/g, '""') + '"';
}

export function parseFullTextQuery(query: string): ParsedFullTextQuery {
  if (typeof query !== 'string' || query.length < 2 || query.length > 256 || /[\u0000-\u001f\u007f]/u.test(query))
    throw new Error('FULLTEXT_QUERY_INVALID');
  const normalized = query.normalize('NFC');
  const hanRuns = [...normalized.matchAll(HAN_RUN)].map(match => match[0]);
  if (hanRuns.some(run => [...run].length < 2)) throw new Error('FULLTEXT_HAN_MIN_TWO');
  const nonHan = normalized.replace(HAN_RUN, ' ');
  const terms = nonHan.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const term of terms) tokens.push('body:' + quoted(term));
  for (const run of hanRuns) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) tokens.push('grams:' + quoted(chars[i] + chars[i + 1]));
  }
  if (tokens.length === 0 || tokens.length > 32 || terms.length > 16) throw new Error('FULLTEXT_QUERY_LIMIT');
  return {
    ftsMatch: tokens.join(' AND '),
    hanRuns,
    terms,
    normalization: 'unicode61_remove_diacritics_2_plus_exact_han',
  };
}

/** Bigram AND may return disjoint hits; this final source-text check is required. */
export function satisfiesHanSubstrings(text: string, runs: readonly string[]): boolean {
  return runs.every(run => text.normalize('NFC').includes(run));
}

export function makeSnippet(content: string, query: string, maxLength = 220): string {
  const safeLength = Math.max(40, Math.min(maxLength, 300));
  const needle = query.normalize('NFC').trim();
  const normalized = content.normalize('NFC');
  const firstHan = [...needle.matchAll(HAN_RUN)][0]?.[0];
  let at = firstHan ? normalized.indexOf(firstHan) : -1;
  if (at < 0) {
    const first = needle.replace(HAN_RUN, ' ').trim().split(/\s+/)[0] ?? '';
    const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    at = first ? fold(normalized).indexOf(fold(first)) : -1;
  }
  const start = Math.max(0, at < 0 ? 0 : at - 60);
  const slice = normalized.slice(start, start + safeLength).replace(/[\u0000-\u001f]+/gu, ' ');
  return (start ? '…' : '') + slice + (start + safeLength < normalized.length ? '…' : '');
}
