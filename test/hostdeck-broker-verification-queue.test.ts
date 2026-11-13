import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Queue-selection regression only. The fixture common shim replaces ONLY the
// SYSTEM identity assertion and root location; all parsing/write functions and
// the actual Broker.Verify script remain real. Fresh invalid envelopes must be
// processed and denied, not accepted as authenticated or elevated work.
async function fixture(stale: 'reserved' | 'invalid-name') {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'hostdeck-verify-queue-')));
  assert.equal(path.dirname(root), parent);
  for (const rel of ['inbox/fixture-client', 'outbox/fixture-client', 'state', 'trust', 'audit'])
    await fs.mkdir(path.join(root, rel), { recursive: true });
  await fs.writeFile(path.join(root, 'fixture-only.marker'), 'not a production broker');
  await fs.writeFile(path.join(root, 'trust/clients.json'), JSON.stringify({ clients: [] }));
  const implementation = path.resolve('windows/privilege/implementation');
  await fs.copyFile(path.join(implementation, 'Broker.Verify.ps1'), path.join(root, 'Broker.Verify.ps1'));
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  await fs.writeFile(path.join(root, 'Bridge.Common.ps1'),
    `. ${quote(path.join(implementation, 'Bridge.Common.ps1'))}\n` +
    `$script:BridgeRoot=${quote(root)}\n` +
    `function Assert-System { if(-not(Test-Path -LiteralPath (Join-Path $script:BridgeRoot 'fixture-only.marker'))){throw 'FIXTURE_ONLY'} }\n`);
  const invalidEnvelope = JSON.stringify({ payload_base64: '', padding: 'x'.repeat(180) }); // sufficient size, deliberately empty payload
  const oldNames: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = stale === 'reserved' ? randomUUID() : `not-a-uuid-${i}`;
    const file = path.join(root, 'inbox/fixture-client', id + '.verify.json');
    await fs.writeFile(file, invalidEnvelope);
    await fs.utimes(file, new Date(0), new Date(0));
    oldNames.push(path.basename(file));
    if (stale === 'reserved') await fs.writeFile(path.join(root, 'state', id + '.verify.reserved'), '');
  }
  const fresh = Array.from({ length: 11 }, () => randomUUID());
  for (const id of fresh)
    await fs.writeFile(path.join(root, 'inbox/fixture-client', id + '.verify.json'), invalidEnvelope);
  // The script sorts CreationTimeUtc rather than LastWriteTime. Set actual
  // creation time in this owned fixture, without touching production files.
  const prepare = `$ErrorActionPreference='Stop'\n` + oldNames.map(name =>
    `(Get-Item -LiteralPath ${quote(path.join(root, 'inbox/fixture-client', name))}).CreationTimeUtc=[DateTime]::UtcNow.AddDays(-1)\n`).join('');
  await fs.writeFile(path.join(root, 'prepare.ps1'), prepare);
  const powershell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const run = (file: string) => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', file],
    { windowsHide: true, timeout: 15000, stdio: 'pipe' });
  run(path.join(root, 'prepare.ps1'));
  return { root, fresh, oldNames,
    tick: () => run(path.join(root, 'Broker.Verify.ps1')),
    acknowledgements: async () => {
      const names = await fs.readdir(path.join(root, 'outbox/fixture-client'));
      return Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(root, 'outbox/fixture-client', name), 'utf8'))));
    },
    close: async () => {
      assert.equal(path.dirname(await fs.realpath(root)), parent);
      await fs.rm(root, { recursive: true });
    } };
}

for (const stale of ['reserved', 'invalid-name'] as const) {
  test(`verification queue skips ${stale} inputs before its ten-item cap and preserves originals`, {
    skip: process.platform !== 'win32' ? 'actual Windows PowerShell fixture' : false,
  }, async t => {
    const f = await fixture(stale); t.after(f.close);
    f.tick();
    const first = await f.acknowledgements();
    assert.equal(first.length, 10, 'old ineligible inputs must not starve the next ten unprocessed verification reports');
    for (const ack of first) {
      assert.ok(f.fresh.includes(ack.verification_id));
      assert.equal(ack.status, 'denied');
      assert.equal(ack.reason, 'INVALID_ENVELOPE', 'the fixture does not bypass envelope validation');
    }
    f.tick();
    const second = await f.acknowledgements();
    assert.equal(second.length, 11, 'the remaining report must make progress on the next tick');
    assert.equal(new Set(second.map(ack => ack.verification_id)).size, 11, 'no already reserved report may be processed twice');
    const inputs = await fs.readdir(path.join(f.root, 'inbox/fixture-client'));
    for (const name of f.oldNames) assert.ok(inputs.includes(name), 'original inputs remain retained');
    assert.equal(inputs.length, 21);
  });
}
