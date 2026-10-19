import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserRuntime } from '../src/hostdeck/user-runtime.js';

async function fixture(t: any, authorize = async () => true) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hostdeck-runtime-'));
  const runtime = await UserRuntime.create({ deviceId: 'device_a', workspace, authorize,
    environment: { SystemRoot: process.env.SystemRoot ?? '', HOSTDECK_TEST_ALLOWED: 'allowed' },
    shells: process.platform === 'win32' ? { powershell: path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') } : {} });
  t.after(async () => { await runtime.dispose(); await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 }); });
  const invoke = (name: string, args: object) => runtime.invoke(`hostdeck_${name}`, { device_id: 'device_a', ...args });
  return { workspace, runtime, invoke };
}

test('denied, foreign-device and malformed requests cause no file effects', async t => {
  const { workspace, runtime, invoke } = await fixture(t, async () => false);
  await assert.rejects(invoke('write_file', { path: 'denied.txt', content: 'private' }), /DENIED/);
  await assert.rejects(runtime.invoke('hostdeck_write_file', { device_id: 'device_b', path: 'other.txt', content: 'x' }), /DENIED/);
  await assert.rejects(invoke('write_file', { path: 'forged.txt', content: 'x', authenticated: true }), /INVALID_ARGUMENTS/);
  await assert.rejects(invoke('unknown_tool', {}), /UNKNOWN_OPERATION/);
  assert.deepEqual(await fs.readdir(workspace), []);
});

test('real text writes, line snapshots, tails and count-checked edits', async t => {
  const { workspace, invoke } = await fixture(t);
  await invoke('write_file', { path: 'notes.txt', content: 'one\r\ntwo\r\nthree\n' });
  assert.deepEqual(await invoke('read_file', { path: 'notes.txt', offset: -2, length: 1 }), {
    content: 'two', total_lines: 3, offset: 1, next_offset: 2,
  });
  const before = await fs.readFile(path.join(workspace, 'notes.txt'));
  await assert.rejects(invoke('edit_text', { path: 'notes.txt', old_text: 'one', new_text: 'changed', expected_replacements: 2 }), /EDIT_CONFLICT/);
  assert.deepEqual(await fs.readFile(path.join(workspace, 'notes.txt')), before);
  await invoke('edit_text', { path: 'notes.txt', old_text: 'two', new_text: 'café' });
  assert.match((await invoke('read_file', { path: 'notes.txt' })).content as string, /café/);
  await invoke('write_file', { path: 'notes.txt', content: 'last', mode: 'append' });
  assert.equal((await invoke('read_file', { path: 'notes.txt', offset: 100 })).content, '');
  assert.equal((await invoke('file_info', { path: 'notes.txt', hash: 'sha256' })).sha256,
    (await import('node:crypto')).createHash('sha256').update(await fs.readFile(path.join(workspace, 'notes.txt'))).digest('hex'));
});

test('path hygiene rejects outside workspace, streams and directory junctions', async t => {
  const { workspace, invoke } = await fixture(t);
  await assert.rejects(invoke('write_file', { path: '../outside.txt', content: 'x' }), /PATH_DENIED/);
  await assert.rejects(invoke('write_file', { path: 'file.txt:stream', content: 'x' }), /PATH_DENIED/);
  await fs.mkdir(path.join(workspace, 'real'));
  await fs.symlink(path.join(workspace, 'real'), path.join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(invoke('write_file', { path: 'link/escaped.txt', content: 'x' }), /PATH_DENIED/);
  assert.deepEqual(await fs.readdir(path.join(workspace, 'real')), []);
});

test('revocation while a read-modify-write is prepared prevents its write', async t => {
  let admits = 0;
  const { workspace, invoke } = await fixture(t, async () => ++admits <= 2);
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'original');
  await assert.rejects(invoke('edit_text', { path: 'notes.txt', old_text: 'original', new_text: 'changed' }), /DENIED/);
  assert.equal(await fs.readFile(path.join(workspace, 'notes.txt'), 'utf8'), 'original');
});

test('runtime bounds admitted requests even when the authorizer stalls', async t => {
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const { runtime, invoke } = await fixture(t, async () => { await stalled; return true; });
  const pending = Array.from({ length: 32 }, () => invoke('write_file', { path: 'queued.txt', content: 'x' }));
  try {
    await assert.rejects(Promise.race([
      invoke('write_file', { path: 'overflow.txt', content: 'x' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QUEUE_NOT_BOUNDED')), 100)),
    ]), /LIMIT_EXCEEDED/);
  } finally { release(); await Promise.all(pending); }
  await runtime.dispose();
  await assert.rejects(invoke('write_file', { path: 'closed.txt', content: 'x' }), /DENIED/);
});

test('actual Windows command returns output, exit receipt and an owned handle', { skip: process.platform !== 'win32' }, async t => {
  const { invoke } = await fixture(t);
  const started = await invoke('start_process', {
    command: "Write-Output 'hello'; [Console]::Error.WriteLine('warning'); exit 7", timeout_ms: 5000,
  });
  assert.equal(started.state, 'exited');
  assert.equal(started.exit_code, 7);
  assert.match(started.output as string, /hello/);
  assert.match(started.output as string, /warning/);
  assert.match(started.process_id as string, /^[A-Za-z0-9_-]+$/);
  const result = await invoke('read_process', { process_id: started.process_id, offset: -1, limit: 1 });
  assert.equal(result.total_lines, 2, JSON.stringify(started.output));
  await assert.rejects(invoke('read_process', { process_id: 'not_owned' }), /UNKNOWN_PROCESS/);
});

test('observation timeout leaves an owned command alive for pipe input', { skip: process.platform !== 'win32' }, async t => {
  const { invoke } = await fixture(t);
  const started = await invoke('start_process', { command: '$s = [Console]::ReadLine(); Write-Output $s', timeout_ms: 1 });
  assert.equal(started.state, 'running');
  const result = await invoke('interact_process', { process_id: started.process_id, input: 'hello pipe\n', timeout_ms: 5000 });
  assert.equal(result.state, 'exited');
  assert.match(result.output as string, /hello pipe/);
  assert.equal(result.pty, false);
});

test('spawn requires admission and does not inherit unrelated parent secrets', { skip: process.platform !== 'win32' }, async t => {
  const denied = await fixture(t, async () => false);
  await assert.rejects(denied.invoke('start_process', { command: "Set-Content marker.txt 'x'" }), /DENIED/);
  assert.deepEqual(await fs.readdir(denied.workspace), []);
  const { invoke } = await fixture(t);
  process.env.HOSTDECK_TEST_PRIVATE = 'must-not-inherit';
  t.after(() => { delete process.env.HOSTDECK_TEST_PRIVATE; });
  const result = await invoke('start_process', {
    command: 'Write-Output $env:HOSTDECK_TEST_ALLOWED; Write-Output $env:HOSTDECK_TEST_PRIVATE', timeout_ms: 5000,
  });
  assert.match(result.output as string, /allowed/);
  assert.doesNotMatch(result.output as string, /must-not-inherit/);
  await assert.rejects(invoke('start_process', { command: 'echo example', shell: 'wsl' }), /UNAVAILABLE/);
});

test('command output retention is bounded and explicitly reported', { skip: process.platform !== 'win32' }, async t => {
  const { invoke } = await fixture(t);
  const result = await invoke('start_process', { command: "[Console]::Write('x' * 1200000)", timeout_ms: 5000 });
  assert.equal(result.state, 'exited');
  assert.equal(result.output_truncated, true);
  assert.equal(result.retained, 'prefix');
  assert.ok(Buffer.byteLength(result.output as string) <= 1024 * 1024);
});

test('a blocked pipe input has a deadline and cannot queue another write', { skip: process.platform !== 'win32' }, async t => {
  const { invoke } = await fixture(t);
  const started = await invoke('start_process', { command: 'Start-Sleep -Seconds 30', timeout_ms: 1 });
  const begin = Date.now();
  const pending = invoke('interact_process', { process_id: started.process_id, input: '€'.repeat(100000), timeout_ms: 20 });
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(invoke('interact_process', { process_id: started.process_id, input: 'more', timeout_ms: 20 }), /INPUT_BUSY/);
  const result = await pending;
  assert.ok(Date.now() - begin < 1500);
  assert.equal(result.input_delivery, 'uncertain');
  assert.equal(result.retry_safe, false);
});

test('process path errors do not expose underlying filesystem messages', { skip: process.platform !== 'win32' }, async t => {
  const { invoke } = await fixture(t);
  await assert.rejects(invoke('start_process', { command: 'echo example', working_directory: 'missing' }),
    (error: Error) => error.message === 'IO_ERROR');
});

test('split UTF-8 output and Unicode truncation preserve complete characters', { skip: process.platform !== 'win32' }, async t => {
  const { invoke } = await fixture(t);
  const split = await invoke('start_process', {
    command: '$o = [Console]::OpenStandardOutput(); $o.WriteByte(0xE2); Start-Sleep -Milliseconds 30; $o.WriteByte(0x82); $o.WriteByte(0xAC)', timeout_ms: 5000,
  });
  assert.equal(split.output, '€');
  const large = await invoke('start_process', { command: "[Console]::Write('€' * 400000); [Console]::Write('end')", timeout_ms: 5000 });
  assert.equal(large.output_truncated, true);
  assert.ok((large.output as string).endsWith('€'));
  assert.doesNotMatch(large.output as string, /�|end/);
});

test('polling next_offset revisits a partial line instead of losing its later suffix', { skip: process.platform !== 'win32' }, async t => {
  const { invoke } = await fixture(t);
  const started = await invoke('start_process', {
    command: "[Console]::Write('first'); [Console]::ReadLine() | Out-Null; [Console]::WriteLine('second')", timeout_ms: 1000,
  });
  assert.equal(started.output, 'first');
  assert.equal(started.next_offset, 0);
  assert.equal(started.partial_line, true);
  await invoke('interact_process', { process_id: started.process_id, input: '\n', timeout_ms: 5000 });
  const polled = await invoke('read_process', { process_id: started.process_id, offset: started.next_offset });
  assert.equal(polled.output, 'firstsecond');
  assert.equal(polled.next_offset, 1);
  assert.equal(polled.partial_line, false);
});

test('binary and oversized text are refused before rewriting', async t => {
  const { workspace, invoke } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
  await assert.rejects(invoke('edit_text', { path: 'binary.bin', old_text: 'x', new_text: 'y' }), /NOT_TEXT/);
  await fs.writeFile(path.join(workspace, 'large.txt'), Buffer.alloc(10 * 1024 * 1024 + 1, 97));
  await assert.rejects(invoke('read_file', { path: 'large.txt' }), /LIMIT_EXCEEDED/);
});
