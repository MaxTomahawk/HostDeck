import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  COMPONENT_IDS, observeDiagnosticsProvenance, type ComponentId,
  type DiagnosticsProvenance, type ProvenanceInputs,
} from '../src/hostdeck/state/diagnostics-provenance.js';
import { StateServices } from '../src/hostdeck/state/index.js';

const TARGETS: Record<ComponentId, string> = {
  main: 'agent/dist/hostdeck/main.js',
  gateway: 'agent/dist/hostdeck/gateway.js',
  contracts: 'agent/dist/hostdeck/contracts.js',
  state: 'agent/dist/hostdeck/state/index.js',
  node: 'agent/node.exe',
  native_exe: 'desktop/HostDeck.DesktopWorker.exe',
  native_dll: 'desktop/HostDeck.DesktopWorker.dll',
};
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function local(root: string, id: ComponentId): string {
  return path.join(root, ...TARGETS[id].split('/'));
}
interface Fixture {
  root: string;
  inputs: ProvenanceInputs;
  files: Record<ComponentId, Buffer>;
}
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-provenance-owned-'));
  const files = {} as Record<ComponentId, Buffer>;
  for (const id of COMPONENT_IDS) {
    const target = local(root, id);
    await mkdir(path.dirname(target), { recursive: true });
    files[id] = Buffer.from('owned-fixture-' + id + '-exact-known-bytes\n', 'utf8');
    await writeFile(target, files[id], { flag: 'wx' });
  }
  const manifest = {
    schema: 1,
    files: COMPONENT_IDS.map(id => ({ path: TARGETS[id], sha256: digest(files[id]) })),
    // Deliberate untrusted payload must never be copied to public diagnostics.
    private_description: 'SECRET-SID-S-1-5-21-PRIVATE',
    source_sha: 'CLAIMED_SOURCE_SHA_NOT_AN_ATTESTATION',
    files_not_to_scan: ['credentials.json', 'users/private-stuff'],
  };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return {
    root, files,
    inputs: {
      moduleFile: local(root, 'state'),
      nodeExecutable: local(root, 'node'),
      nativeExecutable: local(root, 'native_exe'),
    },
  };
}
function component(result: DiagnosticsProvenance, id: ComponentId) {
  const value = result.components.find(x => x.component_id === id);
  assert.ok(value, id);
  return value;
}
function assertStrictReport(value: DiagnosticsProvenance, root: string): void {
  assert.deepEqual(Object.keys(value), [
    'schema', 'scope', 'layout', 'manifest', 'components',
    'component_comparison', 'signature_binding', 'source_binding',
  ]);
  assert.deepEqual(Object.keys(value.manifest), [
    'observation', 'observed_sha256', 'size_bytes', 'schema_status',
    'expected_digest_sha256', 'digest_binding',
  ]);
  assert.equal(value.schema, 1);
  assert.equal(value.scope, 'known_release_components');
  assert.equal(value.signature_binding, 'unknown');
  assert.equal(value.source_binding, 'unknown');
  assert.equal(value.manifest.expected_digest_sha256, null);
  assert.equal(value.manifest.digest_binding, 'unknown');
  assert.deepEqual(value.components.map(item => item.component_id), [...COMPONENT_IDS]);
  for (const item of value.components) {
    assert.deepEqual(Object.keys(item), [
      'component_id', 'observation', 'observed_sha256',
      'expected_sha256', 'comparison', 'size_bytes',
    ]);
    if (item.observed_sha256 !== null) assert.match(item.observed_sha256, /^[a-f0-9]{64}$/);
    if (item.expected_sha256 !== null) assert.match(item.expected_sha256, /^[a-f0-9]{64}$/);
    if (item.size_bytes !== null) assert.ok(Number.isSafeInteger(item.size_bytes));
  }
  const exposed = JSON.stringify(value);
  assert.ok(!exposed.includes(root), 'absolute fixture root must remain private');
  assert.ok(!exposed.includes('SECRET-SID'));
  assert.ok(!exposed.includes('CLAIMED_SOURCE_SHA'));
  assert.ok(!exposed.includes('credentials.json'));
  assert.ok(!exposed.includes('node.exe'));
  assert.ok(!exposed.includes('desktop/'));
  assert.ok(!exposed.includes('agent/'));
}

test('fixed seven components stream actual SHA256; unsigned manifest match is NOT attestation', async () => {
  const f = await fixture();
  try {
    const value = await observeDiagnosticsProvenance(f.inputs);
    assertStrictReport(value, f.root);
    assert.equal(value.layout, 'resolved');
    assert.equal(value.manifest.observation, 'observed');
    assert.equal(value.manifest.schema_status, 'valid');
    assert.equal(value.manifest.observed_sha256,
      digest(await readFile(path.join(f.root, 'manifest.json'))));
    assert.equal(value.component_comparison, 'all_match_unsigned');
    for (const id of COMPONENT_IDS) {
      const actual = component(value, id);
      assert.equal(actual.observation, 'observed', id);
      assert.equal(actual.observed_sha256, digest(f.files[id]), id);
      assert.equal(actual.expected_sha256, digest(f.files[id]), id);
      assert.equal(actual.comparison, 'match', id);
    }
    assert.equal(value.signature_binding, 'unknown');
    assert.equal(value.source_binding, 'unknown');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('fresh request identifies changed binary; forged unsigned manifest never creates signature trust', async () => {
  const f = await fixture();
  try {
    const before = await observeDiagnosticsProvenance(f.inputs);
    await writeFile(local(f.root, 'gateway'), 'modified-gateway-live-bytes');
    const after = await observeDiagnosticsProvenance(f.inputs);
    assert.notEqual(component(before, 'gateway').observed_sha256,
      component(after, 'gateway').observed_sha256);
    assert.equal(component(after, 'gateway').comparison, 'mismatch');
    assert.equal(after.component_comparison, 'mismatch');
    const manifestFile = path.join(f.root, 'manifest.json');
    const unsigned = JSON.parse(await readFile(manifestFile, 'utf8'));
    unsigned.files.find((row: {path: string}) => row.path === TARGETS.gateway).sha256 =
      digest(await readFile(local(f.root, 'gateway')));
    await writeFile(manifestFile, JSON.stringify(unsigned));
    const forged = await observeDiagnosticsProvenance(f.inputs);
    assert.equal(component(forged, 'gateway').comparison, 'match');
    assert.equal(forged.component_comparison, 'all_match_unsigned');
    assert.equal(forged.signature_binding, 'unknown');
    assert.equal(forged.source_binding, 'unknown');
    assert.notEqual(forged.manifest.observed_sha256, before.manifest.observed_sha256);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('missing components mismatch manifest, invalid manifest gives UNKNOWN without losing observations', async () => {
  const f = await fixture();
  try {
    await unlink(local(f.root, 'native_dll'));
    const absent = await observeDiagnosticsProvenance(f.inputs);
    assert.equal(component(absent, 'native_dll').observation, 'missing');
    assert.equal(component(absent, 'native_dll').comparison, 'mismatch');
    assert.equal(component(absent, 'node').comparison, 'match');
    await writeFile(path.join(f.root, 'manifest.json'), '{"schema":1,"files":');
    const broken = await observeDiagnosticsProvenance(f.inputs);
    assert.equal(broken.manifest.observation, 'observed');
    assert.equal(broken.manifest.schema_status, 'invalid');
    assert.equal(component(broken, 'node').observation, 'observed');
    assert.equal(component(broken, 'node').comparison, 'unknown');
    assert.equal(component(broken, 'native_dll').comparison, 'unknown');
    assert.equal(broken.signature_binding, 'unknown');
    assertStrictReport(broken, f.root);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('empty binaries and duplicate manifest entries are explicit failures, not attested matches', async () => {
  const f = await fixture();
  try {
    await writeFile(local(f.root, 'native_exe'), Buffer.alloc(0));
    const empty = await observeDiagnosticsProvenance(f.inputs);
    assert.equal(component(empty, 'native_exe').observation, 'empty');
    assert.equal(component(empty, 'native_exe').observed_sha256, null);
    assert.equal(component(empty, 'native_exe').comparison, 'unknown');
    const manifestPath = path.join(f.root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files.push({ path: TARGETS.node, sha256: digest(f.files.node) });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const duplicate = await observeDiagnosticsProvenance(f.inputs);
    assert.equal(duplicate.manifest.schema_status, 'invalid');
    assert.ok(duplicate.components.every(item => item.comparison === 'unknown'));
    assertStrictReport(duplicate, f.root);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('streamed in-place mutation yields UNSTABLE, never a digest or false match', async () => {
  const f = await fixture();
  try {
    const large = Buffer.alloc(2 * 64 * 1024, 0x61);
    await writeFile(local(f.root, 'gateway'), large);
    const manifestFile = path.join(f.root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.files.find((row: {path: string}) => row.path === TARGETS.gateway).sha256 = digest(large);
    await writeFile(manifestFile, JSON.stringify(manifest));
    let edited = false;
    const result = await observeDiagnosticsProvenance({
      ...f.inputs,
      onChunkForTest: async id => {
        if (id !== 'gateway') return;
        edited = true;
        await writeFile(local(f.root, 'gateway'), Buffer.alloc(large.length, 0x62));
        const future = new Date(Date.now() + 10_000);
        await utimes(local(f.root, 'gateway'), future, future);
      },
    });
    assert.equal(edited, true);
    assert.equal(component(result, 'gateway').observation, 'unstable');
    assert.equal(component(result, 'gateway').observed_sha256, null);
    assert.equal(component(result, 'gateway').comparison, 'unknown');
    assert.equal(result.signature_binding, 'unknown');
    assertStrictReport(result, f.root);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('file/time/total budgets fail closed and cannot be relaxed by fixture controls', async () => {
  const f = await fixture();
  try {
    const short = await observeDiagnosticsProvenance({
      ...f.inputs, limitsForTest: { fileBytes: 8, manifestBytes: 8192 },
    });
    assert.equal(component(short, 'main').observation, 'too_large');
    assert.equal(component(short, 'main').observed_sha256, null);
    assert.equal(component(short, 'main').comparison, 'unknown');
    const timed = await observeDiagnosticsProvenance({
      ...f.inputs, limitsForTest: { durationMs: 2 },
      onChunkForTest: async id => {
        if (id === 'manifest') await new Promise(resolve => setTimeout(resolve, 15));
      },
    });
    assert.ok(['time_limit', 'unbound'].includes(timed.manifest.observation));
    assert.equal(timed.signature_binding, 'unknown');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('reparse path is refused even if its target is a readable file', async t => {
  const f = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-provenance-outside-'));
  try {
    const target = path.join(outside, 'outside-private-runtime.bin');
    await writeFile(target, 'OUTSIDE_PRIVATE_BYTES_SHOULD_NEVER_HASH');
    await unlink(local(f.root, 'native_dll'));
    try {
      await symlink(target, local(f.root, 'native_dll'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Filesystem does not permit unprivileged symlink fixture'); return;
      }
      throw error;
    }
    const result = await observeDiagnosticsProvenance(f.inputs);
    assert.equal(component(result, 'native_dll').observation, 'reparse');
    assert.equal(component(result, 'native_dll').observed_sha256, null);
    assert.equal(component(result, 'native_dll').comparison, 'unknown');
    assert.ok(!JSON.stringify(result).includes('OUTSIDE_PRIVATE_BYTES'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('noninstalled/unbound inputs stay UNKNOWN; no arbitrary file path probing', async () => {
  const value = await observeDiagnosticsProvenance({
    moduleFile: path.join(os.tmpdir(), 'irrelevant.txt'),
    nodeExecutable: path.join(os.tmpdir(), 'arbitrary-secret.exe'),
  });
  assert.equal(value.layout, 'unavailable');
  assert.equal(value.manifest.observation, 'unbound');
  assert.equal(value.component_comparison, 'unknown');
  assert.ok(value.components.every(item =>
    item.observation === 'unbound' && item.observed_sha256 === null));
});

test('StateServices emits fresh owner/device scoped artifacts without caller paths or runtime transitions', async () => {
  const f = await fixture();
  const stateDir = path.join(f.root, 'protected-owned-state');
  const context = { ownerId: 'owner-A', deviceId: 'device-A', executorId: 'user' };
  const state = StateServices.create({
    root: stateDir, workspace: f.root, deviceId: 'device-A',
    shellExecutable: 'unused-fixture', environment: {}, launchJobs: false,
    desktopWorkerExecutable: f.inputs.nativeExecutable,
  });
  try {
    const first = await state.handle('diagnostics', { include_jobs: false }, context) as
      {artifact_id: string; sha256: string; size: number};
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await state.handle('read_artifact', { artifact_id: first.artifact_id },
      { ...context, ownerId: 'owner-B' }), null);
    assert.equal(await state.handle('read_artifact', { artifact_id: first.artifact_id },
      { ...context, deviceId: 'device-B' }), null);
    const content = await state.handle('read_artifact', {
      artifact_id: first.artifact_id, offset: 0, length: 65536,
    }, context) as {data_base64: string; sha256: string};
    const report = JSON.parse(Buffer.from(content.data_base64, 'base64').toString('utf8'));
    assert.equal(report.state, 'ready');
    assert.equal(report.device_id, 'device-A');
    assert.ok(report.generated_at);
    assertStrictReport(report.provenance, f.root);
    // Source module is not this isolated fixture: only native files are bound.
    assert.equal(component(report.provenance, 'native_exe').comparison, 'match');
    assert.equal(component(report.provenance, 'main').observation, 'unbound');

    await writeFile(local(f.root, 'native_exe'), 'changed-native-worker');
    const second = await state.handle('diagnostics', { include_jobs: false }, context) as
      {artifact_id: string};
    assert.notEqual(second.artifact_id, first.artifact_id);
    const output = await state.handle('read_artifact', {
      artifact_id: second.artifact_id,
    }, context) as {data_base64: string};
    const reObserved = JSON.parse(Buffer.from(output.data_base64, 'base64').toString('utf8'));
    assert.equal(component(reObserved.provenance, 'native_exe').comparison, 'mismatch');
    assert.equal(reObserved.provenance.signature_binding, 'unknown');
    assert.ok(!JSON.stringify(reObserved).includes(f.root));
    assert.equal(existsSync(path.join(f.root, 'protected-owned-state', 'state.sqlite')), true);
  } finally {
    await state.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
