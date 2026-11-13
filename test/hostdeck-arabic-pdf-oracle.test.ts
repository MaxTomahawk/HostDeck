import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentAdapter } from '../src/hostdeck/documents.js';

// HD-REQ-0030 / R04-B003: preserve logical Arabic reading order, not just
// visually correct glyphs. This is a KNOWN OPEN failure oracle. Opt in when
// testing PDF extraction; it is not an accepted implementation test.
const chrome = process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE;
test('Arabic PDF extraction returns logical source order (open R04 failure)', {
  skip: process.env.HOSTDECK_TEST_RTL_PDF !== '1'
    ? 'Known open R04 failure; opt in with HOSTDECK_TEST_RTL_PDF=1.'
    : !chrome ? 'HOSTDECK_TEST_BROWSER_EXECUTABLE is required.' : false,
}, async () => {
  const temporaryParent = await realpath(os.tmpdir());
  const workspace = await realpath(await mkdtemp(path.join(temporaryParent, 'hostdeck-arabic-bidi-')));
  assert.equal(path.dirname(workspace), temporaryParent, 'owned cleanup remains inside canonical temporary directory');
  try {
    const adapter = await DocumentAdapter.create({ workspace, browserExecutable: chrome });
    const logical = 'السلام عليكم';
    const staged = await adapter.handle('hostdeck_write_pdf', {
      path: 'arabic.pdf', markdown: `# PDF bidi fixture\n\n${logical}\n\nBelgië, 中文`,
    }) as { bytes: Uint8Array };
    await writeFile(path.join(workspace, 'arabic.pdf'), staged.bytes);
    const read = await adapter.handle('hostdeck_read_document', {
      path: 'arabic.pdf', page_indexes: [0],
    }) as { content: Array<{ text: string }> };
    assert.equal(read.content.length, 1);
    assert.ok(read.content[0].text.includes('België, 中文'), 'Latin/CJK positive control failed');
    // Never NFKC/reverse/transliterate a corrupted output into a false PASS.
    assert.ok(read.content[0].text.includes(logical),
      'Arabic letters were extracted as visual presentation forms or in reversed logical order');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
