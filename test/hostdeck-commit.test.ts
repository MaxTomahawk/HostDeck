import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SafeCommitter } from '../src/hostdeck/commit.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('safe committer snapshots, detects changed originals, reauthorizes, and creates without clobbering', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-commit-test-'));
  const originalPath = path.join(workspace, 'document.txt');
  let authorized = true;
  const names: string[] = [];
  try {
    await writeFile(originalPath, 'original');
    const committer = await SafeCommitter.create({ workspace, reauthorize: async name => { names.push(name); if (!authorized) throw new Error('REVOKED'); } });
    assert.equal(await committer.snapshot(originalPath), digest('original'));
    assert.equal(await committer.snapshot(path.join(workspace, 'missing.txt')), null);

    const initialHash = await committer.snapshot(originalPath);
    await writeFile(originalPath, 'changed outside the committer');
    await assert.rejects(committer.commit('hostdeck_edit_document', { path: originalPath }, { destination: originalPath, bytes: Buffer.from('replacement') }, { overwrite: true, expectedSha256: initialHash }), /EDIT_CONFLICT/);
    assert.equal(await readFile(originalPath, 'utf8'), 'changed outside the committer');

    const replacePath = path.join(workspace, 'replace.txt');
    await writeFile(replacePath, 'before');
    const replaced = await committer.commit('hostdeck_edit_document', { path: replacePath }, { destination: replacePath, bytes: Buffer.from('after') }, { overwrite: true, expectedSha256: digest('before') });
    assert.equal(replaced.sha256, digest('after'));
    assert.equal(await readFile(replacePath, 'utf8'), 'after');

    authorized = false;
    await assert.rejects(committer.commit('hostdeck_edit_document', { path: originalPath }, { destination: originalPath, bytes: Buffer.from('unauthorized') }, { overwrite: true, expectedSha256: digest('changed outside the committer') }), /REVOKED/);
    assert.equal(await readFile(originalPath, 'utf8'), 'changed outside the committer');
    authorized = true;

    await assert.rejects(committer.commit('hostdeck_apply_artifact', { path: originalPath }, { destination: originalPath, bytes: Buffer.from('clobber') }, { overwrite: false }), /COMMIT_DESTINATION_EXISTS/);
    assert.equal(await readFile(originalPath, 'utf8'), 'changed outside the committer');

    const destination = path.join(workspace, 'new-artifact.bin');
    const outcomes = await Promise.allSettled([
      committer.commit('hostdeck_apply_artifact', { path: destination }, { destination, bytes: Buffer.from('first') }, { overwrite: false }),
      committer.commit('hostdeck_apply_artifact', { path: destination }, { destination, bytes: Buffer.from('second') }, { overwrite: false }),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
    assert.ok(['first', 'second'].includes(await readFile(destination, 'utf8')));
    assert.equal(await committer.snapshot(destination), digest(await readFile(destination)));
    assert.equal((await readdir(workspace)).filter(name => name.endsWith('.tmp')).length, 0);

    await assert.rejects(committer.snapshot(path.join(workspace, '..', 'outside.txt')), /COMMIT_PATH_OUTSIDE_WORKSPACE/);
    await assert.rejects(committer.snapshot(path.join(workspace, 'document.txt:stream')), /COMMIT_ALTERNATE_STREAM_DENIED/);
    assert.equal(names.length, 3);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
