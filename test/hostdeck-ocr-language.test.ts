import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseToolArguments } from '../src/hostdeck/contracts.js';
import { DesktopAdapter, inspectDesktopIdentity } from '../src/hostdeck/desktop.js';

test('OCR accepts an explicit recognizer language while keeping the default and authority bound', () => {
  const base = { device_id: 'device_a', session_id: 1, window_id: 'window_a' };
  assert.equal(parseToolArguments('hostdeck_ocr_screen', { ...base, language: 'nl-NL' }).language, 'nl-NL');
  assert.equal(parseToolArguments('hostdeck_ocr_screen', base).language, undefined);
  for (const language of ['', 'nl_NL', 'nl-NL\n', ' nl-NL', 'x'.repeat(64)])
    assert.throws(() => parseToolArguments('hostdeck_ocr_screen', { ...base, language }), /INVALID_ARGUMENTS/);
  assert.throws(() => parseToolArguments('hostdeck_ocr_screen', { ...base, language: 'nl-NL', session_id: 0 }));
  assert.throws(() => parseToolArguments('hostdeck_ocr_screen', { ...base, language: 'nl-NL', user_sid: 'forged' }));
});

// A wrong native language choice loses the accent in the real Windows engine.
// This uses one owned off-screen, non-activating window and never sends input.
test('actual Windows OCR selects Dutch, refuses unavailable language and restores the profile default', {
  skip: process.platform !== 'win32' || process.env.HOSTDECK_TEST_OCR_LANGUAGE !== '1'
    ? 'Opt in with HOSTDECK_TEST_OCR_LANGUAGE=1 on Windows with Dutch OCR installed' : false,
}, async t => {
  const parent = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'hostdeck-ocr-language-')));
  assert.equal(path.dirname(root), parent, 'cleanup stays in the exact owned temporary directory');
  const statePath = path.join(root, 'state.json');
  const title = 'HostDeck OCR ' + path.basename(root);
  const executable = process.env.HOSTDECK_TEST_WORKER
    ?? path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
  let fixture: ReturnType<typeof spawn> | undefined;
  let adapter: DesktopAdapter | undefined;
  try {
    const identity = await inspectDesktopIdentity(executable);
    assert.ok(identity.eligible && identity.sid, 'an unprivileged interactive Windows identity is required');
    fixture = spawn(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-STA', '-File', path.resolve('test/fixtures/hostdeck-ocr-language.ps1'),
       '-StatePath', statePath, '-Title', title], { windowsHide: true, stdio: 'ignore' });
    const deadline = Date.now() + 8000;
    let fixtureState: { foreground_is_fixture: boolean };
    while (true) {
      try { fixtureState = JSON.parse(await readFile(statePath, 'utf8')); break; } catch {
        assert.ok(Date.now() < deadline && fixture.exitCode === null, 'owned OCR window did not become ready');
        await new Promise(resolve => setTimeout(resolve, 60));
      }
    }
    assert.equal(fixtureState.foreground_is_fixture, false, 'the owned fixture must not take foreground focus');
    adapter = await DesktopAdapter.create({ executable, expectedSid: identity.sid!, identity,
      storeArtifact: async () => { throw new Error('UNEXPECTED_CAPTURE_ARTIFACT'); },
      artifactBytes: async () => null, reauthorize: async () => {},
    });
    const context = { ownerId: 'ocr-language-test', deviceId: 'fixture', executorId: 'fixture',
      sessionId: identity.session_id, sessionIds: [identity.session_id] };
    const listed = await adapter.handle('hostdeck_list_windows', { session_id: identity.session_id }, context) as
      { windows: Array<{ title: string; window_id: string }> };
    const window = listed.windows.find(item => item.title === title);
    assert.ok(window, 'exact owned OCR window was not listed');
    const args = { session_id: identity.session_id, window_id: window.window_id };
    type Ocr = { text: string; recognizer_language: string; available_recognizer_languages: string[];
      confidence: number | null; confidence_status: string; language_coverage: string };
    const before = await adapter.handle('hostdeck_ocr_screen', args, context) as Ocr;
    let dutch: Ocr;
    try { dutch = await adapter.handle('hostdeck_ocr_screen', { ...args, language: 'nl-NL' }, context) as Ocr; }
    catch (error) {
      if (error instanceof Error && error.message === 'OCR_LANGUAGE_UNAVAILABLE') {
        t.skip('Dutch OCR language is not installed; no language package installed by this test'); return;
      }
      throw error;
    }
    assert.equal(dutch.recognizer_language, 'nl-NL', 'explicit Dutch must not silently use the profile recognizer');
    assert.ok(dutch.text.includes('België'), 'the actual recognized text must retain the Dutch accent');
    assert.ok(dutch.available_recognizer_languages.includes('nl-NL'));
    assert.equal(dutch.confidence, null);
    assert.equal(dutch.confidence_status, 'unmeasured');
    assert.equal(dutch.language_coverage, 'not_verified', 'language selection does not prove every script was recognized');
    await assert.rejects(adapter.handle('hostdeck_ocr_screen', { ...args, language: 'zz-ZZ' }, context),
      /^Error: OCR_LANGUAGE_UNAVAILABLE$/, 'unavailable language must not fall back silently');
    const after = await adapter.handle('hostdeck_ocr_screen', args, context) as Ocr;
    assert.equal(after.recognizer_language, before.recognizer_language, 'explicit selection must not change profile defaults');
    t.diagnostic(JSON.stringify({ scope: 'owned synthetic window only', fixture_foreground: fixtureState.foreground_is_fixture,
      before, dutch, unavailable_language: 'OCR_LANGUAGE_UNAVAILABLE', after }));
  } finally {
    await adapter?.dispose();
    if (fixture && fixture.exitCode === null) {
      fixture.kill();
      await new Promise(resolve => { if (fixture!.exitCode !== null) resolve(undefined); else fixture!.once('close', resolve); });
    }
    await unlink(statePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(root);
  }
});
