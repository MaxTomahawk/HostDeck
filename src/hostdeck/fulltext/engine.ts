import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { constants as fsConstants } from 'node:fs';
import { extractDocument } from './extract.js';
import { FullTextWriterLock } from './writer-lock.js';
import { hanBigrams, makeSnippet, parseFullTextQuery, satisfiesHanSubstrings } from './query.js';
import { authorize, normalizeConfig, previewFullText, safeRealpath, within } from './policy.js';
import type {
  FullTextAuthorizer, FullTextConfig, FullTextPrincipal, FullTextPreview,
  FullTextScanReceipt, FullTextSearchPage, FullTextFormat,
} from './types.js';

type Scope = { ownerId: string; deviceId: string; executorId: string; sessionId?: number };
type FsIdentity = {dev: bigint; ino: bigint};
function sameIdentity(a: FsIdentity, b: FsIdentity): boolean {return a.dev===b.dev && a.ino===b.ino;}
async function identity(file: string): Promise<FsIdentity> {
  const stat = await fs.lstat(file,{bigint:true});
  if (stat.isSymbolicLink()) throw new Error('FULLTEXT_REPARSE_DENIED');
  if (stat.ino === 0n) throw new Error('FULLTEXT_FILE_IDENTITY_UNAVAILABLE');
  return {dev:stat.dev,ino:stat.ino};
}
async function boundedPinnedHash(file:string,expected:FsIdentity,maxBytes:number): Promise<string|undefined> {
  const handle=await fs.open(file,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0));
  try {
    const st=await handle.stat({bigint:true});
    if (!sameIdentity(st,expected)) throw new Error('FULLTEXT_SOURCE_IDENTITY_CHANGED');
    if (st.size>BigInt(maxBytes)) return undefined;
    const bytes=await handle.readFile();
    if (bytes.length>maxBytes) throw new Error('FULLTEXT_SOURCE_SIZE_CHANGED');
    return createHash('sha256').update(bytes).digest('hex');
  } finally {await handle.close();}
}
type Config = ReturnType<typeof normalizeConfig>;
type Task = { path: string; root: string; depth: number; kind: 'dir' | 'file'; run_id: string };
type Doc = {
  id: number; path: string; root: string; format: FullTextFormat; state: string;
  sha256: string; bytes: number; indexed_at: string; seen_scan: string;
};
type Run = {
  id: string; state: string; incomplete: number; processed: number;
  read_bytes: number; created_at: string; updated_at: string;
};
const formatSet = new Set<FullTextFormat>(['.txt','.md','.csv','.json','.docx','.xlsx','.pdf']);

function hashScope(value: Scope): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function now(): string { return new Date().toISOString(); }
function validPrincipal(c: FullTextPrincipal): Scope {
  if (!c?.ownerId || !c.deviceId || !c.executorId) throw new Error('FULLTEXT_IDENTITY_REQUIRED');
  return { ownerId: c.ownerId, deviceId: c.deviceId, executorId: c.executorId,
    ...(c.sessionId !== undefined ? { sessionId: c.sessionId } : {}) };
}
function stableErr(error: unknown): string {
  const known = error instanceof Error ? error.message : '';
  return /^FULLTEXT_[A-Z_]+$/.test(known) ? known : 'FULLTEXT_IO_ERROR';
}

/**
 * Optional, explicitly confirmed index. No watcher/timer, network, semantic
 * model, GPU or drive enumeration. Every step is a bounded foreground call.
 * This is not wired to the public MCP contract until a separate scoped facade
 * integration supplies current grants, protected index storage and UI consent.
 */
export class FullTextEngine {
  private stepping = false;
  private constructor(
    private readonly db: DatabaseSync, private readonly config: Config,
    private readonly principal: Scope, private readonly check: FullTextAuthorizer,
    private readonly writer: FullTextWriterLock,
    private readonly roots: ReadonlyMap<string,FsIdentity>,
  ) {}

  static preview(config: FullTextConfig, principal: FullTextPrincipal, check: FullTextAuthorizer): Promise<FullTextPreview> {
    return previewFullText(config, principal, check);
  }

  static async openConfirmed(
    supplied: FullTextConfig,
    principal: FullTextPrincipal,
    check: FullTextAuthorizer,
    confirmedDigest: string,
  ): Promise<FullTextEngine> {
    const c = normalizeConfig(supplied);
    const owner = validPrincipal(principal);
    if (!c.roots.length || !c.formats.length || confirmedDigest !== c.digest)
      throw new Error('FULLTEXT_SELECTION_NOT_CONFIRMED');
    const rootIdentities=new Map<string,FsIdentity>();
    for (const root of c.roots) {
      await authorize(check, owner, 'configure', root, root);
      const actual = await safeRealpath(root);
      if (actual !== root && actual.toLowerCase() !== root.toLowerCase()) throw new Error('FULLTEXT_ROOT_MOVED');
      if (!(await fs.lstat(actual)).isDirectory()) throw new Error('FULLTEXT_ROOT_NOT_DIRECTORY');
      rootIdentities.set(root,await identity(root));
    }
    // The state directory must already exist and be protected by the caller's
    // installer/profile ACL. Never invent a location or mkdir in user drives.
    const storageParent = await safeRealpath(path.dirname(c.indexFile));
    if (storageParent !== path.dirname(c.indexFile) &&
        storageParent.toLowerCase() !== path.dirname(c.indexFile).toLowerCase())
      throw new Error('FULLTEXT_INDEX_STORAGE_REPARSE');
    await authorize(check, owner, 'storage', storageParent, c.indexFile);
    try { await safeRealpath(c.indexFile); } catch (error) { if (!isMissing(error)) throw error; }
    // Acquire the OS-backed companion lock *before* even opening main SQLite.
    // A second live writer must not alter runs, queue, schema or metadata.
    const companion = c.indexFile + '.writerlock.sqlite';
    await authorize(check, owner, 'storage', storageParent, companion);
    try { await safeRealpath(companion); } catch (error) { if (!isMissing(error)) throw error; }
    const writer=FullTextWriterLock.acquire(c.indexFile);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(c.indexFile);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS docs (
          id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, root TEXT NOT NULL,
          format TEXT NOT NULL, state TEXT NOT NULL, sha256 TEXT NOT NULL,
          bytes INTEGER NOT NULL, indexed_at TEXT NOT NULL, seen_scan TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
          body, grams, tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TABLE IF NOT EXISTS queue (
          path TEXT PRIMARY KEY, root TEXT NOT NULL, depth INTEGER NOT NULL,
          kind TEXT NOT NULL, run_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, state TEXT NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0,
          processed INTEGER NOT NULL DEFAULT 0, read_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      const scopeHash = hashScope(owner);
      for (const [key, value] of [['owner_scope', scopeHash], ['config_digest', c.digest]]) {
        const existing = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
        if (existing && existing.value !== value) throw new Error('FULLTEXT_INDEX_SCOPE_MISMATCH');
        if (!existing) db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(key, value);
      }
      // A prior process might have stopped midstep. Do not claim completion
      // or continue an interrupted scan without a new explicit resume.
      db.prepare("UPDATE runs SET state='interrupted',updated_at=? WHERE state IN ('running','resource_paused')").run(now());
      return new FullTextEngine(db, c, owner, check, writer,rootIdentities);
    } catch (error) {
      try { db?.close(); }
      finally { writer.release(); }
      throw error;
    }
  }

  private guard(c: FullTextPrincipal): void {
    if (hashScope(validPrincipal(c)) !== hashScope(this.principal)) throw new Error('FULLTEXT_DENIED');
  }
  private async auth(c: FullTextPrincipal, action: Parameters<FullTextAuthorizer>[0]['action'], root: string, file: string): Promise<void> {
    this.guard(c);
    await authorize(this.check, this.principal, action, root, file);
  }
  private async verifyRoot(root:string):Promise<void>{
    await safeRealpath(root); // all components must still be non-reparse
    const pinned=this.roots.get(root);
    if (!pinned || !sameIdentity(await identity(root),pinned))
      throw new Error('FULLTEXT_ROOT_IDENTITY_CHANGED');
  }
  private async rootsAllowed(c: FullTextPrincipal, action: Parameters<FullTextAuthorizer>[0]['action']): Promise<void> {
    this.guard(c);
    for (const root of this.config.roots) {
      await this.auth(c, action, root, root);
      await this.verifyRoot(root);
    }
  }

  private active(): Run | undefined {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 1').get() as Run | undefined;
  }
  private runById(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Run | undefined;
    if (!row) throw new Error('FULLTEXT_RUN_NOT_OWNED');
    return row;
  }
  private state(id: string, value: string): void {
    this.db.prepare('UPDATE runs SET state=?,updated_at=? WHERE id=?').run(value,now(),id);
  }

  /** Explicit new scan. Earlier results stay, marked last_scan_only, until complete. */
  async start(c: FullTextPrincipal): Promise<{runId: string; state: 'running'}> {
    await this.rootsAllowed(c, 'scan');
    const id = randomUUID(), time = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.active();
      if (previous && !['complete','cancelled'].includes(previous.state)) throw new Error('FULLTEXT_SCAN_ALREADY_ACTIVE');
      this.db.prepare('DELETE FROM queue').run();
      this.db.prepare('INSERT INTO runs(id,state,created_at,updated_at) VALUES(?,?,?,?)').run(id,'running',time,time);
      for (const root of this.config.roots)
        this.db.prepare('INSERT INTO queue(path,root,depth,kind,run_id) VALUES(?,?,?,?,?)').run(root,root,0,'dir',id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { runId:id, state:'running' };
  }

  async pause(c: FullTextPrincipal, id: string): Promise<void> {
    await this.rootsAllowed(c,'control');
    if (this.runById(id).state !== 'running') throw new Error('FULLTEXT_NOT_RUNNING');
    this.state(id,'paused');
  }
  async resume(c: FullTextPrincipal, id: string): Promise<void> {
    await this.rootsAllowed(c,'control');
    if (!['paused','resource_paused','interrupted'].includes(this.runById(id).state))
      throw new Error('FULLTEXT_NOT_RESUMABLE');
    this.state(id,'running');
  }
  async cancel(c: FullTextPrincipal, id: string): Promise<void> {
    await this.rootsAllowed(c,'control');
    if (!['running','paused','interrupted','resource_paused'].includes(this.runById(id).state))
      throw new Error('FULLTEXT_NOT_CANCELLABLE');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE runs SET state='cancelled',updated_at=? WHERE id=?").run(now(),id);
      this.db.prepare('DELETE FROM queue WHERE run_id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // Earlier committed documents remain tagged with their last scan; no
    // implicit re-run or rollback is implied by cancellation.
  }

  private markPartial(runId: string): void {
    this.db.prepare('UPDATE runs SET incomplete=1 WHERE id=?').run(runId);
  }

  private async resourceSample(): Promise<{indexBytes:number;freeDiskBytes:number|null;freeMemoryBytes:number}> {
    let indexBytes = 0;
    for (const name of [this.config.indexFile, this.config.indexFile+'-wal', this.config.indexFile+'-shm']) {
      try { indexBytes += (await fs.stat(name)).size; }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    let freeDiskBytes: number|null = null;
    try {
      const stat = await fs.statfs(path.dirname(this.config.indexFile));
      const sampled = Number(stat.bavail) * Number(stat.bsize);
      freeDiskBytes = Number.isFinite(sampled) && sampled >= 0 ? sampled : null;
    } catch { /* Disk pressure remains explicitly unverified; never invent free bytes. */ }
    return {indexBytes,freeDiskBytes,freeMemoryBytes:os.freemem()};
  }

  private pressureReason(s: Awaited<ReturnType<FullTextEngine['resourceSample']>>): string|undefined {
    if (s.freeMemoryBytes < this.config.budgets.minFreeMemoryBytes) return 'LOW_FREE_MEMORY';
    if (s.indexBytes >= this.config.budgets.maxIndexBytes) return 'INDEX_QUOTA';
    if (s.freeDiskBytes === null) return 'DISK_PRESSURE_UNAVAILABLE';
    if (s.freeDiskBytes < this.config.budgets.minFreeDiskBytes) return 'LOW_FREE_DISK';
    return undefined;
  }

  private async scanDirectory(task: Task, c: FullTextPrincipal, deadline: number): Promise<boolean> {
    await this.auth(c,'scan',task.root,task.path);
    const dir = await safeRealpath(task.path);
    if (!within(task.root,dir)) throw new Error('FULLTEXT_OUTSIDE_ROOT');
    let count = 0, incomplete = false;
    const handle = await fs.opendir(dir);
    try {
      for await (const entry of handle) {
        if (Date.now() >= deadline) { incomplete = true; break; }
        count++;
        if (count > this.config.budgets.maxEntriesPerDirectory) { incomplete = true; break; }
        if (!this.config.includeHidden && entry.name.startsWith('.')) continue;
        if (entry.name.includes(':') || entry.isSymbolicLink()) { incomplete = true; continue; }
        const child = path.join(dir,entry.name);
        if (!within(task.root,child)) { incomplete = true; continue; }
        const kind = entry.isDirectory()?'dir':entry.isFile()?'file':undefined;
        if (!kind) { incomplete = true; continue; }
        if (kind === 'dir' && task.depth >= this.config.budgets.maxDepth) { incomplete = true; continue; }
        // No unauthorized filenames or counts enter the durable queue.
        try { await this.auth(c,'scan',task.root,child); }
        catch { incomplete = true; continue; }
        // Authorization may yield control; verify directory identity again
        // before committing any discovered child name to the durable queue.
        await this.verifyRoot(task.root);
        await safeRealpath(dir);
        if (this.runById(task.run_id).state !== 'running') throw new Error('FULLTEXT_STEP_STOPPED');
        this.db.prepare('INSERT OR IGNORE INTO queue(path,root,depth,kind,run_id) VALUES(?,?,?,?,?)')
          .run(child,task.root,task.depth+1,kind,task.run_id);
      }
    } finally { await handle.close().catch(() => undefined); }
    if (incomplete) this.markPartial(task.run_id);
    return incomplete;
  }

  private async scanFile(task: Task, c: FullTextPrincipal): Promise<'indexed'|'unchanged'|'skipped'|'changed'|'renamed'> {
    await this.auth(c,'index',task.root,task.path);
    let file: string;
    try { file = await safeRealpath(task.path); }
    catch (error) { if (isMissing(error)) return 'skipped'; throw error; }
    if (!within(task.root,file)) throw new Error('FULLTEXT_OUTSIDE_ROOT');
    const format = path.extname(file).toLowerCase() as FullTextFormat;
    if (!formatSet.has(format) || !this.config.formats.includes(format)) return 'skipped';
    await this.verifyRoot(task.root);
    const sourceIdentity=await identity(file);
    const run = this.runById(task.run_id);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) return 'skipped';
    if (run.read_bytes + stat.size > this.config.budgets.maxTotalSourceBytes)
      throw new Error('FULLTEXT_SOURCE_BUDGET_EXCEEDED');
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as {n:number}).n;
    const previous = this.db.prepare('SELECT * FROM docs WHERE path=?').get(file) as Doc|undefined;
    if (!previous && count >= this.config.budgets.maxDocuments)
      throw new Error('FULLTEXT_DOCUMENT_BUDGET_EXCEEDED');
    // Pin an authorized file identity/hash before the parser's path-based
    // extraction. Structured Office/PDF parsers currently reopen by path:
    // reject *any* different source/hash before SQLite commit.
    const trustedHash=await boundedPinnedHash(file,sourceIdentity,this.config.budgets.maxFileBytes);
    const document = await extractDocument(file,task.root,this.config.budgets);
    // The authorizer can be asynchronous and a root/file can change while
    // extracting: re-check BOTH the pinned root and the final file identity.
    await this.auth(c,'index',task.root,file);
    await this.verifyRoot(task.root);
    await safeRealpath(file);
    if (!sameIdentity(sourceIdentity,await identity(file)))
      throw new Error('FULLTEXT_SOURCE_IDENTITY_CHANGED');
    const postHash=await boundedPinnedHash(file,sourceIdentity,this.config.budgets.maxFileBytes);
    if (trustedHash!==postHash || (document.sha256!=='' && document.sha256!==trustedHash))
      throw new Error('FULLTEXT_SOURCE_CHANGED');
    if (this.runById(task.run_id).state !== 'running') throw new Error('FULLTEXT_STEP_STOPPED');
    if (!document.sha256) this.markPartial(task.run_id);
    const old = previous?.sha256 === document.sha256 && previous?.state === document.status;
    const stamp = now();
    let movedId: number|undefined;
    if (!previous && document.status === 'indexed') {
      const matches = this.db.prepare(
        "SELECT * FROM docs WHERE root=? AND sha256=? AND format=? AND state='indexed' AND seen_scan<>? LIMIT 2"
      ).all(task.root,document.sha256,format,task.run_id) as Doc[];
      if (matches.length === 1) {
        let originalMissing = false;
        try { await fs.lstat(matches[0].path); } catch (error) { originalMissing = isMissing(error); }
        if (originalMissing) {
          try { await this.auth(c,'metadata',task.root,matches[0].path); movedId = matches[0].id; }
          catch { /* Can't disclose a rename from inaccessible old metadata. */ }
        }
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (movedId !== undefined)
        this.db.prepare('UPDATE docs SET path=?,state=?,sha256=?,bytes=?,indexed_at=?,seen_scan=? WHERE id=?')
          .run(file,document.status,document.sha256,document.bytes,stamp,task.run_id,movedId);
      else if (previous)
        this.db.prepare('UPDATE docs SET state=?,sha256=?,bytes=?,indexed_at=?,seen_scan=? WHERE id=?')
          .run(document.status,document.sha256,document.bytes,stamp,task.run_id,previous.id);
      else
        this.db.prepare('INSERT INTO docs(path,root,format,state,sha256,bytes,indexed_at,seen_scan) VALUES(?,?,?,?,?,?,?,?)')
          .run(file,task.root,format,document.status,document.sha256,document.bytes,stamp,task.run_id);
      const id = movedId ?? previous?.id ??
        Number((this.db.prepare('SELECT id FROM docs WHERE path=?').get(file) as {id:number}).id);
      // Remove indexed text when source changes, becomes unqualified or denied.
      if (!old || movedId !== undefined) {
        this.db.prepare('DELETE FROM docs_fts WHERE rowid=?').run(id);
        if (document.status === 'indexed' && document.text !== undefined)
          this.db.prepare('INSERT INTO docs_fts(rowid,body,grams) VALUES(?,?,?)').run(id,document.text,hanBigrams(document.text));
      }
      this.db.prepare('UPDATE runs SET processed=processed+1,read_bytes=read_bytes+?,updated_at=? WHERE id=?')
        .run(document.bytes,stamp,task.run_id);
      // Structured document text is a bounded extract, not complete Office
      // presentation/graphics or guaranteed OCR of every PDF page. Keep the
      // scan's recall claim partial even when indexed text is searchable.
      if (document.status !== 'indexed' || ['.docx','.xlsx','.pdf'].includes(format))
        this.markPartial(task.run_id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return document.status !== 'indexed' ? 'skipped' : movedId !== undefined ? 'renamed' : old ? 'unchanged' : previous ? 'changed' : 'indexed';
  }

  private async finish(c: FullTextPrincipal, runId: string): Promise<number> {
    const run = this.runById(runId);
    let removed = 0;
    if (run.incomplete === 0) {
      const missing = this.db.prepare('SELECT * FROM docs WHERE seen_scan<>?').all(runId) as Doc[];
      for (const old of missing) {
        // Root may be revoked midscan. No deletions/counts are disclosed unless
        // the current authority still admits this exact document metadata.
        try { await this.auth(c,'metadata',old.root,old.path); }
        catch { this.markPartial(runId); return removed; }
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('DELETE FROM docs_fts WHERE rowid=?').run(old.id);
          this.db.prepare('DELETE FROM docs WHERE id=?').run(old.id);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        removed++;
      }
    }
    this.state(runId,'complete');
    return removed;
  }

  async step(c: FullTextPrincipal, runId: string, requestedOperations?: number): Promise<FullTextScanReceipt> {
    if (this.stepping) throw new Error('FULLTEXT_SCAN_BUSY');
    this.stepping=true;
    try {
    await this.rootsAllowed(c,'scan');
    const row = this.runById(runId);
    if (row.state !== 'running') throw new Error('FULLTEXT_NOT_RUNNING');
    const limits = this.config.budgets;
    const maxOps = requestedOperations === undefined ? limits.maxOperationsPerStep
      : Math.min(limits.maxOperationsPerStep,Math.floor(requestedOperations));
    if (!Number.isSafeInteger(maxOps) || maxOps < 1) throw new Error('FULLTEXT_BUDGET_INVALID');
    const initialPressure=this.pressureReason(await this.resourceSample());
    if (initialPressure) {
      this.state(runId,'resource_paused');
      return {state:'resource_paused',runId,processedThisStep:0,indexedThisStep:0,changedThisStep:0,
        renamedThisStep:0,skippedThisStep:0,removedAtCompletion:0,coverage:'partial',reason:initialPressure};
    }
    const deadline = Date.now() + limits.maxStepMilliseconds;
    let processed = 0, indexed = 0, changed = 0, renamed = 0, skipped = 0, removed = 0;
    let reason: string|undefined;
    while (processed < maxOps && Date.now() < deadline) {
      if (this.runById(runId).state !== 'running') { reason = 'FULLTEXT_STEP_STOPPED'; break; }
      const pressure=this.pressureReason(await this.resourceSample());
      if (pressure) {this.state(runId,'resource_paused');reason=pressure;break;}
      const task = this.db.prepare('SELECT * FROM queue WHERE run_id=? ORDER BY path LIMIT 1').get(runId) as Task|undefined;
      if (!task) break;
      try {
        if (task.kind === 'dir') {
          await this.scanDirectory(task,c,deadline);
        } else {
          const action = await this.scanFile(task,c);
          if (action === 'indexed') indexed++;
          else if (action === 'changed') changed++;
          else if (action === 'renamed') renamed++;
          else if (action === 'skipped') skipped++;
        }
      } catch (error) {
        // ACL changes, source conflicts and source budgets are not silently
        // converted into successful scan coverage or deleted from the queue.
        reason = stableErr(error);
        if (this.runById(runId).state === 'running') {
          this.markPartial(runId);
          this.state(runId,'paused');
        }
        break;
      }
      this.db.prepare('DELETE FROM queue WHERE path=? AND run_id=?').run(task.path,runId);
      processed++;
    }
    const remaining = this.db.prepare('SELECT path FROM queue WHERE run_id=? LIMIT 1').get(runId);
    if (!remaining && !reason && this.runById(runId).state === 'running') removed = await this.finish(c,runId);
    const next = this.runById(runId);
    return {
      runId, state: next.state as FullTextScanReceipt['state'], processedThisStep:processed,
      indexedThisStep:indexed, changedThisStep:changed, renamedThisStep:renamed,
      skippedThisStep:skipped, removedAtCompletion:removed,
      coverage: next.state === 'complete' && next.incomplete === 0 ? 'bounded_complete' : 'partial',
      ...(reason?{reason}:{}),
    };
    } finally { this.stepping=false; }
  }

  /** Per-document authorization before metadata, snippets and any visible count. */
  async search(c: FullTextPrincipal, query: string, limit = 10): Promise<FullTextSearchPage> {
    await this.rootsAllowed(c,'search');
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.budgets.maxResults)
      throw new Error('FULLTEXT_QUERY_LIMIT');
    const parsed = parseFullTextQuery(query);
    const candidates = this.db.prepare(`
      SELECT d.id,d.path,d.root,d.format,d.sha256,d.bytes,d.indexed_at,bm25(docs_fts,1.0,0.6) score
      FROM docs_fts JOIN docs d ON docs_fts.rowid=d.id
      WHERE docs_fts MATCH ? AND d.state='indexed'
      ORDER BY score ASC,d.path ASC LIMIT ?
    `).all(parsed.ftsMatch,this.config.budgets.maxQueryCandidates) as
      Array<{id:number;path:string;root:string;format:FullTextFormat;sha256:string;bytes:number;indexed_at:string;score:number}>;
    const results: FullTextSearchPage['results'] = [];
    let authorizationGaps = false;
    for (const row of candidates) {
      if (results.length >= limit) break;
      try {
        await this.auth(c,'metadata',row.root,row.path);
        await this.auth(c,'snippet',row.root,row.path);
        const canonical = await safeRealpath(row.path);
        if (!within(row.root,canonical)) throw new Error('FULLTEXT_OUTSIDE_ROOT');
      } catch { authorizationGaps=true; continue; }
      const body = this.db.prepare('SELECT body FROM docs_fts WHERE rowid=?').get(row.id) as {body:string}|undefined;
      if (!body || !satisfiesHanSubstrings(body.body,parsed.hanRuns)) continue;
      results.push({
        path:row.path, format:row.format, score:row.score, snippet:makeSnippet(body.body,query),
        sha256:row.sha256, bytes:row.bytes, indexedAt:row.indexed_at,
        freshness:'last_scan_only',
      });
    }
    const current = this.active();
    return {
      results, truncated: authorizationGaps || candidates.length >= this.config.budgets.maxQueryCandidates || results.length >= limit,
      coverage: current?.state === 'complete' && current.incomplete===0 && !authorizationGaps
        ? 'complete_bounded_scan' : 'partial_or_unverified',
      actualFreshness:'not_monitored',
      querySemantics:parsed.normalization,
    };
  }

  async status(c: FullTextPrincipal): Promise<{
    state: string; coverage: 'partial_or_unverified'|'complete_bounded_scan';
    visibleDocuments: number; visibleCountTruncated: boolean;
    actualFreshness: 'not_monitored'; configuredRoots: number;
    visibleFormatCoverage: Array<{format:FullTextFormat;indexed:number;unqualified:number;reasons:Record<string,number>}>;
    resource: {indexBytes:number;freeDiskMiB:number|null;freeMemoryMiB:number;
      processRssMiB:number;gpuUsed:false;cpuPressure:'not_measured'};
  }> {
    await this.rootsAllowed(c,'status');
    const run = this.active();
    const rows = this.db.prepare('SELECT path,root,state FROM docs ORDER BY path LIMIT ?')
      .all(this.config.budgets.maxQueryCandidates + 1) as Array<{path:string;root:string;state:string}>;
    let visible = 0, hiddenByAcl = false;
    const coverage=new Map<FullTextFormat,{format:FullTextFormat;indexed:number;unqualified:number;reasons:Record<string,number>}>(
      this.config.formats.map(format=>[format,{format,indexed:0,unqualified:0,reasons:{}}])
    );
    for (const row of rows.slice(0,this.config.budgets.maxQueryCandidates)) {
      try {
        await this.auth(c,'metadata',row.root,row.path);
        const format=path.extname(row.path).toLowerCase() as FullTextFormat;
        const entry=coverage.get(format);
        if (row.state==='indexed') {
          visible++;
          if(entry) {
            entry.indexed++;
            if (['.docx','.xlsx','.pdf'].includes(format))
              entry.reasons['structured_text_layer_only']=(entry.reasons['structured_text_layer_only']??0)+1;
          }
        } else if (entry) {
          entry.unqualified++;
          entry.reasons[row.state]=(entry.reasons[row.state]??0)+1;
        }
      }
      catch { hiddenByAcl = true; /* Never count inaccessible documents. */ }
    }
    const resource=await this.resourceSample();
    return {
      state:run?.state??'unstarted',
      coverage:run?.state==='complete' && run.incomplete===0 && !hiddenByAcl && rows.length <= this.config.budgets.maxQueryCandidates
        ? 'complete_bounded_scan':'partial_or_unverified',
      visibleDocuments:visible, visibleCountTruncated:rows.length>this.config.budgets.maxQueryCandidates,
      actualFreshness:'not_monitored', configuredRoots:this.config.roots.length,
      visibleFormatCoverage:[...coverage.values()],
      resource:{indexBytes:resource.indexBytes,
        freeDiskMiB:resource.freeDiskBytes===null?null:Math.floor(resource.freeDiskBytes/(1024*1024)),
        freeMemoryMiB:Math.floor(resource.freeMemoryBytes/(1024*1024)),
        processRssMiB:Math.floor(process.memoryUsage().rss/(1024*1024)),
        gpuUsed:false,cpuPressure:'not_measured'},
    };
  }

  close(): void {
    // Never release exclusive ownership while main DB still has live work.
    try { this.db.close(); }
    finally { this.writer.release(); }
  }
}
