import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileAdapter } from '../src/hostdeck/files.js';

const context = { ownerId: 'owner-a', deviceId: 'device-a', executorId: 'executor-a' };

async function waitForSearch(adapter: FileAdapter, searchId: string): Promise<{ complete: boolean; state: string; total_results: number }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await adapter.handle('hostdeck_search_results', { device_id: context.deviceId, search_id: searchId, offset: 0, limit: 100 }, context) as { complete: boolean; state: string; total_results: number };
    if (result.complete) return result;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('search fixture timed out');
}

test('file adapter confines paths, pages owner-bound searches, and never silently deletes or overwrites', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-files-test-'));
  const docs = path.join(workspace, 'docs');
  const calls: string[] = [];
  try {
    await mkdir(docs);
    await writeFile(path.join(docs, 'a.txt'), 'needle one\nordinary\nneedle two\n');
    await writeFile(path.join(docs, 'b.txt'), 'another file\n');
    await writeFile(path.join(docs, '.hidden.txt'), 'secret marker\n');
    await writeFile(path.join(workspace, 'existing.txt'), 'keep me');
    await writeFile(path.join(workspace, 'replacement.txt'), 'new content');
    const adapter = await FileAdapter.create({ workspace, reauthorize: async name => { calls.push(name); } });

    const listing = await adapter.handle('hostdeck_list_directory', { device_id: context.deviceId, path: '.', depth: 1, limit: 1 }, context) as { entries: Array<{ path: string }>; truncated: boolean };
    assert.equal(listing.entries.length, 1);
    assert.equal(listing.truncated, true);
    assert.ok(listing.entries.every(entry => !path.isAbsolute(entry.path)));
    await assert.rejects(adapter.handle('hostdeck_list_directory', { device_id: context.deviceId, path: path.dirname(workspace), depth: 1, limit: 10 }, context), /FILES_PATH_OUTSIDE_WORKSPACE/);

    const made = await adapter.handle('hostdeck_create_directory', { device_id: context.deviceId, path: 'created' }, context) as { created: boolean };
    assert.equal(made.created, true);
    await adapter.handle('hostdeck_move_file', { device_id: context.deviceId, source: 'docs/a.txt', destination: 'docs/moved.txt', overwrite: false }, context);
    assert.equal(await readFile(path.join(docs, 'moved.txt'), 'utf8'), 'needle one\nordinary\nneedle two\n');
    await assert.rejects(adapter.handle('hostdeck_move_file', { device_id: context.deviceId, source: 'docs/b.txt', destination: 'existing.txt', overwrite: false }, context), error => (error as NodeJS.ErrnoException).code === 'EEXIST');
    assert.equal(await readFile(path.join(workspace, 'existing.txt'), 'utf8'), 'keep me');
    await adapter.handle('hostdeck_move_file', { device_id: context.deviceId, source: 'replacement.txt', destination: 'existing.txt', overwrite: true }, context);
    assert.equal(await readFile(path.join(workspace, 'existing.txt'), 'utf8'), 'new content');
    await assert.rejects(stat(path.join(workspace, 'replacement.txt')));
    if (process.platform === 'win32') {
      const sourceDirectory = path.join(workspace, "folder's $ source");
      await mkdir(sourceDirectory);
      await writeFile(path.join(sourceDirectory, 'inside.txt'), 'inside');
      await adapter.handle('hostdeck_move_file', { device_id: context.deviceId, source: "folder's $ source", destination: 'folder-moved', overwrite: false }, context);
      assert.equal(await readFile(path.join(workspace, 'folder-moved', 'inside.txt'), 'utf8'), 'inside');
    } else {
      await assert.rejects(adapter.handle('hostdeck_move_file', { device_id: context.deviceId, source: 'docs', destination: 'docs-moved', overwrite: false }, context), /FILES_DIRECTORY_MOVE_UNAVAILABLE_PLATFORM/);
    }

    const started = await adapter.handle('hostdeck_search_files', { device_id: context.deviceId, path: 'docs', pattern: 'needle', mode: 'content', literal: true, include_hidden: false, limit: 10, timeout_ms: 5000 }, context) as { search_id: string };
    const complete = await waitForSearch(adapter, started.search_id);
    assert.equal(complete.total_results, 2);
    const first = await adapter.handle('hostdeck_search_results', { device_id: context.deviceId, search_id: started.search_id, offset: 0, limit: 1 }, context) as { items: Array<{ line?: number }>; total_results: number; next_offset: number };
    assert.equal(first.total_results, 2);
    assert.equal(first.items[0].line, 1);
    assert.equal(first.next_offset, 1);
    await assert.rejects(adapter.handle('hostdeck_search_results', { device_id: context.deviceId, search_id: started.search_id, offset: 0, limit: 1 }, { ...context, ownerId: 'owner-b' }), /SEARCH_NOT_OWNED/);

    const stopping = await adapter.handle('hostdeck_search_files', { device_id: context.deviceId, path: 'docs', pattern: 'absent', mode: 'files', literal: true, include_hidden: false, limit: 10, timeout_ms: 5000 }, context) as { search_id: string };
    await adapter.handle('hostdeck_stop_search', { device_id: context.deviceId, search_id: stopping.search_id }, context);
    await waitForSearch(adapter, stopping.search_id);
    const stopped = await adapter.handle('hostdeck_search_results', { device_id: context.deviceId, search_id: stopping.search_id, offset: 0, limit: 10 }, context) as { state: string; stopped: boolean };
    assert.equal(stopped.state, 'stopped');

    if (process.platform === 'win32') {
      const recycled = await adapter.handle('hostdeck_delete_path', { device_id: context.deviceId, path: 'existing.txt', recursive: false, recycle: true }, context) as { recycled: boolean; permanent: boolean };
      assert.equal(recycled.recycled, true);
      assert.equal(recycled.permanent, false);
      await assert.rejects(stat(path.join(workspace, 'existing.txt')));
    } else {
      await assert.rejects(adapter.handle('hostdeck_delete_path', { device_id: context.deviceId, path: 'existing.txt', recursive: false, recycle: true }, context), /FILES_RECYCLE_UNAVAILABLE_PLATFORM/);
      await stat(path.join(workspace, 'existing.txt'));
      const deleted = await adapter.handle('hostdeck_delete_path', { device_id: context.deviceId, path: 'existing.txt', recursive: false, recycle: false }, context) as { permanent: boolean };
      assert.equal(deleted.permanent, true);
      await assert.rejects(stat(path.join(workspace, 'existing.txt')));
    }
    assert.equal(calls.length, process.platform === 'win32' ? 6 : 4);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('permanent nonrecursive deletion removes an empty directory and preserves a populated one',async()=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'hostdeck-delete-empty-'));
 try{
  await mkdir(path.join(workspace,'empty'));await mkdir(path.join(workspace,'populated'));
  await writeFile(path.join(workspace,'populated','keep.txt'),'keep');
  const adapter=await FileAdapter.create({workspace,reauthorize:async()=>{}});
  const args={device_id:context.deviceId,recursive:false,recycle:false};
  await assert.rejects(adapter.handle('hostdeck_delete_path',{...args,path:'populated'},context),/FILES_DIRECTORY_NOT_EMPTY/);
  assert.equal(await readFile(path.join(workspace,'populated','keep.txt'),'utf8'),'keep');
  await adapter.handle('hostdeck_delete_path',{...args,path:'empty'},context);
  await assert.rejects(stat(path.join(workspace,'empty')),{code:'ENOENT'});
 }finally{await rm(workspace,{recursive:true,force:true});}
});
