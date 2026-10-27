/**
 * Read-only, dormant owner selection. The installer or authorized local owner
 * workflow (not this MCP adapter) must create BOTH protected records.
 * Native effective-ACL evidence is mandatory on every selection read.
 * No code here writes approvals, grants, configuration, or an index.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as flags } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RuntimeError } from './runtime-error.js';
import { safeRealpath } from './fulltext/policy.js';
import type { FullTextNativeBridge } from './fulltext-native-bridge.js';
import type { ProtectedReadRootSelection, ReadRootOwner } from './read-root-boundary.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const owner = z.object({ ownerId: identifier, deviceId: identifier,
  executorId: identifier }).strict();
const absolute = z.string().min(1).max(4096).refine(path.isAbsolute);
const selectionSchema = z.object({
  version: z.literal(1),
  owner,
  revision: identifier,
  selection: z.object({
    roots: z.array(absolute).max(128),
    excludedRoots: z.array(absolute).max(256),
    fixedVolumeRoots: z.array(absolute).max(8).default([]),
  }).strict(),
}).strict();
const approvalSchema = z.object({
  version: z.literal(1),
  owner,
  revision: identifier,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvedAt: z.string().datetime({ offset: true }),
  source: z.literal('protected-local-owner-approval'),
}).strict();
type Selection = z.infer<typeof selectionSchema>;

const denied = (code = 'READ_ROOT_PROTECTED_SELECTION_INVALID'): never => {
  throw new RuntimeError(code);
};
const sameOwner = (a: ReadRootOwner, b: ReadRootOwner): boolean =>
  a.ownerId === b.ownerId && a.deviceId === b.deviceId &&
  a.executorId === b.executorId;
const equals = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const contains = (root: string, other: string): boolean => {
  const rel = path.relative(root, other);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel));
};

/** Deterministic digest includes exact owner, revision and selected roots. */
export function readRootContentDigest(value: Selection): string {
  return createHash('sha256').update(JSON.stringify({
    version: value.version, owner: value.owner, revision: value.revision,
    selection: {
      roots: [...value.selection.roots].sort(),
      excludedRoots: [...value.selection.excludedRoots].sort(),
      fixedVolumeRoots: [...value.selection.fixedVolumeRoots].sort(),
    },
  })).digest('hex');
}

export interface NativeReadRootAclProbe {
  probeProtectedObjectAcl: FullTextNativeBridge['probeProtectedObjectAcl'];
}
const run = promisify(execFileCallback);
/**
 * Fixed drive root is never inferred from an ordinary directory or broad grant.
 * Only trusted owner records which explicitly name an X:\\ root can reach this.
 */
async function qualifyFixedDrive(volume: string): Promise<void> {
  if (process.platform !== 'win32' || !/^[A-Za-z]:\\$/.test(volume))
    denied('READ_ROOT_FIXED_VOLUME_UNQUALIFIED');
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot))
    denied('READ_ROOT_FIXED_VOLUME_UNQUALIFIED');
  const ps = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell',
    'v1.0', 'powershell.exe');
  try {
    const drive = volume.slice(0, 2);
    const script = "[System.IO.DriveInfo]::new('" + drive + "').DriveType.ToString()";
    const { stdout, stderr } = await run(ps, ['-NoLogo', '-NoProfile',
      '-NonInteractive', '-Command', script], {
      shell: false, windowsHide: true, timeout: 4500,
      maxBuffer: 1024, encoding: 'utf8',
    });
    if (stdout.trim() !== 'Fixed' || stderr.trim()) throw new Error('unqualified');
  } catch {
    denied('READ_ROOT_FIXED_VOLUME_UNQUALIFIED');
  }
}

export class ReadRootSelectionStore {
  readonly selectionFile: string;
  readonly approvalFile: string;
  private readonly driveEvidence = new Map<string, number>();
  constructor(
    readonly protectedDirectory: string,
    workspace: string,
    private readonly nativeAcl?: NativeReadRootAclProbe,
  ) {
    if (!path.isAbsolute(protectedDirectory) || !path.isAbsolute(workspace) ||
        contains(path.resolve(workspace), path.resolve(protectedDirectory))) {
      denied('READ_ROOT_PROTECTED_DIRECTORY_INVALID');
    }
    this.selectionFile = path.join(protectedDirectory, 'read-roots-selection.json');
    this.approvalFile = path.join(protectedDirectory, 'read-roots-approval.json');
  }

  private async qualified(): Promise<boolean> {
    if (!this.nativeAcl) return false;
    for (const file of [this.protectedDirectory, this.selectionFile,
      this.approvalFile]) {
      let proof: Awaited<ReturnType<NativeReadRootAclProbe['probeProtectedObjectAcl']>>;
      try { proof = await this.nativeAcl.probeProtectedObjectAcl(file); }
      catch { denied('READ_ROOT_EFFECTIVE_ACL_UNQUALIFIED'); }
      if (proof.verified !== true || proof.code !== 'FULLTEXT_NATIVE_ACL_VERIFIED' ||
          proof.scope !== 'physical_filesystem_snapshot_only' ||
          proof.componentsChecked < 1) {
        denied('READ_ROOT_EFFECTIVE_ACL_UNQUALIFIED');
      }
    }
    return true;
  }

  private async read(file: string): Promise<unknown | null> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      await safeRealpath(this.protectedDirectory);
      await safeRealpath(file);
      handle = await fs.open(file, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
      const before = await handle.stat({ bigint: true });
      const target = await fs.stat(file, { bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > 32768n ||
          before.dev !== target.dev || before.ino !== target.ino) denied();
      const input = await handle.readFile('utf8');
      const after = await handle.stat({ bigint: true });
      const current = await fs.stat(file, { bigint: true });
      await safeRealpath(file);
      if (after.dev !== before.dev || after.ino !== before.ino ||
          after.size !== before.size || before.dev !== current.dev ||
          before.ino !== current.ino) denied();
      return JSON.parse(input);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      denied();
    } finally { await handle?.close(); }
  }

  private async fixedVolumeQualification(config: Selection, digest: string): Promise<void> {
    const volumes = config.selection.fixedVolumeRoots;
    const roots = config.selection.roots;
    const normalize = (s: string) => path.resolve(s).toLowerCase();
    if (volumes.length > 8 || new Set(volumes.map(normalize)).size !== volumes.length)
      denied('READ_ROOT_FIXED_VOLUME_UNQUALIFIED');
    for (const root of roots) {
      if (equals(path.resolve(root), path.parse(root).root) &&
          !volumes.some(volume => equals(path.resolve(root), path.resolve(volume)))) {
        denied('READ_ROOT_FIXED_VOLUME_UNQUALIFIED');
      }
    }
    for (const volume of volumes) {
      if (!roots.some(root => equals(path.resolve(root), path.resolve(volume))) ||
          !equals(path.resolve(volume), path.parse(volume).root)) {
        denied('READ_ROOT_FIXED_VOLUME_UNQUALIFIED');
      }
      const key = digest + ':' + normalize(volume);
      const freshUntil = this.driveEvidence.get(key) ?? 0;
      if (Date.now() > freshUntil) {
        await qualifyFixedDrive(volume);
        this.driveEvidence.set(key, Date.now() + 10_000);
      }
    }
  }

  /** Every call rechecks effective ACLs, both protected records and revision. */
  async selected(c: ReadRootOwner): Promise<ProtectedReadRootSelection | null> {
    if (!c?.ownerId || !c.deviceId || !c.executorId) return null;
    if (!await this.qualified()) return null; // no verified native proof => dormant
    const source = await this.read(this.selectionFile);
    const approval = await this.read(this.approvalFile);
    if (source === null || approval === null) return null; // revoked/never approved
    const selected = selectionSchema.safeParse(source);
    const approved = approvalSchema.safeParse(approval);
    if (!selected.success || !approved.success) denied();
    if (!sameOwner(selected.data.owner, c) || !sameOwner(approved.data.owner, c))
      return null;
    const digest = readRootContentDigest(selected.data);
    if (digest !== approved.data.contentDigest ||
        selected.data.revision !== approved.data.revision ||
        Date.parse(approved.data.approvedAt) > Date.now()) return null;
    // Never substitute caller booleans or an ordinary user ACL for a protected
    // record. DriveInfo qualification is read-only and required only for
    // explicitly named fixed local volume roots.
    await this.fixedVolumeQualification(selected.data, digest);
    return { owner: selected.data.owner, revision: selected.data.revision,
      digest, roots: selected.data.selection.roots,
      excludedRoots: selected.data.selection.excludedRoots,
      fixedVolumeRoots: selected.data.selection.fixedVolumeRoots };
  }
}
