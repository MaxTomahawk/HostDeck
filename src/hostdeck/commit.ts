import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_COMMIT_BYTES = 64 * 1024 * 1024;

export type CommitReauthorize = (name: string, args: Record<string, unknown>) => Promise<void>;
export interface StagedWrite { destination: string; bytes: Uint8Array; mimeType?: string; }
export interface CommitOptions { overwrite: boolean; expectedSha256?: string | null; }
export interface CommitResult { written: true; sha256: string; }

function isLinkOrReparse(stat: import('node:fs').Stats): boolean { return stat.isSymbolicLink(); }
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class SafeCommitter {
  private readonly locks = new Map<string, Promise<void>>();
  private constructor(private readonly workspace: string, private readonly reauthorize: CommitReauthorize) {}

  static async create(options: { workspace: string; reauthorize: CommitReauthorize }): Promise<SafeCommitter> {
    if (!path.isAbsolute(options.workspace)) throw new Error('COMMIT_WORKSPACE_MUST_BE_ABSOLUTE');
    if (typeof options.reauthorize !== 'function') throw new Error('COMMIT_AUTHORIZER_REQUIRED');
    await fs.mkdir(options.workspace, { recursive: true });
    return new SafeCommitter(await fs.realpath(options.workspace), options.reauthorize);
  }

  private async targetPath(input: string): Promise<{ path: string; exists: boolean }> {
    if (typeof input !== 'string' || !input.trim()) throw new Error('COMMIT_PATH_INVALID');
    const candidate = path.resolve(path.isAbsolute(input) ? input : path.join(this.workspace, input));
    const parts = candidate.slice(path.parse(candidate).root.length).split(path.sep).filter(Boolean);
    if (parts.some(part => part.includes(':'))) throw new Error('COMMIT_ALTERNATE_STREAM_DENIED');
    let cursor = path.parse(candidate).root;
    for (const segment of parts.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      let stat: import('node:fs').Stats;
      try { stat = await fs.lstat(cursor); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('COMMIT_PARENT_MISSING');
        throw error;
      }
      if (isLinkOrReparse(stat)) throw new Error('COMMIT_REPARSE_POINT_DENIED');
      if (!stat.isDirectory()) throw new Error('COMMIT_PARENT_NOT_DIRECTORY');
    }
    if (!parts.length) throw new Error('COMMIT_WORKSPACE_IS_DESTINATION');
    const parent = await fs.realpath(path.dirname(candidate));
    if (!within(this.workspace, parent)) throw new Error('COMMIT_PATH_OUTSIDE_WORKSPACE');
    const resolved = path.join(parent, path.basename(candidate));
    try {
      const stat = await fs.lstat(resolved);
      if (isLinkOrReparse(stat)) throw new Error('COMMIT_REPARSE_POINT_DENIED');
      if (!stat.isFile()) throw new Error('COMMIT_DESTINATION_NOT_FILE');
      const canonical = await fs.realpath(resolved);
      if (!within(this.workspace, canonical)) throw new Error('COMMIT_PATH_OUTSIDE_WORKSPACE');
      return { path: canonical, exists: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: resolved, exists: false };
      throw error;
    }
  }

  private async hashFile(filePath: string): Promise<string | null> {
    const target = await this.targetPath(filePath);
    if (!target.exists) return null;
    const handle = await fs.open(target.path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('COMMIT_DESTINATION_NOT_FILE');
      if (stat.size > MAX_COMMIT_BYTES) throw new Error('COMMIT_SNAPSHOT_LIMIT');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_COMMIT_BYTES) throw new Error('COMMIT_SNAPSHOT_LIMIT');
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return hash.digest('hex');
    } finally { await handle.close(); }
  }

  async snapshot(input: string): Promise<string | null> { return this.hashFile(input); }

  private async withTargetLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => gate);
    this.locks.set(key, tail);
    await prior;
    try { return await action(); }
    finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async commit(
    name: string,
    args: Record<string, unknown>,
    stage: StagedWrite,
    options: CommitOptions,
  ): Promise<CommitResult> {
    if (!name || !args || typeof args !== 'object') throw new Error('COMMIT_REQUEST_INVALID');
    if (!stage || !(stage.bytes instanceof Uint8Array) || stage.bytes.byteLength > MAX_COMMIT_BYTES) throw new Error('COMMIT_OUTPUT_LIMIT');
    if (typeof options?.overwrite !== 'boolean') throw new Error('COMMIT_OPTIONS_INVALID');
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== null && !/^[a-f0-9]{64}$/i.test(options.expectedSha256)) throw new Error('COMMIT_EXPECTED_HASH_INVALID');
    const stagedBytes = Buffer.from(stage.bytes);
    const stagedHash = createHash('sha256').update(stagedBytes).digest('hex');
    const firstTarget = await this.targetPath(stage.destination);
    if (typeof args.path !== 'string') throw new Error('COMMIT_AUTHORIZED_PATH_REQUIRED');
    const authorizedTarget = await this.targetPath(args.path);
    if (authorizedTarget.path !== firstTarget.path) throw new Error('COMMIT_DESTINATION_MISMATCH');
    const key = process.platform === 'win32' ? firstTarget.path.toLocaleLowerCase('en-US') : firstTarget.path;
    const expectedHash = typeof options.expectedSha256 === 'string' ? options.expectedSha256.toLowerCase() : options.expectedSha256;

    return this.withTargetLock(key, async () => {
      let tempPath: string | undefined;
      try {
        const before = await this.targetPath(stage.destination);
        const beforeHash = before.exists ? await this.hashFile(before.path) : null;
        if (expectedHash !== undefined && beforeHash !== expectedHash) throw new Error('EDIT_CONFLICT');
        if (!options.overwrite && before.exists) throw new Error('COMMIT_DESTINATION_EXISTS');

        tempPath = path.join(path.dirname(before.path), `.hostdeck-${randomUUID()}.tmp`);
        const handle = await fs.open(tempPath, 'wx', 0o600);
        try { await handle.writeFile(stagedBytes); await handle.sync(); }
        finally { await handle.close(); }

        await this.reauthorize(name, args);

        // Authorization callbacks may take time. Revalidate the path and source immediately before the atomic effect.
        const current = await this.targetPath(stage.destination);
        const currentHash = current.exists ? await this.hashFile(current.path) : null;
        if (expectedHash !== undefined && currentHash !== expectedHash) throw new Error('EDIT_CONFLICT');
        if (!options.overwrite && current.exists) throw new Error('COMMIT_DESTINATION_EXISTS');
        if (current.path !== before.path) throw new Error('EDIT_CONFLICT');

        if (options.overwrite) {
          await fs.rename(tempPath, current.path);
          tempPath = undefined;
        } else {
          // Exclusive hard-link creation is atomic and fails if any destination appeared after the last check.
          await fs.link(tempPath, current.path);
          const linkedTemp = tempPath;
          tempPath = undefined;
          await fs.unlink(linkedTemp).catch(() => fs.rm(linkedTemp, { force: true }).catch(() => undefined));
        }
        return { written: true, sha256: stagedHash };
      } finally {
        if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
  }
}
