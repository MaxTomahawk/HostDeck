/**
 * Existing PR30 lexical and reparse preflight for explicitly configured,
 * owner-scoped READ/SEARCH roots (never caller-selected or writable).
 *
 * The selection parameter must be supplied by a separately qualified,
 * protected, owner-bound local reader, NEVER from MCP arguments, a search hit,
 * an environment variable, or broadUserAuthority alone.
 *
 * This is a lexical + reparse preflight, NOT race-safe authorization to read an
 * already-opened file handle. Integrators MUST bind the actual opened object
 * to the admitted root immediately before disclosing content/metadata.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { RuntimeError } from './runtime-error.js';
import { safeRealpath, within, isExcludedSource } from './fulltext/policy.js';

export interface ReadRootOwner {
  readonly ownerId: string;
  readonly deviceId: string;
  readonly executorId: string;
}

export interface ProtectedReadRootSelection {
  readonly owner: ReadRootOwner;
  /** Verified by the protected local source; not a self-declared MCP revision. */
  readonly revision: string;
  /** Explicitly approved directory roots (fixed-volume root requires separate qualification). */
  readonly roots: readonly string[];
  /** Explicit owner exclusions, in addition to protected runtime paths. */
  readonly excludedRoots: readonly string[];
  /** Only actual fixed local volumes verified by native DriveInfo may appear here. */
  readonly fixedVolumeRoots?: readonly string[];
  /** Bound to approved protected selection content, never an MCP claim. */
  readonly digest?: string;
}

export type ReadOnlyOperation = 'name_search' | 'content_search' |
  'list_directory' | 'read_file' | 'file_info';

export interface ReadRootCandidate {
  readonly root: string;
  readonly absolute: string;
  readonly displayPath: string;
  readonly external: boolean;
}

export interface ReadRootResolveRequest {
  readonly workspace: string;
  readonly path: string;
  readonly owner: ReadRootOwner;
  readonly selection: ProtectedReadRootSelection | null;
  /**
   * Trusted protected paths (state, grant store, enrollment, executable/config,
   * protected credential and private caches), supplied by the installed host.
   * This check is mandatory for external root reads, even when a root was
   * approved. Protected ancestors must also be accounted for in list/search.
   */
  readonly protectedPaths: readonly string[];
  readonly operation: ReadOnlyOperation;
}

function denied(): never { throw new RuntimeError('READ_ROOT_DENIED'); }
const safeRoot = async (input: string): Promise<string> => {
  if (typeof input !== 'string' || !path.isAbsolute(input) ||
      input.length > 4096 || /[\u0000-\u001f]/.test(input)) denied();
  try { return await safeRealpath(input); }
  catch { return denied(); }
};
/**
 * Exclusions remain binding even when their terminal object is not present.
 * Canonicalize the nearest existing ancestor, append the absent suffix, and
 * refuse unsafe/reparse ancestors. A missing excluded directory is not a
 * reason to reject unrelated reads or to drop that exclusion.
 */
async function protectedExclusion(input: string): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input) ||
      input.length > 4096 || /[\u0000-\u001f]/.test(input)) denied();
  const missing: string[] = [];
  let cursor = path.resolve(input);
  while (true) {
    try {
      await fs.lstat(cursor);
      const parent = await safeRoot(cursor);
      return path.join(parent, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') denied();
      const previous = path.dirname(cursor);
      if (previous === cursor) return path.resolve(input);
      missing.push(path.basename(cursor));
      cursor = previous;
    }
  }
}

const equals = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameOwner = (a: ReadRootOwner, b: ReadRootOwner): boolean =>
  !!a?.ownerId && !!a?.deviceId && !!a?.executorId &&
  a.ownerId === b?.ownerId && a.deviceId === b?.deviceId &&
  a.executorId === b?.executorId;

/**
 * Validate one selected root and one target. The read adapter must rerun this
 * for each disclosed directory entry, search match and readback, not only for
 * the original search root. No selected root is inferred from a grant scope.
 */
export async function resolveSelectedReadPath(
  request: ReadRootResolveRequest,
): Promise<ReadRootCandidate> {
  const { workspace, owner, selection, protectedPaths } = request;
  if (!owner?.ownerId || !owner.deviceId || !owner.executorId ||
      typeof request.path !== 'string' || !request.path.trim() ||
      request.path.length > 4096) denied();
  if (!['name_search', 'content_search', 'list_directory',
    'read_file', 'file_info'].includes(request.operation)) denied();

  const base = await safeRoot(workspace);
  // A relative path always means "relative to workspace", never a route out
  // to an additional root through "..". External paths must be explicit.
  const absolute = path.resolve(base, request.path);
  if (!path.isAbsolute(request.path) && !within(base, absolute)) denied();

  // Preserve the old contract unchanged when no selected external roots exist.
  if (within(base, absolute)) {
    const canonical = await safeRoot(absolute);
    if (!within(base, canonical)) denied();
    return { root: base, absolute: canonical,
      displayPath: path.relative(base, canonical) || '.', external: false };
  }

  if (!selection || !sameOwner(selection.owner, owner) ||
      !selection.revision || !Array.isArray(selection.roots) ||
      !Array.isArray(selection.excludedRoots) ||
      selection.roots.length > 128 || selection.excludedRoots.length > 256 ||
      !Array.isArray(protectedPaths) || protectedPaths.length === 0) denied();

  // Explicit fixed local volume roots are supported only when the separately
  // protected selection source has performed genuine DriveInfo qualification.
  // The caller cannot select roots from MCP arguments or broadUserAuthority.
  const candidateRoots: string[] = [];
  for (const approved of selection.roots) {
    if (typeof approved !== 'string' || !path.isAbsolute(approved)) denied();
    const volume = equals(path.resolve(approved), path.parse(approved).root);
    if (volume && (
      process.platform !== 'win32' ||
      !/^[A-Za-z]:\\$/.test(approved) ||
      !selection.fixedVolumeRoots?.some(qualified => equals(approved, qualified))
    )) denied();
    // Reject aliases and reparse points for the entire trusted root chain.
    candidateRoots.push(await safeRoot(approved));
  }
  if (new Set(candidateRoots.map(value =>
      process.platform === 'win32' ? value.toLowerCase() : value)).size !== candidateRoots.length) denied();

  const root = candidateRoots.find(value => within(value, absolute));
  if (!root) denied();
  // Resolve before reporting any path, count, filename, metadata or snippet.
  const canonical = await safeRoot(absolute);
  if (!within(root, canonical)) denied();

  const fixedVolumeRoots = selection.fixedVolumeRoots ?? [];
  if (fixedVolumeRoots.some(volume => within(volume, canonical))) {
    if (isExcludedSource({fixedVolumeRoots: [...fixedVolumeRoots],
        excludedRoots: [...selection.excludedRoots]} as
      ReturnType<typeof import('./fulltext/policy.js').normalizeConfig>, canonical)) denied();
    // Built-in credential/profile exclusions for owner-selected broad volumes.
    const parts = path.relative(root, canonical).split(path.sep)
      .map(part => part.toLowerCase());
    if (parts.some(part => ['.ssh','.gnupg','.aws','.azure','.kube',
       '.config','ntuser.dat','ntuser.dat.log1','ntuser.dat.log2',
       'credentials','vault'].includes(part))) denied();
  }
  for (const raw of [...selection.excludedRoots, ...protectedPaths]) {
    const excluded = await protectedExclusion(raw);
    if (within(excluded, canonical)) denied();
  }
  // A caller cannot get an unsafe "../" path to retry under a write API.
  // Existing workspace matches remain relative; external reads explicitly
  // identify their already authorized absolute source.
  return { root, absolute: canonical, displayPath: canonical, external: true };
}
