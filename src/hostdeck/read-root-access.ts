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

type Stat = import('node:fs').BigIntStats;
type OpenFile = Awaited<ReturnType<typeof fs.open>>;
type OpenDirectory = Awaited<ReturnType<typeof fs.opendir>>;
export interface TrustedReadRootReader {
  selected: ReadRootSelectionStore['selected'];
}
export interface ReadRootScope extends ReadRootCandidate {
  readonly revision: string;
  readonly digest: string;
  readonly rootIdentity: { dev: bigint; ino: bigint };
}
const denied = (): never => { throw new RuntimeError('READ_ROOT_DENIED'); };
const changed = (): never => { throw new RuntimeError('READ_ROOT_CHANGED'); };
const same = (a: Stat, b: Stat): boolean =>
  a.dev === b.dev && a.ino !== 0n && a.ino === b.ino;
const key = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value;
const identity = async (file: string): Promise<Stat> => fs.stat(file, { bigint: true });

export class ReadRootAccess {
  constructor(
    readonly workspace: string,
    private readonly protectedPaths: readonly string[],
    private readonly selectionSource?: TrustedReadRootReader,
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
    if (!selected?.digest || !selected.revision) denied();
    const rootStat = await identity(answer.root);
    if (!rootStat.isDirectory() || rootStat.ino === 0n) denied();
    return { ...answer, revision: selected.revision, digest: selected.digest,
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
    let handle: OpenFile | undefined;
    try {
      handle = await fs.open(scope.absolute, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      const linked = await identity(scope.absolute);
      if (!opened.isFile() || opened.size < 0n ||
          opened.size > BigInt(maxBytes) || !same(opened, linked)) changed();
      // A swap during fs.open is detected before exposing the handle's data.
      await this.assertScope(scope, owner, operation);
      const result = await use(handle, opened);
      const after = await handle.stat({ bigint: true });
      const current = await identity(scope.absolute);
      if (!same(opened, after) || !same(opened, current) ||
          opened.size !== after.size || opened.mtimeNs !== after.mtimeNs ||
          opened.ctimeNs !== after.ctimeNs) changed();
      await this.assertScope(scope, owner, operation);
      return result;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      changed();
    } finally { await handle?.close(); }
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
    if (!target.isDirectory()) denied();
    const before = await identity(scope.absolute);
    if (!same(target, before)) changed();
    await this.assertScope(scope, owner, operation);
    const after = await identity(scope.absolute);
    if (!same(before, after) || before.mtimeNs !== after.mtimeNs) changed();
    await this.assertScope(scope, owner, operation);
    return { size: Number(after.size), isDirectory: true, isFile: false,
      modified: after.mtime.toISOString() };
  }

  /** Check the path and root AGAIN after opendir before exposing names. */
  async withDirectory<T>(scope: ReadRootScope, owner: ReadRootOwner,
    operation: ReadOnlyOperation,
    use: (dir: OpenDirectory) => Promise<T>): Promise<T> {
    const initial = await this.assertScope(scope, owner, operation);
    const before = await identity(initial.absolute);
    if (!before.isDirectory() || before.ino === 0n) denied();
    const dir = await fs.opendir(scope.absolute);
    try {
      await this.assertScope(scope, owner, operation);
      const result = await use(dir);
      const after = await identity(scope.absolute);
      if (!same(before, after)) changed();
      await this.assertScope(scope, owner, operation);
      return result;
    } finally { await dir.close().catch(() => {}); }
  }
}
