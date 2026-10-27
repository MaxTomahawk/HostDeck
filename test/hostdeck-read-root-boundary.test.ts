import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { FileAdapter } from '../src/hostdeck/files.js';
import { UserRuntime } from '../src/hostdeck/user-runtime.js';
import {
  resolveSelectedReadPath, type ProtectedReadRootSelection,
} from '../src/hostdeck/read-root-boundary.js';

const owner = { ownerId: 'owner_fixture', deviceId: 'device_fixture', executorId: 'executor_fixture' };

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hostdeck-broad-read-source-')));
  const workspace = path.join(root, 'workspace'), readable = path.join(root, 'read-root');
  const excluded = path.join(readable, 'excluded'), protectedFile = path.join(readable, 'protected.dat');
  await fs.mkdir(workspace); await fs.mkdir(readable); await fs.mkdir(excluded);
  await fs.writeFile(path.join(workspace, 'inside.txt'), 'workspace marker');
  const outside = path.join(readable, 'external.txt');
  await fs.writeFile(outside, 'EXTERNAL_FIXTURE_MARKER');
  await fs.writeFile(path.join(excluded, 'hidden.txt'), 'excluded fixture');
  await fs.writeFile(protectedFile, 'protected fixture');
  const selection: ProtectedReadRootSelection = {
    owner, revision: 'approved-revision-fixture', roots: [readable], excludedRoots: [excluded],
  };
  return { root, workspace, readable, outside, excluded, protectedFile, selection,
    cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('original FileAdapter and UserRuntime still deny external paths even with a permissive read authorizer', async () => {
  const f = await fixture();
  try {
    const adapter = await FileAdapter.create({ workspace: f.workspace });
    const runtime = await UserRuntime.create({
      deviceId: owner.deviceId, workspace: f.workspace, authorize: async () => true,
      shells: {}, environment: {},
    });
    try {
      await assert.rejects(adapter.handle('hostdeck_list_directory', {
        device_id: owner.deviceId, path: f.readable, depth: 1, limit: 10,
      }, owner), /FILES_PATH_OUTSIDE_WORKSPACE/);
      await assert.rejects(adapter.handle('hostdeck_search_files', {
        device_id: owner.deviceId, path: f.readable, pattern: 'external',
      }, owner), /FILES_PATH_OUTSIDE_WORKSPACE/);
      await assert.rejects(runtime.invoke('hostdeck_read_file', {
        device_id: owner.deviceId, path: f.outside,
      }), /PATH_DENIED/);
      await assert.rejects(runtime.invoke('hostdeck_file_info', {
        device_id: owner.deviceId, path: f.outside,
      }), /PATH_DENIED/);
      await assert.rejects(runtime.invoke('hostdeck_write_file', {
        device_id: owner.deviceId, path: f.outside, content: 'DENIED_WRITE',
      }), /PATH_DENIED/);
      assert.equal(await fs.readFile(f.outside, 'utf8'), 'EXTERNAL_FIXTURE_MARKER');
    } finally { await runtime.dispose(); }
  } finally { await f.cleanup(); }
});

test('Everything query matches outside the workspace are dropped despite a broader provider index', async () => {
  const f = await fixture();
  const everything = {
    sessionId: 1, status: async () => ({ installed: true, running: true, healthy: true }),
    query: async () => ({
      paths: [f.outside], truncated: false, version: 'fixture',
      instance: 'fixture', session_id: 1, runtime_id: 'fixture',
    }),
  };
  const scoped = { ...owner, sessionId: 1, sessionIds: [1] };
  try {
    const adapter = await FileAdapter.create({ workspace: f.workspace, everything });
    const started = await adapter.handle('hostdeck_search_files', {
      device_id: owner.deviceId, path: '.', pattern: 'external', provider: 'everything',
    }, scoped) as { search_id: string };
    let result: { complete: boolean; items: Array<{ path: string }>; total_results: number } | undefined;
    for (let i = 0; i < 100; i++) {
      result = await adapter.handle('hostdeck_search_results', {
        device_id: owner.deviceId, search_id: started.search_id,
      }, scoped) as typeof result;
      if (result?.complete) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(result?.complete, true);
    assert.deepEqual(result?.items, []);
    assert.equal(result?.total_results, 0);
    await assert.rejects(adapter.handle('hostdeck_search_results', {
      device_id: owner.deviceId, search_id: started.search_id,
    }, { ...scoped, ownerId: 'foreign_owner' }), /SEARCH_NOT_OWNED/);
  } finally { await f.cleanup(); }
});

test('an explicit, owner-matched read selection permits only its own absolute read/search root', async () => {
  const f = await fixture();
  const request = (input: string, operation: 'read_file' | 'name_search' | 'list_directory') =>
    resolveSelectedReadPath({
      workspace: f.workspace, path: input, owner, selection: f.selection,
      protectedPaths: [f.protectedFile], operation,
    });
  try {
    for (const operation of ['read_file', 'name_search'] as const) {
      const result = await request(f.outside, operation);
      assert.equal(result.absolute, await fs.realpath(f.outside));
      assert.equal(result.root, await fs.realpath(f.readable));
      assert.equal(result.displayPath, result.absolute, 'never produce ../ escape results');
      assert.equal(result.external, true);
    }
    const root = await request(f.readable, 'list_directory');
    assert.equal(root.external, true);
    const workspaceResult = await request('inside.txt', 'read_file');
    assert.equal(workspaceResult.external, false);
    assert.equal(workspaceResult.displayPath, 'inside.txt');
  } finally { await f.cleanup(); }
});

test('foreign owner/device/executor, missing selection, traversal, and protected/excluded matches fail closed', async () => {
  const f = await fixture();
  const input = { workspace: f.workspace, path: f.outside, owner,
    selection: f.selection, protectedPaths: [f.protectedFile], operation: 'read_file' as const };
  try {
    await assert.rejects(resolveSelectedReadPath({ ...input, selection: null }), /READ_ROOT_DENIED/);
    for (const different of [
      { ...owner, ownerId: 'other' }, { ...owner, deviceId: 'other' },
      { ...owner, executorId: 'other' },
    ]) {
      await assert.rejects(resolveSelectedReadPath({ ...input, owner: different }), /READ_ROOT_DENIED/);
    }
    await assert.rejects(resolveSelectedReadPath({
      ...input, path: path.join('..', 'read-root', 'external.txt'),
    }), /READ_ROOT_DENIED/);
    await assert.rejects(resolveSelectedReadPath({
      ...input, path: path.join(f.excluded, 'hidden.txt'),
    }), /READ_ROOT_DENIED/);
    await assert.rejects(resolveSelectedReadPath({
      ...input, path: f.protectedFile,
    }), /READ_ROOT_DENIED/);
    await assert.rejects(resolveSelectedReadPath({
      ...input, protectedPaths: [],
    }), /READ_ROOT_DENIED/);
    await assert.rejects(resolveSelectedReadPath({
      ...input, selection: { ...f.selection, roots: [path.parse(f.readable).root] },
    }), /READ_ROOT_DENIED/);
    await assert.rejects(resolveSelectedReadPath({
      ...input, path: f.outside, selection: { ...f.selection, roots: [f.workspace] },
    }), /READ_ROOT_DENIED/);
  } finally { await f.cleanup(); }
});

test('reparse alias and changed selection are not a persistent permission or write scope', async t => {
  const f = await fixture();
  try {
    const alias = path.join(f.root, 'alias');
    try {
      await fs.symlink(f.readable, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.diagnostic('junction/symlink creation unavailable; alias subcase not executed');
      } else throw error;
    }
    if (await fs.lstat(alias).then(() => true).catch(() => false)) {
      await assert.rejects(resolveSelectedReadPath({
        workspace: f.workspace, path: path.join(alias, 'external.txt'),
        owner, selection: { ...f.selection, roots: [alias] },
        protectedPaths: [f.protectedFile], operation: 'read_file',
      }), /READ_ROOT_DENIED/);
    }
    await resolveSelectedReadPath({
      workspace: f.workspace, path: f.outside, owner,
      selection: f.selection, protectedPaths: [f.protectedFile], operation: 'read_file',
    });
    await assert.rejects(resolveSelectedReadPath({
      workspace: f.workspace, path: f.outside, owner,
      selection: null, protectedPaths: [f.protectedFile], operation: 'read_file',
    }), /READ_ROOT_DENIED/, 'a prior successful check grants no future access');
    assert.equal(await fs.readFile(f.outside, 'utf8'), 'EXTERNAL_FIXTURE_MARKER');
  } finally { await f.cleanup(); }
});
