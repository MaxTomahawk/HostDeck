import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FullTextAction, FullTextAuthorizer, FullTextBudgets, FullTextConfig,
  FullTextFormat, FullTextPreview, FullTextPrincipal,
} from './types.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const ALL_FORMATS: readonly FullTextFormat[] = ['.txt','.md','.csv','.json','.docx','.xlsx','.pdf'];

export function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function absolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) throw new Error('FULLTEXT_ABSOLUTE_' + label + '_REQUIRED');
  const resolved = path.resolve(value);
  if (process.platform === 'win32' && (resolved.startsWith('\\\\') || value.startsWith('\\\\?\\'))) {
    throw new Error('FULLTEXT_UNQUALIFIED_UNC_PATH');
  }
  if (resolved.length > 4096) throw new Error('FULLTEXT_PATH_LIMIT');
  if (resolved.split(path.sep).some((part, i) => i > 0 && part.includes(':'))) throw new Error('FULLTEXT_ADS_DENIED');
  return resolved;
}

function positiveLimit(raw: number | undefined, defaultValue: number, max: number): number {
  if (raw === undefined) return defaultValue;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > max) throw new Error('FULLTEXT_BUDGET_INVALID');
  return raw;
}

export function resolveBudgets(config: FullTextConfig): FullTextBudgets {
  const requested = config.budgets ?? {};
  const physical = Math.max(MiB, os.totalmem());
  const conservativeMemory = Math.min(256 * MiB, Math.max(64 * MiB, Math.floor(physical / 256)));
  const defaults: FullTextBudgets = {
    maxFileBytes: Math.min(4 * MiB, conservativeMemory / 16),
    // Initial budgets adapt to available RAM; a selected corpus is not
    // artificially restricted to the old 5k docs / 256 MiB defaults.
    maxTotalSourceBytes: Math.min(256 * GiB, Math.max(8 * GiB, Math.floor(physical * 2))),
    maxIndexBytes: Math.min(64 * GiB, Math.max(2 * GiB, Math.floor(physical / 4))),
    minFreeDiskBytes: 512 * MiB,
    maxDocuments: Math.min(500_000, Math.max(25_000, Math.floor(physical / (256 * 1024)))),
    maxDepth: 24,
    maxEntriesPerDirectory: 10_000,
    maxOperationsPerStep: 32,
    maxStepMilliseconds: 3_000,
    maxTextCharacters: 200_000,
    minFreeMemoryBytes: Math.min(512 * MiB, Math.floor(physical / 10)),
    maxQueryCandidates: 500,
    maxResults: 20,
  };
  const caps: FullTextBudgets = {
    maxFileBytes: 32 * MiB,
    maxTotalSourceBytes: 4 * 1024 * GiB,
    maxIndexBytes: 256 * GiB,
    minFreeDiskBytes: 64 * GiB,
    maxDocuments: 5_000_000,
    maxDepth: 64,
    maxEntriesPerDirectory: 100_000,
    maxOperationsPerStep: 256,
    maxStepMilliseconds: 20_000,
    maxTextCharacters: 2_000_000,
    minFreeMemoryBytes: 8 * GiB,
    maxQueryCandidates: 2_000,
    maxResults: 100,
  };
  const b = {} as FullTextBudgets;
  for (const key of Object.keys(defaults) as Array<keyof FullTextBudgets>) {
    b[key] = positiveLimit(requested[key], Math.floor(defaults[key]), caps[key]);
  }
  if (b.maxFileBytes > b.maxTotalSourceBytes || b.maxResults > b.maxQueryCandidates) throw new Error('FULLTEXT_BUDGET_CONFLICT');
  return b;
}

export function normalizeConfig(config: FullTextConfig): { roots: string[]; excludedRoots: string[]; fixedVolumeRoots: string[]; indexFile: string; formats: FullTextFormat[]; budgets: FullTextBudgets; includeHidden: boolean; digest: string } {
  if (!config || !Array.isArray(config.roots) || !Array.isArray(config.formats)) throw new Error('FULLTEXT_CONFIG_REQUIRED');
  if (config.roots.length > 128 || (config.excludedRoots??[]).length > 256 || (config.fixedVolumeRoots??[]).length > 8 || config.formats.length > ALL_FORMATS.length) throw new Error('FULLTEXT_CONFIG_LIMIT');
  const roots = config.roots.map(root => absolutePath(root, 'ROOT')).sort();
  const fixedVolumeRoots = (config.fixedVolumeRoots??[]).map(root=>absolutePath(root,'FIXED_VOLUME')).sort();
  const excludedRoots = (config.excludedRoots??[]).map(root=>absolutePath(root,'EXCLUSION')).sort();
  const key=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
  if (new Set(roots.map(key)).size !== roots.length ||
      new Set(fixedVolumeRoots.map(key)).size !== fixedVolumeRoots.length ||
      new Set(excludedRoots.map(key)).size !== excludedRoots.length)
    throw new Error('FULLTEXT_DUPLICATE_ROOT');
  for (const volume of fixedVolumeRoots) {
    if (process.platform!=='win32' || !/^[a-z]:\\$/i.test(volume) || !roots.some(root=>key(root)===key(volume)))
      throw new Error('FULLTEXT_FIXED_VOLUME_SELECTION_INVALID');
  }
  for (const root of roots) {
    if (key(root)===key(path.parse(root).root) && !fixedVolumeRoots.some(volume=>key(volume)===key(root)))
      throw new Error('FULLTEXT_VOLUME_ROOT_DENIED');
    if (roots.some(other => other !== root && within(other, root))) throw new Error('FULLTEXT_OVERLAPPING_ROOTS');
    if (excludedRoots.some(exclusion=>within(exclusion,root)))
      throw new Error('FULLTEXT_ROOT_EXCLUDED');
  }
  const indexFile = absolutePath(config.indexFile, 'INDEX');
  // Volume roots may contain an index, but ONLY when the whole writable index
  // directory is separately excluded by the approved selection.
  if (roots.some(root => within(root, indexFile)) &&
      !excludedRoots.some(exclusion=>within(exclusion,path.dirname(indexFile))))
    throw new Error('FULLTEXT_INDEX_INSIDE_CORPUS');
  const formats = [...new Set(config.formats)].sort();
  if (formats.some(format => !ALL_FORMATS.includes(format))) throw new Error('FULLTEXT_FORMAT_UNSUPPORTED');
  const budgets = resolveBudgets(config);
  const includeHidden = config.includeHidden === true;
  const canonical = { roots, indexFile, formats, budgets, includeHidden,excludedRoots,fixedVolumeRoots };
  const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { ...canonical, digest };
}

/** Immutable protected exclusions supplement owner-selected excludedRoots. */
export function isExcludedSource(c:ReturnType<typeof normalizeConfig>, candidate:string):boolean {
  if(c.excludedRoots.some(exclusion=>within(exclusion,candidate)))return true;
  for(const volume of c.fixedVolumeRoots) {
    if (!within(volume,candidate))continue;
    const relative=path.relative(volume,candidate);
    const parts=relative.split(path.sep).filter(Boolean).map(value=>value.toLowerCase());
    if (!parts.length) return false; // explicitly approved fixed volume root
    if (['$recycle.bin','system volume information','recovery','windows','program files',
       'program files (x86)','programdata','documents and settings'].includes(parts[0]))return true;
    // Built-in protection for private caches beneath user profiles.
    if(parts[0]==='users' && parts.length>=3 && parts[2]==='appdata')return true;
  }
  return false;
}

/**
 * Authorize fixed-volume traversal only after OS confirms a *fixed* volume.
 * No network/removable drive is silently converted to an index root.
 */
export async function qualifyFixedVolumes(c:ReturnType<typeof normalizeConfig>):Promise<void> {
  if(!c.fixedVolumeRoots.length)return;
  if(process.platform!=='win32')throw new Error('FULLTEXT_FIXED_VOLUME_UNQUALIFIED');
  const systemRoot=process.env.SystemRoot??process.env.WINDIR;
  if(!systemRoot||!path.win32.isAbsolute(systemRoot))throw new Error('FULLTEXT_FIXED_VOLUME_UNQUALIFIED');
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const run=promisify(execFile);
  const exe=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  for(const volume of c.fixedVolumeRoots){
    const drive=volume.slice(0,2); // path already validated as X:\\
    const script="[System.IO.DriveInfo]::new('"+drive+"').DriveType.ToString()";
    try{
      const {stdout,stderr}=await run(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
        {shell:false,windowsHide:true,timeout:4500,maxBuffer:1024,encoding:'utf8'});
      if(stderr.trim()||stdout.trim()!=='Fixed')throw new Error('UNQUALIFIED');
    }catch{throw new Error('FULLTEXT_FIXED_VOLUME_UNQUALIFIED');}
  }
}

export async function authorize(authorizer: FullTextAuthorizer, principal: FullTextPrincipal, action: FullTextAction, root: string, candidate: string): Promise<void> {
  if (!principal || !principal.ownerId || !principal.deviceId || !principal.executorId) throw new Error('FULLTEXT_IDENTITY_REQUIRED');
  if (await authorizer({ principal, action, root, path: candidate }) !== true) throw new Error('FULLTEXT_DENIED');
}

/** Reject junctions/reparse aliases and ADS on EVERY traversed component. */
export async function safeRealpath(input: string): Promise<string> {
  const absolute = absolutePath(input, 'PATH');
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    if (part.includes(':')) throw new Error('FULLTEXT_ADS_DENIED');
    cursor = path.join(cursor, part);
    const st = await fs.lstat(cursor);
    if (st.isSymbolicLink()) throw new Error('FULLTEXT_REPARSE_DENIED');
  }
  const real = await fs.realpath(absolute);
  const norm = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
  if (norm(path.resolve(real)) !== norm(absolute)) throw new Error('FULLTEXT_REPARSE_DENIED');
  return real;
}

export async function previewFullText(config: FullTextConfig, principal: FullTextPrincipal, authorizer: FullTextAuthorizer): Promise<FullTextPreview> {
  const c = normalizeConfig(config);
  await authorize(authorizer, principal, 'preview', c.indexFile, c.indexFile);
  for (const root of c.roots) await authorize(authorizer, principal, 'preview', root, root);
  const issues: string[] = [];
  if (!c.roots.length) issues.push('NO_SELECTED_ROOTS');
  if (!c.formats.length) issues.push('NO_SELECTED_FORMATS');
  if(c.fixedVolumeRoots.length) issues.push('BROAD_FIXED_VOLUMES_REQUIRE_EXPLICIT_EXCLUSIONS_AND_OWNER_APPROVAL');
  issues.push('NO_AUTOMATIC_WATCHER_OR_SEMANTIC_MODEL');
  issues.push('PDF_WITH_ARABIC_OR_SCANNED_CONTENT_MAY_BE_UNQUALIFIED');
  issues.push('SOURCE_ACL_AND_FRESHNESS_RECHECK_REQUIRED');
  return {
    digest: c.digest, roots: c.roots, formats: c.formats,
    excludedRoots:c.excludedRoots,fixedVolumeRoots:c.fixedVolumeRoots,
    budgets: c.budgets, indexFile: c.indexFile, activated: false,
    requiresSelectedRoots: c.roots.length === 0, issues,
    machine: {
      logicalCpus: os.cpus().length,
      totalMemoryMiB: Math.floor(os.totalmem() / MiB),
      freeMemoryMiB: Math.floor(os.freemem() / MiB),
      gpuUsed: false,
    },
  };
}
