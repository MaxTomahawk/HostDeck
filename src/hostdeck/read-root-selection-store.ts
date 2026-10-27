/**
 * Reuses the installer-controlled HostDeck configuration and the existing
 * PolicyGate context. No parallel owner-selection/approval files or MCP setter.
 * An absent read_roots field retains workspace-only behavior.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as flags } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeError } from './runtime-error.js';
import { safeRealpath, qualifyFixedVolumes } from './fulltext/policy.js';
import type { FullTextNativeBridge } from './fulltext-native-bridge.js';
import type { ProtectedReadRootSelection, ReadRootOwner } from './read-root-boundary.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const absolute = z.string().min(1).max(4096).refine(path.isAbsolute);

/** Optional field of the EXISTING strict installer configuration. */
export const readRootsConfigSchema = z.object({
  revision: identifier,
  roots: z.array(absolute).min(1).max(128),
  excluded_roots: z.array(absolute).max(256).default([]),
  fixed_volume_roots: z.array(absolute).max(8).default([]),
}).strict();

const liveConfig = z.object({
  version: z.literal(1), device_id: identifier, executor_id: identifier,
  expected_user_sid: z.string().regex(/^S-1-5-[0-9-]+$/),
  workspace: absolute, read_roots: readRootsConfigSchema.optional(),
}).passthrough();

type Owner = ReadRootOwner & {
  readonly revision?: string;
  readonly sessionId?: number;
  readonly sessionIds?: readonly number[];
};
type Expected = {
  readonly deviceId: string;
  readonly executorId: string;
  readonly sid: string;
  readonly sessionId: number;
};
type NativeAcl = Pick<FullTextNativeBridge, 'probeProtectedObjectAcl'>;
const denied = (): never => { throw new RuntimeError('READ_ROOT_CONFIG_UNQUALIFIED'); };
const same = (a: import('node:fs').BigIntStats,
  b: import('node:fs').BigIntStats): boolean =>
  a.dev === b.dev && a.ino !== 0n && a.ino === b.ino &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/**
 * The only authority for additional roots is a physically protected existing
 * config file, read afresh with actual handle identity and verified native ACL.
 * The live PolicyGate/grants remain responsible for caller authorization.
 */
export class ReadRootSelectionStore {
  private readonly fixedEvidence = new Map<string, number>();
  constructor(
    readonly configFile: string,
    readonly workspace: string,
    private readonly expected: Expected,
    private readonly acl?: NativeAcl,
  ) {
    if (!path.isAbsolute(configFile) || !path.isAbsolute(workspace) ||
        !expected?.sid || !expected.deviceId || !expected.executorId ||
        !Number.isInteger(expected.sessionId) || expected.sessionId <= 0) denied();
    const rel = path.relative(path.resolve(workspace), path.resolve(configFile));
    if (!rel || (rel !== '..' && !rel.startsWith('..' + path.sep) &&
        !path.isAbsolute(rel))) denied();
  }

  private async protectedRead(): Promise<Buffer> {
    if (!this.acl) denied();
    const verify = async () => {
      // The existing native ACL probe inspects the target and ALL ancestors.
      // It denies executor write, replace, rename and delete-child authority.
      const proof = await this.acl!.probeProtectedObjectAcl(this.configFile);
      if (proof.verified !== true || proof.code !== 'FULLTEXT_NATIVE_ACL_VERIFIED' ||
          proof.scope !== 'physical_filesystem_snapshot_only' ||
          proof.componentsChecked < 1) denied();
    };
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      await verify();
      await safeRealpath(this.configFile);
      const before = await fs.stat(this.configFile, { bigint: true });
      handle = await fs.open(this.configFile, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.size < 1n || opened.size > 262144n ||
          !same(before, opened)) denied();
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const linked = await fs.stat(this.configFile, { bigint: true });
      await safeRealpath(this.configFile);
      await verify();
      if (!same(opened, after) || !same(opened, linked) ||
          bytes.length !== Number(opened.size)) denied();
      return bytes;
    } catch { return denied(); }
    finally { await handle?.close(); }
  }

  private async qualifyFixed(volumes: readonly string[], roots: readonly string[],
    digest: string): Promise<void> {
    const normalized = (value: string) => path.resolve(value).toLowerCase();
    if (new Set(volumes.map(normalized)).size !== volumes.length) denied();
    for (const root of roots) {
      if (normalized(root) === normalized(path.parse(root).root) &&
          !volumes.some(value => normalized(value) === normalized(root))) denied();
    }
    for (const volume of volumes) {
      if (normalized(volume) !== normalized(path.parse(volume).root) ||
          !roots.some(root => normalized(root) === normalized(volume))) denied();
    }
    if (!volumes.length) return;
    const now = Date.now();
    const key = digest + ':' + volumes.map(normalized).sort().join(';');
    if ((this.fixedEvidence.get(key) ?? 0) > now) return;
    try {
      // Existing Windows DriveInfo qualification; no index scan or side effect.
      await qualifyFixedVolumes({
        fixedVolumeRoots: [...volumes],
      } as unknown as Parameters<typeof qualifyFixedVolumes>[0]);
    } catch { denied(); }
    this.fixedEvidence.set(key, Date.now() + 10000);
  }

  async selected(principal: ReadRootOwner): Promise<ProtectedReadRootSelection | null> {
    const caller = principal as Owner;
    if (!caller?.ownerId || caller.deviceId !== this.expected.deviceId ||
        caller.executorId !== this.expected.executorId || !caller.revision ||
        !caller.sessionIds?.includes(this.expected.sessionId) ||
        (caller.sessionId !== undefined &&
         caller.sessionId !== this.expected.sessionId)) return null;
    if (!this.acl) return null;
    const input = await this.protectedRead();
    let value: unknown;
    try { value = JSON.parse(input.toString('utf8')); }
    catch { return denied(); }
    const parsed = liveConfig.safeParse(value);
    if (!parsed.success) denied();
    const data = parsed.data;
    if (data.device_id !== this.expected.deviceId ||
        data.executor_id !== this.expected.executorId ||
        data.expected_user_sid !== this.expected.sid ||
        path.resolve(data.workspace).toLowerCase() !==
        path.resolve(this.workspace).toLowerCase()) denied();
    const roots = data.read_roots;
    if (!roots) return null;
    const digest = createHash('sha256').update(input).digest('hex');
    await this.qualifyFixed(roots.fixed_volume_roots, roots.roots, digest);
    return {
      owner: { ownerId: caller.ownerId, deviceId: caller.deviceId,
        executorId: caller.executorId },
      revision: roots.revision + ':' + caller.revision + ':' + this.expected.sessionId,
      digest,
      roots: roots.roots,
      excludedRoots: roots.excluded_roots,
      fixedVolumeRoots: roots.fixed_volume_roots,
    };
  }
}
