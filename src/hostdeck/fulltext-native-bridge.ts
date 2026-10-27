/**
 * PRIVATE fulltext-native bridge. Not registered as a public MCP operation.
 * The coordinator must supply a trusted installer-pinned worker executable,
 * its SHA-256, a locally observed executor identity and per-path policy checks.
 * The CLI is read-only and does not itself grant authorization.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface FullTextNativeIdentity {
  sid: string;
  logonId: string;
  sessionId: number;
}

export interface FullTextNativeOptions {
  workerExecutable: string;
  workerSha256: string;
  /** From trusted local executor state, NEVER an MCP caller-supplied identity. */
  expectedExecutor: FullTextNativeIdentity;
  timeoutMs?: number;
}

export interface FullTextNativeAttribute {
  index: number;
  status: 'ok' | 'unavailable' | 'reparse_component';
  hidden: boolean | null;
  system: boolean | null;
  reparse: boolean | null;
  hidden_component: boolean | null;
  system_component: boolean | null;
  directory: boolean | null;
}

/** Exact additive callback argument shape of fulltext PR21. */
export interface FullTextProtectedOwnerPaths {
  protectedDirectory: string;
  selectionFile: string;
  approvalFile: string;
  indexDirectory: string;
}

/** Read-only observation about ONE existing object, not owner-record acceptance. */
export interface FullTextProtectedObjectProbe {
  verified: boolean;
  status: 'verified' | 'unqualified';
  code: 'FULLTEXT_NATIVE_ACL_VERIFIED' | 'FULLTEXT_NATIVE_ACL_UNQUALIFIED';
  reason?: string;
  componentsChecked: number;
  failedComponentIndex?: number;
  failedComponentRole?: 'root' | 'ancestor' | 'target';
  scope: 'physical_filesystem_snapshot_only';
}

interface Pending {
  id: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function error(code: string): Error {
  return new Error(code);
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const buffer of createReadStream(file)) hash.update(buffer);
  return hash.digest('hex');
}

export class FullTextNativeBridge {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending?: Pending;
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private initialized = false;
  private opening?: Promise<void>;
  private closed = false;
  private readonly timeout: number;

  constructor(private readonly options: FullTextNativeOptions) {
    if (!/^[A-Za-z]:\\/.test(options.workerExecutable) ||
        !path.win32.isAbsolute(options.workerExecutable) ||
        !/^[a-fA-F0-9]{64}$/.test(options.workerSha256) ||
        !/^[A-Za-z0-9_.-]{1,200}$/.test(options.expectedExecutor.sid) ||
        !/^[a-fA-F0-9]{16}$/.test(options.expectedExecutor.logonId) ||
        !Number.isInteger(options.expectedExecutor.sessionId) ||
        options.expectedExecutor.sessionId < 0) {
      throw error('FULLTEXT_NATIVE_BRIDGE_CONFIG_INVALID');
    }
    this.timeout = Math.max(300, Math.min(5000, options.timeoutMs ?? 3000));
  }

  private failPending(code: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error(code));
  }

  private receive(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > 131072) {
      this.failPending('FULLTEXT_NATIVE_RESPONSE_LIMIT');
      this.child?.kill();
      return;
    }
    while (true) {
      const at = this.buffer.indexOf('\n');
      if (at < 0) break;
      const line = this.buffer.slice(0, at).trimEnd();
      this.buffer = this.buffer.slice(at + 1);
      let record: any;
      try { record = JSON.parse(line); } catch {
        this.failPending('FULLTEXT_NATIVE_PROTOCOL_INVALID');
        this.child?.kill(); return;
      }
      const pending = this.pending;
      if (!pending || record?.id !== pending.id ||
          (record?.error === undefined && record?.result === undefined)) {
        this.failPending('FULLTEXT_NATIVE_PROTOCOL_INVALID');
        this.child?.kill(); return;
      }
      this.pending = undefined;
      clearTimeout(pending.timer);
      if (record.error !== undefined) {
        const code = record.error?.code;
        pending.reject(error(typeof code === 'string' && /^FULLTEXT_NATIVE_[A-Z0-9_]+$/.test(code)
          ? code : 'FULLTEXT_NATIVE_UNAVAILABLE'));
      } else {
        pending.resolve(record.result);
      }
    }
  }

  private async raw(operation: string, args: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) {
      throw error('FULLTEXT_NATIVE_WORKER_UNAVAILABLE');
    }
    if (this.pending) throw error('FULLTEXT_NATIVE_REQUEST_CONFLICT');
    const id = String(++this.sequence);
    const line = JSON.stringify({ id, operation, args }) + '\n';
    if (line.length > 65536) throw error('FULLTEXT_NATIVE_INPUT_LIMIT');
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPending('FULLTEXT_NATIVE_TIMEOUT');
        // Stop ONLY this owned helper, never the agent or another service.
        child.kill();
      }, this.timeout);
      this.pending = { id, resolve, reject, timer };
      child.stdin.write(line, 'utf8', writeError => {
        if (writeError) this.failPending('FULLTEXT_NATIVE_WORKER_UNAVAILABLE');
      });
    });
  }

  async open(): Promise<void> {
    if (this.closed) throw error('FULLTEXT_NATIVE_WORKER_CLOSED');
    if (this.initialized) return;
    if (this.opening) return this.opening;
    this.opening = this.openWorker();
    try { await this.opening; } finally { this.opening = undefined; }
  }

  private async openWorker(): Promise<void> {
    if (this.closed) throw error('FULLTEXT_NATIVE_WORKER_CLOSED');
    if (process.platform !== 'win32') throw error('FULLTEXT_NATIVE_WINDOWS_REQUIRED');
    let actualHash: string;
    try { actualHash = await digest(this.options.workerExecutable); }
    catch { throw error('FULLTEXT_NATIVE_BINARY_UNAVAILABLE'); }
    if (actualHash.toLowerCase() !== this.options.workerSha256.toLowerCase())
      throw error('FULLTEXT_NATIVE_BINARY_CHANGED');
    if (this.closed) throw error('FULLTEXT_NATIVE_WORKER_CLOSED');
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'DOTNET_ROOT']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.workerExecutable, ['--fulltext-native'], {
        stdio: 'pipe', shell: false, windowsHide: true, env,
      });
    } catch { throw error('FULLTEXT_NATIVE_WORKER_UNAVAILABLE'); }
    this.child = child;
    this.buffer = '';
    child.stdout.on('data', (data: Buffer) => this.receive(data));
    child.stderr.resume(); // Never emit potentially private native diagnostics.
    child.once('error', () => this.failPending('FULLTEXT_NATIVE_WORKER_UNAVAILABLE'));
    child.once('close', () => {
      this.initialized = false;
      this.failPending('FULLTEXT_NATIVE_WORKER_EXITED');
      if (this.child === child) this.child = undefined;
    });
    try {
      if (this.closed) throw error('FULLTEXT_NATIVE_WORKER_CLOSED');
      const identity = await this.raw('identity', {}) as Record<string, unknown>;
      const expected = this.options.expectedExecutor;
      if (identity.sid !== expected.sid ||
          identity.logon_id !== expected.logonId ||
          identity.session_id !== expected.sessionId ||
          identity.elevated !== false) {
        throw error('FULLTEXT_NATIVE_EXECUTOR_IDENTITY_MISMATCH');
      }
      if (this.closed) throw error('FULLTEXT_NATIVE_WORKER_CLOSED');
      this.initialized = true;
    } catch {
      child.kill();
      this.child = undefined;
      this.initialized = false;
      throw error('FULLTEXT_NATIVE_EXECUTOR_UNQUALIFIED');
    }
  }

  private async queued(operation: string, args: Record<string, unknown>): Promise<unknown> {
    // One reply is always consumed before the next request. No correlation
    // ambiguity, no process-per-file and no background scan.
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = next;
    await previous;
    try {
      if (this.closed) throw error('FULLTEXT_NATIVE_WORKER_CLOSED');
      await this.open();
      return await this.raw(operation, args);
    } finally { release(); }
  }

  /** Caller must run its fresh per-path PolicyGate/root checks first. */
  async attributes(paths: readonly string[],
    authorize: (file: string) => Promise<boolean>): Promise<FullTextNativeAttribute[]> {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 64 ||
        paths.reduce((sum, p) => sum + (typeof p === 'string' ? p.length : 50000), 0) > 32768) {
      throw error('FULLTEXT_NATIVE_BATCH_LIMIT');
    }
    for (const file of paths) {
      let allowed = false;
      try { allowed = await authorize(file) === true; } catch { /* default deny */ }
      if (!allowed) throw error('FULLTEXT_NATIVE_AUTHORIZATION_REQUIRED');
    }
    const result = await this.queued('attributes_batch', {paths}) as Record<string, any>;
    if (result?.count !== paths.length || !Array.isArray(result.items) ||
        result.items.length !== paths.length) throw error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
    return result.items.map((item: any, index: number) => {
      if (item?.index !== index || !['ok','unavailable','reparse_component'].includes(item?.status) ||
        !['hidden','system','reparse','hidden_component','system_component','directory']
          .every(key => item[key] === null || typeof item[key] === 'boolean')) {
        throw error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
      }
      return item as FullTextNativeAttribute;
    });
  }

  /**
   * Enumerate ONLY against the directory handle opened by the pinned worker.
   * The expected inode is taken from a fresh trusted fs.stat, never an MCP
   * argument. The worker compares it with GetFileInformationByHandle before
   * returning any names. Unsupported or stale workers fail closed.
   */
  async directoryPage(file: string, expectedIno: bigint, offset: number,
    limit: number, authorize: (file: string) => Promise<boolean>): Promise<{
      names: string[]; more: boolean; nextOffset: number;
    }> {
    if (typeof file !== 'string' || !/^[A-Za-z]:\\/.test(file) ||
        expectedIno <= 0n || expectedIno > 18446744073709551615n ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 192)
      throw error('FULLTEXT_NATIVE_INVALID_ARGUMENTS');
    let allowed = false;
    try { allowed = await authorize(file) === true; } catch { /* deny */ }
    if (!allowed) throw error('FULLTEXT_NATIVE_AUTHORIZATION_REQUIRED');
    const result = await this.queued('directory_page', {
      path: file, expected_ino: expectedIno.toString(), offset, limit,
    }) as Record<string, unknown>;
    if (!result || !Array.isArray(result.names) ||
        result.names.length > limit || typeof result.more !== 'boolean' ||
        result.next_offset !== offset + result.names.length ||
        result.names.some(name => typeof name !== 'string' ||
          name.length < 1 || name.length > 255 ||
          name === '.' || name === '..' || name.includes('\\') ||
          name.includes('/') || name.includes(':') || name.includes('\0')) ||
        (result.more && result.names.length === 0))
      throw error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
    return { names: result.names as string[], more: result.more,
      nextOffset: result.next_offset as number };
  }

  /**
   * Qualify only the existing object supplied by the trusted coordinator.
   * Read-only, no owner records/index requirement and NO approval side effect.
   * The result is normalized: native paths, SIDs and arbitrary fields never
   * escape this bridge. A positive is NOT a verified owner_boundary.
   */
  async probeProtectedObjectAcl(file: string): Promise<FullTextProtectedObjectProbe> {
    if (typeof file !== 'string' || file.length > 4096 ||
        !/^[A-Za-z]:\\/.test(file)) throw error('FULLTEXT_NATIVE_BRIDGE_CONFIG_INVALID');
    const raw = await this.queued('effective_acl', { path: file });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
    const value = raw as Record<string, unknown>;
    if (value.scope !== 'physical_filesystem_snapshot_only' ||
        !Number.isSafeInteger(value.components_checked) ||
        (value.components_checked as number) < 0 ||
        (value.components_checked as number) > 41)
      throw error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
    const componentsChecked = value.components_checked as number;
    if (value.verified === true && value.status === 'verified' &&
        value.code === 'FULLTEXT_NATIVE_ACL_VERIFIED' &&
        value.token_write_denied === true &&
        value.trusted_owner_and_writers === true && componentsChecked > 0) {
      return { verified: true, status: 'verified', code: 'FULLTEXT_NATIVE_ACL_VERIFIED',
        componentsChecked, scope: 'physical_filesystem_snapshot_only' };
    }
    if (value.verified === false && value.status === 'unqualified' &&
        value.code === 'FULLTEXT_NATIVE_ACL_UNQUALIFIED' &&
        typeof value.reason === 'string' &&
        /^[A-Z][A-Z0-9_]{0,79}$/.test(value.reason)) {
      const failedComponentIndex = value.failed_component_index;
      const failedComponentRole = value.failed_component_role;
      if (!(failedComponentIndex == null ||
            (Number.isSafeInteger(failedComponentIndex) &&
            (failedComponentIndex as number) === componentsChecked)) ||
          !(failedComponentRole == null ||
            ['root', 'ancestor', 'target'].includes(String(failedComponentRole))) ||
          (failedComponentRole == null) !== (failedComponentIndex == null)) {
        throw error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
      }
      return {
        verified: false, status: 'unqualified', code: 'FULLTEXT_NATIVE_ACL_UNQUALIFIED',
        reason: value.reason, componentsChecked,
        ...(failedComponentIndex == null ? {} : {
          failedComponentIndex: failedComponentIndex as number,
          failedComponentRole: failedComponentRole as 'root' | 'ancestor' | 'target',
        }),
        scope: 'physical_filesystem_snapshot_only',
      };
    }
    throw error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
  }

  /**
   * Exact optional PR21 FullTextProtectedAclVerifier-compatible callback.
   * Reads three separately protected objects and a disjoint executor-writable
   * SQLite directory. A positive snapshot is NEVER owner consent, a broader
   * PolicyGate grant, or cryptographic intended-application isolation.
   */
  async verifyProtectedOwnerAcl(paths: Readonly<FullTextProtectedOwnerPaths>): Promise<void> {
    if (!paths || Object.values(paths).some(value => typeof value !== 'string'))
      throw error('FULLTEXT_NATIVE_BRIDGE_CONFIG_INVALID');
    const result = await this.queued('owner_boundary', {...paths}) as Record<string, unknown>;
    if (result?.verified !== true || result?.status !== 'verified' ||
        result?.code !== 'FULLTEXT_NATIVE_BOUNDARY_VERIFIED' ||
        result?.writable_index_separate !== true || result?.protected_sources !== 3) {
      throw error('FULLTEXT_NATIVE_BOUNDARY_UNQUALIFIED');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.initialized = false;
    this.child = undefined;
    this.failPending('FULLTEXT_NATIVE_WORKER_CLOSED');
    if (!child) return;
    const closed = new Promise<void>(resolve => child.once('close', resolve));
    child.stdin.end();
    const result = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
    ]);
    if (!result) {
      child.kill(); // Only the bridge-owned helper, never an ordinary user job.
      await Promise.race([
        closed,
        new Promise<void>(resolve => setTimeout(resolve, 1000)),
      ]);
    }
  }
}
