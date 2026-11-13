import { DatabaseSync } from 'node:sqlite';

/**
 * HD-B007-FULLTEXT-WRITER-001.
 *
 * A separate SQLite rollback-journal database holds a live BEGIN EXCLUSIVE
 * transaction for the entire lifetime of one index writer. The *main* WAL
 * database is never locked long-term: scan commits remain durable.
 *
 * OS SQLite file locks are released when the connection closes, including a
 * killed/crashed process. This uses neither PID tests, TTLs nor stale-file
 * unlinking. A second writer fails BEFORE opening the primary index or
 * changing its run, queue or metadata tables.
 *
 * The companion database is never deleted on release. It must inherit the
 * same protected state-directory ACL as the index and its WAL/SHM files.
 * Only this class may open the companion file; no read-only/multiwriter
 * facade has been qualified.
 */
export class FullTextWriterLock {
  private released = false;
  private constructor(
    private readonly connection: DatabaseSync,
    readonly companionPath: string,
  ) {}

  static acquire(indexFile: string): FullTextWriterLock {
    const companionPath = indexFile + '.writerlock.sqlite';
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(companionPath);
      // Do not use WAL for this *separate lock database*. In rollback-journal
      // mode BEGIN EXCLUSIVE owns an OS-backed lock until close/rollback.
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE");
      const mode = db.prepare('PRAGMA journal_mode').get() as {journal_mode?:string}|undefined;
      if (mode?.journal_mode?.toLowerCase() !== 'delete')
        throw new Error('FULLTEXT_WRITER_LOCK_MODE_UNQUALIFIED');
      db.exec('CREATE TABLE IF NOT EXISTS lock_schema (version INTEGER PRIMARY KEY)');
      db.exec('BEGIN EXCLUSIVE');
      return new FullTextWriterLock(db,companionPath);
    } catch (error) {
      try { db?.close(); } catch { /* Keep original failure as primary. */ }
      const code = (error as {code?:unknown})?.code;
      const message = error instanceof Error ? error.message : '';
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ||
          /(?:SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked)/i.test(message))
        throw new Error('FULLTEXT_WRITER_BUSY');
      if (message.startsWith('FULLTEXT_WRITER_')) throw error;
      throw new Error('FULLTEXT_WRITER_LOCK_FAILED');
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try { this.connection.exec('ROLLBACK'); }
    finally { this.connection.close(); }
  }
}
