import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { getToolContract, listToolContracts } from './contracts.js';
import { RuntimeError } from './runtime-error.js';

export interface Principal {
  readonly issuer: string; readonly subject: string; readonly clientId: string;
  readonly scopes: readonly string[]; readonly expiresAt: number;
}
export interface Grant {
  issuer: string; subject: string; clientId: string; deviceId: string; executorId: string;
  scopes: string[]; expiresAt: number; revision: string; broadUserAuthority: boolean; sessionIds: number[];
}
export interface ExecutionContext { ownerId: string; deviceId: string; executorId: string; sessionId?: number; sessionIds: readonly number[]; revision: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** HMAC chain detects local corruption; it does not defeat an administrator controlling this key/database. */
export class AuditLog {
  private closed = false;
  private poisoned = false;
  private constructor(private readonly db: DatabaseSync, private readonly key: Buffer) {}

  static async open(directory: string): Promise<AuditLog> {
    await fs.mkdir(directory, { recursive: true });
    const keyFile = path.join(directory, 'audit.key');
    try { await fs.writeFile(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new RuntimeError('AUDIT_UNAVAILABLE'); }
    const key = await fs.readFile(keyFile);
    if (key.length !== 32) throw new RuntimeError('AUDIT_CORRUPT');
    const db = new DatabaseSync(path.join(directory, 'audit.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, mac TEXT NOT NULL)');
      const audit = new AuditLog(db, key);
      let previous = '', sequence = 0;
      for (const row of audit.records()) {
        const body = JSON.parse(row.body as string);
        const expected = audit.digest(row.body as string);
        if (body.seq !== ++sequence || body.previous !== previous || !audit.equal(row.mac as string, expected)) throw new RuntimeError('AUDIT_CORRUPT');
        previous = row.mac as string;
      }
      return audit;
    } catch (error) { db.close(); throw error instanceof RuntimeError ? error : new RuntimeError('AUDIT_CORRUPT'); }
  }

  private digest(value: string): string { return createHmac('sha256', this.key).update(value).digest('hex'); }
  private equal(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  identity(value: unknown): string { return this.digest(canonical(value)); }
  count(): number { return Number(this.db.prepare('SELECT COUNT(*) AS count FROM audit').get()!.count); }
  records() { return this.db.prepare('SELECT seq, body, mac FROM audit ORDER BY seq').all(); }

  append(operation: string, actor: unknown, device: string, args: unknown, decision: string, revision: string): void {
    if (this.closed || this.poisoned) throw new RuntimeError('AUDIT_UNAVAILABLE');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const last = this.db.prepare('SELECT seq, mac FROM audit ORDER BY seq DESC LIMIT 1').get();
      const seq = Number(last?.seq ?? 0) + 1;
      if (seq > 100_000) throw new Error('quota');
      const safeOperation = /^hostdeck_[a-z_]+$/.test(operation) ? operation : 'unknown_operation';
      const body = canonical({ seq, previous: last?.mac ?? '', time: new Date().toISOString(), operation: safeOperation,
        actor: this.identity(actor), device: this.identity(device), arguments: this.identity(args), decision, revision });
      this.db.prepare('INSERT INTO audit(seq,body,mac) VALUES(?,?,?)').run(seq, body, this.digest(body));
      this.db.exec('COMMIT');
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* original admission already failed */ }
      this.poisoned = true;
      throw new RuntimeError('AUDIT_UNAVAILABLE');
    }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}

export class TokenAuthority {
  private readonly verified = new WeakSet<object>();
  constructor(private readonly options: { issuer: string; audience: string; jwks: JWTVerifyGetKey; accessTokenProfile?: 'rfc9068'|'keycloak' }) {}

  async verify(token: string): Promise<Principal> {
    try {
      if (!token || token.length > 16_384) throw new Error('token');
      const { payload, protectedHeader } = await jwtVerify(token, this.options.jwks, {
        issuer: this.options.issuer, audience: this.options.audience, algorithms: ['RS256','ES256'],
        requiredClaims: ['iss','sub','aud','exp','iat'], clockTolerance: 30,
      });
      const now = Date.now() / 1000;
      const rfc9068 = protectedHeader.typ === 'at+jwt' || (protectedHeader.typ === 'JWT' && payload.token_use === 'access');
      const keycloak = this.options.accessTokenProfile === 'keycloak' && protectedHeader.typ === 'JWT'
        && payload.typ === 'Bearer' && typeof payload.azp === 'string' && !!payload.azp;
      const clientId = keycloak ? payload.azp : payload.client_id ?? payload.azp;
      if (!rfc9068 && !keycloak) throw new Error('type');
      if (payload.token_use === 'id' || payload.typ === 'ID' || payload.typ === 'Refresh' || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
        || payload.exp! <= now || payload.iat! > now + 30 || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 600
        || typeof payload.sub !== 'string' || !payload.sub || typeof clientId !== 'string' || !clientId
        || typeof payload.scope !== 'string') throw new Error('claims');
      return this.mint({ issuer: payload.iss!, subject: payload.sub, clientId,
        scopes: payload.scope.split(' ').filter(Boolean), expiresAt: payload.exp! });
    } catch { throw new RuntimeError('UNAUTHENTICATED'); }
  }

  /** Cloudflare Access assertion path. Never accepts the opaque Managed OAuth bearer token. */
  async verifyCloudflareAssertion(token: string, audience: string, scopes: readonly string[], clientId: string): Promise<Principal> {
    try {
      if (!token || token.length > 16_384 || !audience || !clientId) throw new Error('token');
      const { payload, protectedHeader } = await jwtVerify(token, this.options.jwks, {
        issuer: this.options.issuer, audience, algorithms: ['RS256'],
        requiredClaims: ['iss','sub','aud','exp','iat'], clockTolerance: 30,
      });
      const now = Date.now() / 1000;
      if (protectedHeader.typ !== 'JWT' || payload.type !== 'app'
        || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
        || payload.exp! <= now || payload.iat! > now + 30 || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 900
        || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256) throw new Error('claims');
      return this.mint({issuer:payload.iss!,subject:payload.sub,clientId,scopes,expiresAt:payload.exp!});
    } catch { throw new RuntimeError('UNAUTHENTICATED'); }
  }

  /** Called only by the private OS-verified bootstrap; never from MCP arguments or HTTP claims. */
  local(identity: { sid: string; sessionId: number; elevated: boolean; eligible: boolean }, expectedSid: string, scopes: string[]): Principal {
    if (!identity.eligible || identity.elevated || identity.sessionId <= 0 || !expectedSid || identity.sid !== expectedSid) throw new RuntimeError('UNAUTHENTICATED');
    return this.mint({ issuer: 'hostdeck:local', subject: identity.sid, clientId: 'stdio', scopes, expiresAt: Date.now() / 1000 + 300 });
  }
  private mint(data: Principal): Principal {
    const principal = Object.freeze({ ...data, scopes: Object.freeze([...new Set(data.scopes)]) });
    this.verified.add(principal);
    return principal;
  }
  valid(principal: Principal): boolean { return this.verified.has(principal) && principal.expiresAt > Date.now() / 1000; }
}

export class PolicyGate {
  constructor(private readonly authority: TokenAuthority, private readonly audit: AuditLog,
    private readonly grants: () => Promise<Grant[]>) {}

  async visible(principal: Principal, deviceId: string, executorId: string): Promise<ReadonlySet<string>> {
    if (!this.authority.valid(principal)) return new Set();
    const grants = (await this.grants()).filter(g => this.matches(principal, g, deviceId) && g.executorId === executorId);
    if (!this.authority.valid(principal)) return new Set();
    return new Set(listToolContracts().filter(c => c.domain !== 'management'
      && c.requiredScopes.every(s => principal.scopes.includes(s))
      && grants.some(g => c.requiredScopes.every(s => g.scopes.includes(s)))).map(c => c.name));
  }

  private matches(principal: Principal, g: Grant, deviceId: unknown): boolean {
    return g.issuer === principal.issuer && g.subject === principal.subject && g.clientId === principal.clientId
      && g.deviceId === deviceId && g.expiresAt > Date.now() / 1000 && !!g.executorId && !!g.revision && g.broadUserAuthority === true;
  }

  async authorize(principal: Principal, name: string, args: Readonly<Record<string, unknown>>): Promise<ExecutionContext> {
    try {
      if (!this.authority.valid(principal)) throw new Error('principal');
      const contract = getToolContract(name);
      if (!contract.requiredScopes.every(scope => principal.scopes.includes(scope))) throw new Error('scope');
      const grant = (await this.grants()).find(g => this.matches(principal, g, args.device_id)
        && contract.requiredScopes.every(scope => g.scopes.includes(scope))
        && (args.session_id === undefined || g.sessionIds.includes(args.session_id as number)));
      if (!grant || !this.authority.valid(principal)) throw new Error('grant');
      // Privileged host management needs a separately registered action transaction, not an ordinary grant.
      if (contract.domain === 'management') throw new Error('management');
      return { ownerId: this.audit.identity([principal.issuer,principal.subject,principal.clientId]),
        deviceId: grant.deviceId, executorId: grant.executorId, sessionId: args.session_id as number | undefined,
        sessionIds: [...grant.sessionIds], revision: grant.revision };
    } catch {
      this.audit.append(name, principal, String(args.device_id ?? ''), args, 'denied', 'none');
      throw new RuntimeError('DENIED');
    }
  }

  async execute<T>(principal: Principal, name: string, args: Record<string, unknown>, effect: (context: ExecutionContext) => Promise<T>): Promise<T> {
    const context = await this.authorize(principal, name, args);
    this.audit.append(name, context.ownerId, context.deviceId, args, 'admitted', context.revision);
    const current = await this.authorize(principal, name, args);
    if (current.revision !== context.revision || current.executorId !== context.executorId) throw new RuntimeError('DENIED');
    let result: T;
    try { result = await effect(current); }
    catch (error) { this.audit.append(name, context.ownerId, context.deviceId, args, 'failed_or_uncertain', context.revision); throw error; }
    try { this.audit.append(name, context.ownerId, context.deviceId, {}, 'completed', context.revision); }
    catch { throw new RuntimeError('AUDIT_OUTCOME_UNCERTAIN'); }
    return result;
  }
}
