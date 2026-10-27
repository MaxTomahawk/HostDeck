import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  FullTextNativeBridge, type FullTextNativeIdentity,
} from '../src/hostdeck/fulltext-native-bridge.js';

const execFile = promisify(execFileCallback);
const fixtureWorker = process.env.HOSTDECK_TEST_FULLTEXT_NATIVE_WORKER ??
  path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
const available = process.platform === 'win32' && existsSync(fixtureWorker);

async function identity(): Promise<FullTextNativeIdentity> {
  const { stdout } = await execFile(fixtureWorker, ['--identity'], {
    windowsHide: true, shell: false, timeout: 3000, maxBuffer: 8192, encoding: 'utf8',
  });
  const value = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(typeof value.sid, 'string');
  assert.match(String(value.logon_id), /^[0-9a-fA-F]{16}$/);
  assert.equal(typeof value.session_id, 'number');
  return { sid: String(value.sid), logonId: String(value.logon_id),
    sessionId: Number(value.session_id) };
}
async function sha(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const data of createReadStream(file)) h.update(data);
  return h.digest('hex');
}
async function observedExisting(file: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try { return await stat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Do not surface an access-denied path from the operating system.
    throw new Error('FULLTEXT_NATIVE_PROTECTED_FIXTURE_METADATA_UNAVAILABLE');
  }
}
function expectedComponentCount(file: string): number {
  const root = path.win32.parse(file).root;
  return 1 + file.slice(root.length).split(/[\/\\]+/).filter(Boolean).length;
}

async function bridge(id: FullTextNativeIdentity): Promise<FullTextNativeBridge> {
  const instance = new FullTextNativeBridge({
    workerExecutable: fixtureWorker, workerSha256: await sha(fixtureWorker),
    expectedExecutor: id, timeoutMs: 3000,
  });
  await instance.open();
  return instance;
}

test('Windows GetFileAttributesW handles Unicode file and many paths with one persistent owned IPC process', {
  skip: !available ? 'Actual Windows DesktopWorker executable unavailable; native Unicode test NOT_RUN' : false,
  timeout: 16000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-ft-native-unicode-'));
  let client: FullTextNativeBridge | undefined;
  try {
    const filenames = ['België_日本語_中文.txt',
      ...Array.from({ length: 23 }, (_, i) => 'owned-' + i + '.txt')];
    for (const name of filenames) await writeFile(path.join(root, name), 'fixture-only');
    client = await bridge(await identity());
    const pid = (client as unknown as {child?: {pid?: number}}).child?.pid;
    assert.ok(Number.isSafeInteger(pid) && pid! > 0, 'single owned helper must have a real PID');
    const paths = filenames.map(name => path.join(root, name));
    const first = await client.attributes(paths.slice(0, 12), async () => true);
    const second = await client.attributes(paths.slice(12), async () => true);
    assert.equal((client as unknown as {child?: {pid?: number}}).child?.pid, pid,
      'no process-per-file or process-per-batch allowed');
    assert.equal(first[0].status, 'ok', 'Unicode path is not an OEM/locale echo');
    assert.deepEqual([first[0].hidden, first[0].system, first[0].reparse],
      [false, false, false]);
    assert.ok([...first, ...second].every(item => item.status === 'ok'));
    assert.equal(first.length + second.length, filenames.length);
    assert.ok(!JSON.stringify([...first, ...second]).includes('België_'),
      'no paths returned to caller');
  } finally {
    await client?.close();
    await rm(root, {recursive:true,force:true});
  }
});

test('native metadata reports true Hidden/System flags using fixture-only attrib changes', {
  skip: !available ? 'Actual Windows worker unavailable; attribute test NOT_RUN' : false,
  timeout: 14000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-ft-native-attrs-'));
  const file = path.join(root, 'België_日本語_中文.txt');
  let client: FullTextNativeBridge | undefined;
  let changed = false;
  try {
    await writeFile(file, 'disposable fixture');
    const sysRoot = process.env.SystemRoot ?? process.env.windir;
    if (!sysRoot) {t.skip('Windows SystemRoot unavailable; fixture attributes NOT_RUN');return;}
    const attr = path.win32.join(sysRoot,'System32','attrib.exe');
    try {
      await execFile(attr, ['+H', '+S', file], {
        windowsHide:true,shell:false,timeout:3000,maxBuffer:4096,
      });
      changed = true;
    } catch {
      t.skip('Fixture user cannot set own Hidden/System attributes; no claim');
      return;
    }
    client = await bridge(await identity());
    const [result] = await client.attributes([file],async()=>true);
    assert.equal(result.status, 'ok');
    assert.equal(result.hidden, true);
    assert.equal(result.system, true);
    assert.equal(result.hidden_component, true);
    assert.equal(result.system_component, true);
  } finally {
    await client?.close();
    if (changed) {
      const rootPath = process.env.SystemRoot ?? process.env.windir;
      if (rootPath) await execFile(path.win32.join(rootPath,'System32','attrib.exe'),
        ['-H','-S',file], {windowsHide:true,shell:false,timeout:3000,maxBuffer:4096})
        .catch(()=>t.diagnostic('Fixture attribute rollback failed; fixture cleanup will still be attempted'));
    }
    await rm(root,{recursive:true,force:true});
  }
});

test('fulltext native IPC denies unapproved paths and malformed batch without scanning or process effects', {
  skip: !available ? 'Actual Windows worker unavailable; guard test NOT_RUN' : false,
  timeout: 14000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'hostdeck-ft-native-bounds-'));
  let client:FullTextNativeBridge|undefined;
  try {
    const owned = path.join(root, 'owned.txt');
    await writeFile(owned,'owned fixture');
    client = await bridge(await identity());
    let approvals = 0;
    await assert.rejects(client.attributes([owned],async()=>{approvals++;return false;}),
      /FULLTEXT_NATIVE_AUTHORIZATION_REQUIRED/);
    assert.equal(approvals,1);
    await assert.rejects(client.attributes(Array.from({length:65},()=>owned),async()=>true),
      /FULLTEXT_NATIVE_BATCH_LIMIT/);
    for(const bad of ['\\\\remote\\share\\x.txt',
      path.win32.parse(owned).root+'somewhere:alternate']) {
      await assert.rejects(client.attributes([bad],async()=>true),
        /FULLTEXT_NATIVE_PATH_DENIED/);
    }
    const good = await client.attributes([owned],async()=>true);
    assert.equal(good[0].status,'ok', 'worker stays usable after denied requests');
  } finally { await client?.close(); await rm(root,{recursive:true,force:true}); }
});

test('real AccessCheck rejects writable user-owned config and approval; does not change ACLs', {
  skip: !available ? 'Actual Windows worker unavailable; ACL negative NOT_RUN' : false,
  timeout: 16000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'hostdeck-ft-native-acl-'));
  let client:FullTextNativeBridge|undefined;
  try {
    const config = path.join(root, 'config');
    const index = path.join(root, 'index');
    await mkdir(config);await mkdir(index);
    const selectionFile = path.join(config, 'fulltext-selection.json');
    const approvalFile = path.join(config, 'fulltext-approval.json');
    await writeFile(selectionFile,'{"fixture":true}');
    await writeFile(approvalFile,'{"fixture":true}');
    client=await bridge(await identity());
    const originalSelection = await readFile(selectionFile);
    const originalApproval = await readFile(approvalFile);
    const ordinaryObject = await client.probeProtectedObjectAcl(selectionFile);
    assert.equal(ordinaryObject.verified, false,
      'ordinary user-owned writable file cannot be independently qualified as protected');
    assert.equal(ordinaryObject.status, 'unqualified');
    assert.match(ordinaryObject.reason ?? '', /^[A-Z][A-Z0-9_]+$/);
    assert.equal(ordinaryObject.scope, 'physical_filesystem_snapshot_only');
    assert.ok(!JSON.stringify(ordinaryObject).includes(selectionFile),
      'read-only probe must never return a real local path');
    await assert.rejects(client.verifyProtectedOwnerAcl({
      protectedDirectory:config,selectionFile,approvalFile,indexDirectory:index,
    }), /FULLTEXT_NATIVE_BOUNDARY_UNQUALIFIED/,
    'ordinary writeable fixture must never qualify as protected owner config');
    await assert.rejects(client.verifyProtectedOwnerAcl({
      protectedDirectory:config,selectionFile,approvalFile,indexDirectory:config,
    }), /FULLTEXT_NATIVE_BOUNDARY_UNQUALIFIED/,
    'overlap between protected and writable SQLite trees must fail');
    assert.deepEqual(await readFile(selectionFile), originalSelection, 'read-only ACL check must not edit selection');
    assert.deepEqual(await readFile(approvalFile), originalApproval, 'read-only ACL check must not edit approval');
  } finally {await client?.close();await rm(root,{recursive:true,force:true});}
});

test('reparse leaf and ancestor are reported from real Windows metadata (only own symlink)', {
  skip: !available ? 'Actual Windows worker unavailable; reparse fixture NOT_RUN' : false,
  timeout: 14000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'hostdeck-ft-native-reparse-'));
  let client:FullTextNativeBridge|undefined;
  try {
    const target = path.join(root,'target');
    const link = path.join(root,'link');
    await mkdir(target);
    await writeFile(path.join(target,'inside.txt'),'fixture-only');
    try { await symlink(target,link,'junction'); }
    catch {t.skip('Junction capability unavailable for disposable fixture; reparse NOT_RUN');return;}
    client=await bridge(await identity());
    const [leaf,child]=await client.attributes([link,path.join(link,'inside.txt')],async()=>true);
    assert.equal(leaf.status,'reparse_component');
    assert.equal(leaf.reparse,true);
    assert.equal(child.status,'reparse_component','cannot follow reparse ancestor to child');
  } finally {await client?.close();await rm(root,{recursive:true,force:true});}
});

test('current-token identity must match trusted executor; no caller identity overrides', {
  skip: !available ? 'Actual Windows worker unavailable; token binding test NOT_RUN' : false,
  timeout: 14000,
}, async () => {
  const actual = await identity();
  const bad = new FullTextNativeBridge({
    workerExecutable:fixtureWorker, workerSha256:await sha(fixtureWorker),
    expectedExecutor:{...actual,logonId:'ffffffffffffffff'},
  });
  try {await assert.rejects(bad.open(),/FULLTEXT_NATIVE_EXECUTOR_UNQUALIFIED/);}
  finally {await bad.close();}
});

test('existing protected config is physical-ACL-positive while a user-writable file remains negative', {
  skip: !available ? 'Actual native Windows worker unavailable; object contrast NOT_RUN' : false,
  timeout: 20000,
}, async t => {
  // The real pre-existing protected source, not an admin ACL fabricated for
  // testing. The environment override is an explicit local test input.
  // Neither target paths nor protected contents are emitted in test output.
  const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles;
  const target = process.env.HOSTDECK_TEST_PROTECTED_FULLTEXT_OBJECT ??
    (programFiles
      ? path.win32.join(programFiles, 'HostDeck', 'config', 'facade.json')
      : undefined);
  if (!target) {
    t.skip('Existing protected configuration object not configured; real positive NOT_RUN');
    return;
  }
  const preexisting = await observedExisting(target);
  if (!preexisting) {
    t.skip('Existing protected configuration object absent; real positive NOT_RUN');
    return;
  }
  assert.equal(preexisting.isFile(), true, 'positive protected source must be an existing file');
  const root = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-ft-acl-contrast-'));
  let client: FullTextNativeBridge | undefined;
  try {
    const writable = path.join(root, 'writable.txt');
    await writeFile(writable, 'owned nonprivileged negative control only');
    client = await bridge(await identity());

    const negative = await client.probeProtectedObjectAcl(writable);
    assert.equal(negative.verified, false, 'ordinary writable file cannot qualify');
    assert.equal(negative.code, 'FULLTEXT_NATIVE_ACL_UNQUALIFIED');
    assert.equal(negative.scope, 'physical_filesystem_snapshot_only');
    assert.match(negative.reason ?? '', /^[A-Z][A-Z0-9_]+$/);
    if (negative.failedComponentRole !== undefined) {
      assert.equal(negative.failedComponentIndex, negative.componentsChecked,
        'negative failure identifies a component index, not the private path');
      assert.ok(['root', 'ancestor', 'target'].includes(negative.failedComponentRole));
    }
    assert.ok(!JSON.stringify(negative).includes(writable),
      'negative receipt must not disclose physical path');

    const positive = await client.probeProtectedObjectAcl(target);
    t.diagnostic('Existing object: status=' + positive.status +
      ', components=' + positive.componentsChecked +
      ', reason=' + (positive.reason ?? 'NONE') +
      ', failedRole=' + (positive.failedComponentRole ?? 'NONE'));
    assert.equal(positive.verified, true,
      'pre-existing protected object must qualify by real AccessCheck, not a mock: ' +
      JSON.stringify(positive));
    assert.equal(positive.code, 'FULLTEXT_NATIVE_ACL_VERIFIED');
    assert.equal(positive.scope, 'physical_filesystem_snapshot_only');
    assert.equal(positive.componentsChecked, expectedComponentCount(target),
      'positive native receipt must cover root, every ancestor and target');
    assert.ok(!JSON.stringify(positive).includes(target),
      'positive receipt must not disclose physical path or protected contents');
    // A single physical positive never establishes selection, owner consent,
    // approval presence, a protected writable-index tuple or live product use.
  } finally {
    await client?.close();
    await rm(root, {recursive:true, force:true});
  }
});

test('physical owner-boundary tuple uses only pre-existing qualified records and index', {
  skip: !available || !process.env.HOSTDECK_TEST_PROTECTED_FULLTEXT_DIR ||
    !process.env.HOSTDECK_TEST_FULLTEXT_INDEX_DIR
    ? 'Existing protected records/index not configured; whole-boundary positive NOT_RUN' : false,
  timeout: 20000,
}, async t => {
  // These are read-only physical observations, NOT owner consent or a
  // selected product configuration. Never manufacture an admin ACL fixture.
  const protectedDirectory = process.env.HOSTDECK_TEST_PROTECTED_FULLTEXT_DIR!;
  const indexDirectory = process.env.HOSTDECK_TEST_FULLTEXT_INDEX_DIR!;
  const selectionFile = path.join(protectedDirectory,'fulltext-selection.json');
  const approvalFile = path.join(protectedDirectory,'fulltext-approval.json');
  const objects = await Promise.all(
    [protectedDirectory,selectionFile,approvalFile,indexDirectory].map(observedExisting));
  if (objects.some(item => item === null)) {
    t.skip('Required pre-existing selection, approval or index missing; whole-boundary positive NOT_RUN');
    return;
  }
  assert.equal(objects[0]!.isDirectory(),true,'protected root must be an existing directory');
  assert.equal(objects[1]!.isFile(),true,'selection must be a pre-existing file');
  assert.equal(objects[2]!.isFile(),true,'approval must be a pre-existing file');
  assert.equal(objects[3]!.isDirectory(),true,'index must be a pre-existing separate directory');
  let client: FullTextNativeBridge | undefined;
  try {
    client = await bridge(await identity());
    for (const [kind, object] of [
      ['protected directory',protectedDirectory],
      ['selection',selectionFile],
      ['approval',approvalFile],
    ] as const) {
      const result = await client.probeProtectedObjectAcl(object);
      t.diagnostic(kind + ': status=' + result.status +
        ', components=' + result.componentsChecked +
        ', reason=' + (result.reason ?? 'NONE'));
      assert.equal(result.verified,true,
        'pre-existing ' + kind + ' must independently qualify before tuple probe: ' +
        JSON.stringify(result));
      assert.equal(result.code,'FULLTEXT_NATIVE_ACL_VERIFIED');
      assert.equal(result.scope,'physical_filesystem_snapshot_only');
      assert.equal(result.componentsChecked,expectedComponentCount(object),
        'positive component proof must cover the full physical path');
      assert.ok(!JSON.stringify(result).includes(object),
        'native receipt must not expose protected physical path');
    }
    await client.verifyProtectedOwnerAcl({
      protectedDirectory,selectionFile,approvalFile,indexDirectory,
    });
    t.diagnostic('Read-only physical tuple qualified: 3 independent protected sources, ' +
      'separate worker-writable index. Owner consent and full owner boundary NOT claimed.');
  } finally { await client?.close(); }
});
