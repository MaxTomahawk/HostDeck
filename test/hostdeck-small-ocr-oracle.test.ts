import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopAdapter, inspectDesktopIdentity } from '../src/hostdeck/desktop.js';

// HD-REQ-0054: opt-in R04 small-field OCR oracle, separate from PDF extraction.
// Requires a disposable owned window and a real interactive Windows session.
// This intentionally exposes a known open recognition failure until qualified.
test('small Unicode UI field OCR preserves words and reports honest capability', {
  skip: process.platform !== 'win32' || process.env.HOSTDECK_TEST_SMALL_OCR !== '1'
    ? 'Opt in on interactive Windows with HOSTDECK_TEST_SMALL_OCR=1' : false,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-small-ocr-'));
  const title = 'HostDeck small OCR ' + path.basename(root);
  const statePath = path.join(root, 'fixture-state.json');
  const executable = process.env.HOSTDECK_TEST_WORKER
    ?? path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
  let fixture: ReturnType<typeof spawn> | undefined;
  let adapter: DesktopAdapter | undefined;
  try {
    const identity = await inspectDesktopIdentity(executable);
    if (!identity.eligible || !identity.sid) { t.skip('No eligible unprivileged Windows desktop'); return; }
    fixture = spawn(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-STA', '-File', path.resolve('test/fixtures/hostdeck-ui.ps1'),
       '-StatePath', statePath, '-Title', title], { windowsHide: false, stdio: 'ignore' });
    adapter = await DesktopAdapter.create({
      executable, expectedSid: identity.sid, identity,
      storeArtifact: async () => { throw new Error('UNEXPECTED_ARTIFACT'); },
      artifactBytes: async () => null, reauthorize: async () => {},
    });
    const context = { ownerId: 'small-ocr-test', deviceId: 'fixture',
      executorId: 'fixture', sessionId: identity.session_id, sessionIds: [identity.session_id] };
    const until = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 6000;
      while (Date.now() < end) {
        try { if (await check()) return; } catch { /* own fixture may still be starting */ }
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      assert.fail('Owned OCR fixture not ready');
    };
    await until(async () => { await readFile(statePath); return true; });
    let window: { window_id: string } | undefined;
    await until(async () => {
      const list = await adapter!.handle('hostdeck_list_windows', { session_id: identity.session_id }, context) as
        { windows: Array<{ title: string; window_id: string }> };
      window = list.windows.find(item => item.title === title);
      return !!window;
    });
    const args = { session_id: identity.session_id, window_id: window!.window_id };
    const tree = await adapter.handle('hostdeck_read_ui_tree', { ...args, max_depth: 5 }, context) as
      { elements: Array<{ automation_id: string; element_ref: string }> };
    const input = tree.elements.find(item => item.automation_id === 'HostDeckFixtureText');
    assert.ok(input, 'Owned textbox missing');
    const expected = 'België 中文 العربية';
    await adapter.handle('hostdeck_set_ui_value', { ...args, element_ref: input.element_ref, value: expected }, context);
    await until(async () => JSON.parse(await readFile(statePath, 'utf8')).text === expected);
    let ocr: { text: string; confidence: number | null; confidence_status: string;
      recognizer_language?: string | null; language_coverage?: string };
    try { ocr = await adapter.handle('hostdeck_ocr_screen', args, context) as typeof ocr; }
    catch (error) {
      if (error instanceof Error && error.message === 'OCR_LANGUAGE_UNAVAILABLE') {
        t.skip('No installed OCR engine language; bounded capability refusal confirmed'); return;
      }
      throw error;
    }
    assert.equal(ocr.confidence, null, 'Windows OCR does not provide measured confidence');
    assert.equal(ocr.confidence_status, 'unmeasured');
    assert.equal(ocr.language_coverage, 'not_verified');
    assert.ok(typeof ocr.recognizer_language === 'string' && ocr.recognizer_language.length > 1);
    assert.ok(ocr.text.includes(expected),
      'Small-field multilingual OCR incomplete; never silently transliterate or claim support');
  } finally {
    await adapter?.dispose();
    if (fixture) {
      if (fixture.exitCode === null) {
        fixture.kill();
        await new Promise(resolve => { if (fixture!.exitCode !== null) resolve(undefined);
          else fixture!.once('close', resolve); });
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
