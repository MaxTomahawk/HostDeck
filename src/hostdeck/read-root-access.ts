/**
 * Shared, READ-ONLY resolver used by FileAdapter and UserRuntime.
 * Neither MCP arguments nor files:read/broadUserAuthority create root grants.
 *
 * Content reads use an actual open FileHandle and BigInt filesystem identity
 * from before AND after the read; root identity and the live protected
 * owner/device/executor revision/digest are rechecked before disclosure.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as flags } from 'node:fs';
import { RuntimeError } from './runtime-error.js';
import { within } from './fulltext/policy.js';
import { resolveSelectedReadPath, type ReadRootCandidate,
  type ReadOnlyOperation, type ReadRootOwner } from './read-root-boundary.js';
import type { ReadRootSelectionStore } from './read-root-selection-store.js';
import type { FullTextNativeBridge, FullTextNativeFilePin } from './fulltext-native-bridge.js';

type Stat = import('node:fs').BigIntStats;
type OpenFile = Awaited<ReturnType<typeof fs.open>>;
type NativeRead = Pick<FullTextNativeBridge, 'attributes' | 'directoryPage' | 'pinFile' | 'verifyFilePin' | 'releaseFilePin'>;
export interface TrustedReadRootReader {
  selected: ReadRootSelectionStore['selected'];
}
export interface ReadRootScope extends ReadRootCandidate {
  readonly revision: string;
  readonly digest: string;
  readonly rootIdentity: { dev: bigint; ino: bigint };
  readonly fixedVolumeAnchor: boolean;
}
function denied(): never { throw new RuntimeError('READ_ROOT_DENIED'); }
function changed(): never { throw new RuntimeError('READ_ROOT_CHANGED'); }
const same = (a: Stat, b: Stat): boolean =>
  a.dev === b.dev && a.ino !== 0n && a.ino === b.ino;
const sameDirectory = (a: Stat, b: Stat): boolean =>
  same(a,b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const key = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value;
const identity = async (file: string): Promise<Stat> => fs.stat(file, { bigint: true });

export class ReadRootAccess {
  constructor(
    readonly workspace: string,
    private readonly protectedPaths: readonly string[],
    private readonly selectionSource?: TrustedReadRootReader,
    private readonly native?: NativeRead,
  ) {
    if (!path.isAbsolute(workspace) || !Array.isArray(protectedPaths) ||
        !protectedPaths.length) denied();
  }

  async resolve(raw: string, owner: ReadRootOwner,
    operation: ReadOnlyOperation): Promise<ReadRootCandidate & Partial<ReadRootScope>> {
    // Workspace-only remains exactly the baseline, even when an optional
    // external owner record is invalid or revoked.
    const base = path.resolve(this.workspace);
    const target = path.resolve(base, raw);
    const selected = within(base, target) ? null :
      await this.selectionSource?.selected(owner) ?? null;
    const answer = await resolveSelectedReadPath({
      workspace: this.workspace, path: raw, owner,
      selection: selected, protectedPaths: this.protectedPaths, operation,
    });
    if (!answer.external) return answer;
    if (!selected?.digest || !selected.revision || !this.native) denied();
    // The ONLY Hidden/System exception is the exact selected and already
    // DriveInfo-qualified fixed-volume anchor. All descendants still require
    // independent native non-volume component evidence.
    const fixedVolumeAnchor = selected.fixedVolumeRoots?.some(volume =>
      key(path.resolve(volume)) === key(path.resolve(answer.root)) &&
      key(path.resolve(volume)) === key(path.parse(volume).root)) === true;
    // Native attribute checks include every ancestor. The worker reports
    // flags below the volume anchor separately to avoid treating a hidden
    // fixed-volume anchor as authorization for any hidden child.
    const allowed = [answer.root, answer.absolute];
    let attributes: Awaited<ReturnType<NativeRead['attributes']>>;
    try {
      attributes = await this.native.attributes(allowed,
        async input => allowed.some(value => key(value) === key(input)));
    } catch { return denied(); }
    // The native worker accepts only fixed local disks. Windows marks their
    // physical drive anchor Hidden/System even for an ordinary selected
    // subfolder. Ignore only that anchor's flags; every component below it
    // still denies Hidden/System, regardless of the selected root's depth.
    // This observation never turns the drive into a selected root.
    if (attributes.length !== allowed.length || attributes.some(item =>
        item.status !== 'ok' || item.reparse !== false ||
        item.hidden_below_volume !== false ||
        item.system_below_volume !== false)) denied();
    const rootStat = await identity(answer.root);
    if (!rootStat.isDirectory() || rootStat.ino === 0n) denied();
    return { ...answer, revision: selected.revision, digest: selected.digest,
      fixedVolumeAnchor,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino } };
  }

  /** A fresh protected selection and actual directory identity are mandatory. */
  async assertScope(scope: ReadRootScope, owner: ReadRootOwner,
    operation: ReadOnlyOperation, target = scope.absolute): Promise<ReadRootScope> {
    const current = await this.resolve(target, owner, operation);
    if (!current.external || !current.digest || !current.revision ||
        !current.rootIdentity || !scope.external ||
        key(current.root) !== key(scope.root) ||
        key(current.absolute) !== key(path.resolve(target)) ||
        current.digest !== scope.digest || current.revision !== scope.revision ||
        current.rootIdentity.dev !== scope.rootIdentity.dev ||
        current.rootIdentity.ino !== scope.rootIdentity.ino) denied();
    return current as ReadRootScope;
  }

  /**
   * The file descriptor stays OPEN throughout the read and the post-read
   * authorization. Both paths are checked for reparse/root substitution.
   * The function's return value is withheld until the post-read check passes.
   */
  async withFile<T>(scope: ReadRootScope, owner: ReadRootOwner,
    operation: ReadOnlyOperation, maxBytes: number,
    use: (file: OpenFile, before: Stat) => Promise<T>): Promise<T> {
    await this.assertScope(scope, owner, operation);
    const native = this.native;
    if (!native) denied();
    let handle: OpenFile | undefined;
    let pin: FullTextNativeFilePin | undefined;
    try {
      // The existing pinned native worker opens the ACTUAL admitted target
      // and EACH ancestor without FILE_SHARE_DELETE. The receipt includes
      // root and file volume/FileID of the opened handles, not path-only stats.
      // The handles remain alive across Node fs.open, read and reauthorization.
      pin = await native.pinFile(scope.absolute, scope.root, scope.rootIdentity,
        scope.fixedVolumeAnchor, async () => {
          await this.assertScope(scope, owner, operation);
          return true;
        });
      handle = await fs.open(scope.absolute, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.size < 0n ||
          opened.size > BigInt(maxBytes) ||
          opened.dev !== pin.dev || opened.ino !== pin.ino) changed();
      const linked = await identity(scope.absolute);
      if (!same(opened, linked)) changed();
      await this.assertScope(scope, owner, operation);
      const result = await use(handle, opened);
      const after = await handle.stat({ bigint: true });
      const current = await identity(scope.absolute);
      if (!same(opened, after) || !same(opened, current) ||
          opened.size !== after.size || opened.mtimeNs !== after.mtimeNs ||
          opened.ctimeNs !== after.ctimeNs) changed();
      await native.verifyFilePin(pin);
      await this.assertScope(scope, owner, operation);
      return result;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      return changed();
    } finally {
      try { await handle?.close(); }
      finally { if (pin) await native.releaseFilePin(pin); }
    }
  }

  async readBytesVerified(scope: ReadRootScope, owner: ReadRootOwner,
    operation: ReadOnlyOperation, maxBytes: number): Promise<{
      bytes:Buffer;identity:{dev:string;ino:string;mtimeNs:string;size:string};
    }> {
    return this.withFile(scope, owner, operation, maxBytes, async (file,stat) => {
      // Bounded by the existing content/read-file maximum even while growing.
      const output=Buffer.alloc(maxBytes+1);
      let length=0;
      while(length<output.length){
        const read=await file.read(output,length,output.length-length,length);
        if(!read.bytesRead)break;
        length+=read.bytesRead;
      }
      if(length>maxBytes)throw new RuntimeError('LIMIT_EXCEEDED');
      return {bytes:output.subarray(0,length),identity:{
        dev:stat.dev.toString(),ino:stat.ino.toString(),
        mtimeNs:stat.mtimeNs.toString(),size:stat.size.toString(),
      }};
    });
  }
  async readBytes(scope: ReadRootScope, owner: ReadRootOwner,
    operation: ReadOnlyOperation, maxBytes: number): Promise<Buffer> {
    return (await this.readBytesVerified(scope,owner,operation,maxBytes)).bytes;
  }

  async metadata(scope: ReadRootScope, owner: ReadRootOwner,
    operation: ReadOnlyOperation): Promise<{ size: number; isDirectory: boolean;
      isFile: boolean; modified: string; sha256?: string }> {
    await this.assertScope(scope, owner, operation);
    const target = await fs.lstat(scope.absolute, { bigint: true });
    if (target.isSymbolicLink()) denied();
    if (target.isFile()) {
      return this.withFile(scope, owner, operation, Number.MAX_SAFE_INTEGER,
        async (_file, stat) => ({
          size: Number(stat.size), isDirectory: false, isFile: true,
          modified: stat.mtime.toISOString(),
        }));
    }
    if (!target.isDirectory() || !this.native) denied();
    const before = await identity(scope.absolute);
    if (!sameDirectory(target, before)) changed();
    // Directory metadata also binds to the actual opened native directory
    // handle. Names returned by this private probe are discarded.
    try {
      await this.native.directoryPage(scope.absolute, before.dev, before.ino, 0, 1,
        async filename => key(filename) === key(scope.absolute),
        scope.fixedVolumeAnchor);
    } catch { changed(); }
    await this.assertScope(scope, owner, operation);
    const after = await identity(scope.absolute);
    if (!sameDirectory(before, after)) changed();
    await this.assertScope(scope, owner, operation);
    return { size: Number(after.size), isDirectory: true, isFile: false,
      modified: after.mtime.toISOString() };
  }

  /**
   * Directory names come ONLY from the opened, inode-matched native handle.
   * Node's fs.opendir exposes no identity of its actual directory handle on
   * Windows; path stats bracketing opendir permit swap-and-restore. Never use
   * that path for an external enumeration.
   */
  async withDirectory<T>(scope: ReadRootScope, owner: ReadRootOwner,
    operation: ReadOnlyOperation,
    use: (entries: AsyncIterable<{name: string}>) => Promise<T>): Promise<T> {
    if (!this.native) denied();
    await this.assertScope(scope, owner, operation);
    const before = await identity(scope.absolute);
    if (!before.isDirectory() || before.ino === 0n) denied();
    const native = this.native!;
    const access = this;
    async function* entries(): AsyncIterable<{name:string}> {
      let offset = 0;
      while (offset <= 100000) {
        await access.assertScope(scope, owner, operation);
        const now = await identity(scope.absolute);
        if (!sameDirectory(before, now)) changed();
        let page: Awaited<ReturnType<NativeRead['directoryPage']>>;
        try {
          page = await native.directoryPage(scope.absolute, before.dev, before.ino,
            offset, 192, async selected => key(selected) === key(scope.absolute),
            scope.fixedVolumeAnchor);
        } catch { return changed(); }
        await access.assertScope(scope, owner, operation);
        const after = await identity(scope.absolute);
        if (!sameDirectory(before, after)) changed();
        for (const name of page.names) {
          if (!name || name === '.' || name === '..' ||
              name.includes('\\') || name.includes('/') ||
              name.includes(':') || name.includes('\0')) changed();
          yield {name};
        }
        if (!page.more) return;
        if (page.nextOffset <= offset) changed();
        offset = page.nextOffset;
      }
      changed(); // bounded traversal: no unbounded enumeration
    }
    const result = await use(entries());
    const after = await identity(scope.absolute);
    if (!sameDirectory(before, after)) changed();
    await this.assertScope(scope, owner, operation);
    return result;
  }
}
