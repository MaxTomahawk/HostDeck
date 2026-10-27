/**
 * B007 scoped diagnostics: measurements of exactly seven known release files and
 * one package manifest. This is NOT code signing, source attestation or a search
 * API. Paths, OS identities, raw manifest entries and filesystem errors never
 * leave this module.
 */
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const COMPONENT_IDS = [
  'main', 'gateway', 'contracts', 'state', 'node',
  'native_exe', 'native_dll',
] as const;
export type ComponentId = typeof COMPONENT_IDS[number];
export type Observation = 'observed' | 'missing' | 'unreadable' | 'reparse' |
  'not_regular' | 'too_large' | 'time_limit' | 'unstable' | 'unbound';
export type Comparison = 'match' | 'mismatch' | 'unknown';
export interface ComponentProvenance {
  component_id: ComponentId;
  observation: Observation;
  observed_sha256: string | null;
  expected_sha256: string | null;
  comparison: Comparison;
  size_bytes: number | null;
}
export interface ManifestProvenance {
  observation: Observation;
  observed_sha256: string | null;
  size_bytes: number | null;
  schema_status: 'valid' | 'invalid' | 'unknown';
  expected_digest_sha256: null;
  digest_binding: 'unknown';
}
export interface DiagnosticsProvenance {
  schema: 1;
  scope: 'known_release_components';
  layout: 'resolved' | 'unavailable' | 'conflict';
  manifest: ManifestProvenance;
  components: ComponentProvenance[];
  component_comparison: 'mismatch' | 'all_match_unsigned' | 'unknown';
  signature_binding: 'unknown';
  source_binding: 'unknown';
}
export interface ProvenanceInputs {
  /** Executing state/index.js from the loaded module, not request data. */
  moduleFile: string;
  /** Actual process.execPath, not a caller-supplied executable. */
  nodeExecutable: string;
  /** Existing trusted StateOptions.desktopWorkerExecutable, when configured. */
  nativeExecutable?: string;
  /** Fixture-only seam; StateServices never supplies this from a tool call. */
  onChunkForTest?: (component: ComponentId | 'manifest', bytes: number) => void | Promise<void>;
  /** Fixture-only limits. They can tighten, never relax, production bounds. */
  limitsForTest?: { fileBytes?: number; manifestBytes?: number; totalBytes?: number; durationMs?: number };
}

const COMPONENT_PATHS: Record<ComponentId, string> = {
  main: 'agent/dist/hostdeck/main.js',
  gateway: 'agent/dist/hostdeck/gateway.js',
  contracts: 'agent/dist/hostdeck/contracts.js',
  state: 'agent/dist/hostdeck/state/index.js',
  node: 'agent/node.exe',
  native_exe: 'desktop/HostDeck.DesktopWorker.exe',
  native_dll: 'desktop/HostDeck.DesktopWorker.dll',
};
const MAX_FILE = 160 * 1024 * 1024;
const MAX_MANIFEST = 8 * 1024 * 1024;
const MAX_TOTAL = 300 * 1024 * 1024;
const MAX_DURATION = 12_000;
const CHUNK = 64 * 1024;
const HEX_SHA = /^[a-fA-F0-9]{64}$/;
type FileResult = {
  observation: Observation;
  sha256: string | null;
  size: number | null;
  bytes?: Buffer;
};

function samePath(a: string, b: string): boolean {
  if (!path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function moduleReleaseRoot(file: string): string | null {
  if (!path.isAbsolute(file) || path.basename(file) !== 'index.js') return null;
  const stateDir = path.dirname(file);
  const hostdeckDir = path.dirname(stateDir);
  const distDir = path.dirname(hostdeckDir);
  const agentDir = path.dirname(distDir);
  if ([path.basename(stateDir), path.basename(hostdeckDir),
    path.basename(distDir), path.basename(agentDir)].join('/') !==
      'state/hostdeck/dist/agent') return null;
  return path.dirname(agentDir);
}
function nativeReleaseRoot(file: string | undefined): string | null {
  if (!file || !path.isAbsolute(file) ||
      path.basename(file) !== 'HostDeck.DesktopWorker.exe' ||
      path.basename(path.dirname(file)) !== 'desktop') return null;
  return path.dirname(path.dirname(file));
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
}
function fail(error: unknown): Observation {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'missing';
  if (code === 'ELOOP') return 'reparse';
  return 'unreadable';
}
function unavailable(observation: Observation): FileResult {
  return { observation, sha256: null, size: null };
}
function limited(value: number | undefined, ceiling: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, ceiling) : ceiling;
}

/** A bounded streaming hash of a fixed package-relative file, with pre/post
 * identity and reparse checks. Manifest bytes are buffered only up to 8 MiB.
 */
async function inspectFile(
  root: string, relative: string, id: ComponentId | 'manifest',
  budget: { remaining: number; deadline: number; perFile: number; manifest: number },
  testHook?: ProvenanceInputs['onChunkForTest'],
): Promise<FileResult> {
  if (Date.now() >= budget.deadline) return unavailable('time_limit');
  const parts = relative.split('/');
  if (!parts.length || parts.some(piece => !piece || piece === '.' || piece === '..')) {
    return unavailable('unbound');
  }
  let rootStat: BigIntStats;
  let rootReal: string;
  let fileRelativeBefore: string;
  try {
    rootStat = await lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return unavailable('reparse');
    rootReal = await realpath(root);
  } catch (error) { return unavailable(fail(error)); }
  const final = path.join(root, ...parts);
  try {
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const item = await lstat(current, { bigint: true });
      if (item.isSymbolicLink()) return unavailable('reparse');
      if (i < parts.length - 1 && !item.isDirectory()) return unavailable('not_regular');
      if (i === parts.length - 1 && !item.isFile()) return unavailable('not_regular');
    }
    const resolved = await realpath(final);
    const relation = path.relative(rootReal, resolved);
    fileRelativeBefore = relation;
    if (!relation || relation === '..' || relation.startsWith('..' + path.sep) ||
        path.isAbsolute(relation)) return unavailable('reparse');
  } catch (error) { return unavailable(fail(error)); }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(final, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await file.stat({ bigint: true });
    const atPath = await lstat(final, { bigint: true });
    if (!before.isFile() || !sameIdentity(before, atPath)) return unavailable('unstable');
    const max = id === 'manifest' ? budget.manifest : budget.perFile;
    if (before.size > BigInt(max) || before.size > BigInt(budget.remaining)) {
      return unavailable('too_large');
    }
    const size = Number(before.size);
    const hasher = createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK);
    const blocks: Buffer[] | undefined = id === 'manifest' ? [] : undefined;
    let offset = 0, hooked = false;
    while (offset < size) {
      if (Date.now() >= budget.deadline) return unavailable('time_limit');
      const count = Math.min(CHUNK, size - offset);
      const read = await file.read(buffer, 0, count, offset);
      if (read.bytesRead <= 0) return unavailable('unstable');
      const chunk = buffer.subarray(0, read.bytesRead);
      hasher.update(chunk);
      if (blocks) blocks.push(Buffer.from(chunk));
      offset += read.bytesRead;
      budget.remaining -= read.bytesRead;
      if (!hooked && testHook) {
        hooked = true;
        await testHook(id, offset);
      }
    }
    const after = await file.stat({ bigint: true });
    const pathAfter = await lstat(final, { bigint: true });
    const rootAfter = await lstat(root, { bigint: true });
    const realAfter = await realpath(final);
    const relAfter = path.relative(rootReal, realAfter);
    if (!sameIdentity(before, after) || !sameIdentity(before, pathAfter) ||
        !sameIdentity(rootStat, rootAfter) || relAfter !== fileRelativeBefore) {
      return unavailable('unstable');
    }
    if (relAfter === '..' || relAfter.startsWith('..' + path.sep) ||
        path.isAbsolute(relAfter)) return unavailable('unstable');
    if (Date.now() >= budget.deadline) return unavailable('time_limit');
    const sha256 = hasher.digest('hex');
    return { observation: 'observed', sha256, size,
      ...(blocks ? { bytes: Buffer.concat(blocks, size) } : {}) };
  } catch (error) {
    return unavailable(fail(error));
  } finally {
    await file?.close().catch(() => {});
  }
}

function expectedDigests(bytes: Buffer | undefined): Map<ComponentId, string> | null {
  if (!bytes) return null;
  let source: unknown;
  try { source = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const manifest = source as Record<string, unknown>;
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) ||
      manifest.files.length < 3 || manifest.files.length > 50_000) return null;
  const reverse = new Map<string, ComponentId>(
    COMPONENT_IDS.map(id => [COMPONENT_PATHS[id], id]));
  const expected = new Map<ComponentId, string>();
  for (const row of manifest.files) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    if (typeof record.path !== 'string') return null;
    // Ignore unrelated names; do not resolve or read them.
    const selected = reverse.get(record.path);
    if (!selected) continue;
    if (expected.has(selected) ||
        typeof record.sha256 !== 'string' || !HEX_SHA.test(record.sha256)) return null;
    expected.set(selected, record.sha256.toLowerCase());
  }
  return expected;
}

export async function observeDiagnosticsProvenance(input: ProvenanceInputs): Promise<DiagnosticsProvenance> {
  const fromModule = moduleReleaseRoot(input.moduleFile);
  const fromNative = nativeReleaseRoot(input.nativeExecutable);
  const conflict = fromModule !== null && fromNative !== null &&
    !samePath(fromModule, fromNative);
  const root = conflict ? null : fromModule ?? fromNative;
  const layout: DiagnosticsProvenance['layout'] = conflict ? 'conflict' :
    root ? 'resolved' : 'unavailable';
  const budget = {
    remaining: limited(input.limitsForTest?.totalBytes, MAX_TOTAL),
    perFile: limited(input.limitsForTest?.fileBytes, MAX_FILE),
    manifest: limited(input.limitsForTest?.manifestBytes, MAX_MANIFEST),
    deadline: Date.now() + limited(input.limitsForTest?.durationMs, MAX_DURATION),
  };
  const manifestResult = root
    ? await inspectFile(root, 'manifest.json', 'manifest', budget, input.onChunkForTest)
    : unavailable('unbound');
  const expected = manifestResult.observation === 'observed'
    ? expectedDigests(manifestResult.bytes) : null;
  const manifest: ManifestProvenance = {
    observation: manifestResult.observation,
    observed_sha256: manifestResult.sha256,
    size_bytes: manifestResult.size,
    schema_status: manifestResult.observation !== 'observed' ? 'unknown' :
      expected === null ? 'invalid' : 'valid',
    expected_digest_sha256: null,
    digest_binding: 'unknown',
  };
  const components: ComponentProvenance[] = [];
  for (const id of COMPONENT_IDS) {
    let allowed = false;
    if (root) {
      if (id === 'node') {
        allowed = samePath(input.nodeExecutable, path.join(root, ...COMPONENT_PATHS[id].split('/')));
      } else if (id === 'native_exe' || id === 'native_dll') {
        allowed = !!input.nativeExecutable &&
          samePath(input.nativeExecutable, path.join(root, ...COMPONENT_PATHS.native_exe.split('/')));
      } else {
        allowed = fromModule !== null && samePath(fromModule, root) &&
          samePath(input.moduleFile, path.join(root, ...COMPONENT_PATHS.state.split('/')));
      }
    }
    const result = root && allowed
      ? await inspectFile(root, COMPONENT_PATHS[id], id, budget, input.onChunkForTest)
      : unavailable('unbound');
    const expectedHash = expected?.get(id) ?? null;
    const comparison: Comparison = !expectedHash ? 'unknown'
      : result.observation === 'observed' ? result.sha256 === expectedHash ? 'match' : 'mismatch'
      : result.observation === 'missing' ? 'mismatch' : 'unknown';
    components.push({
      component_id: id, observation: result.observation,
      observed_sha256: result.sha256, expected_sha256: expectedHash,
      comparison, size_bytes: result.size,
    });
  }
  const comparisons = components.map(item => item.comparison);
  return {
    schema: 1, scope: 'known_release_components', layout, manifest, components,
    component_comparison: comparisons.includes('mismatch') ? 'mismatch'
      : comparisons.every(value => value === 'match') ? 'all_match_unsigned' : 'unknown',
    signature_binding: 'unknown',
    source_binding: 'unknown',
  };
}

/** Diagnostic availability must not depend on provenance being observable. */
export function unavailableDiagnosticsProvenance(): DiagnosticsProvenance {
  return {
    schema: 1, scope: 'known_release_components', layout: 'unavailable',
    manifest: {
      observation: 'unbound', observed_sha256: null, size_bytes: null,
      schema_status: 'unknown', expected_digest_sha256: null, digest_binding: 'unknown',
    },
    components: COMPONENT_IDS.map(component_id => ({
      component_id, observation: 'unbound', observed_sha256: null,
      expected_sha256: null, comparison: 'unknown', size_bytes: null,
    })),
    component_comparison: 'unknown', signature_binding: 'unknown',
    source_binding: 'unknown',
  };
}
