import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AuditLog, TokenAuthority, PolicyGate, type Grant } from '../src/hostdeck/security.js';
import { HostDeckFacade, createHttpBoundary } from '../src/hostdeck/gateway.js';

// These tests exercise the real JWT verifier, on-disk grant reads and HTTP MCP
// boundary. The private-file adapter is the dispatch oracle, not a mock of the
// policy code. The executor-check barrier models an asynchronous trust lookup;
// it does not claim Windows peer authentication or real provider acceptance.
async function harness(reauthorizeInsideAdapter = false) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'hostdeck-grant-lifecycle-')));
  assert.equal(path.dirname(root), parent);
  const grantFile = path.join(root, 'grants.json');
  const canaryFile = path.join(root, 'canary.txt');
  const marker = 'AUTH062_PRIVATE_CANARY';
  await fs.writeFile(canaryFile, marker, { flag: 'wx' });
  const audit = await AuditLog.open(path.join(root, 'audit'));
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const issuer = 'https://issuer.example', resource = 'https://device.example/mcp';
  const authority = new TokenAuthority({ issuer, audience: resource,
    jwks: createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'owned-fixture' }] }) });
  const grant: Grant = { issuer, subject: 'owned-subject', clientId: 'owned-client', deviceId: 'device',
    executorId: 'executor', scopes: ['files:read', 'devices:read'], expiresAt: Math.floor(Date.now() / 1000) + 300,
    revision: '1', broadUserAuthority: true, sessionIds: [1] };
  const setGrants = async (value: Grant[]) => {
    await fs.writeFile(grantFile + '.tmp', JSON.stringify(value));
    await fs.rename(grantFile + '.tmp', grantFile);
  };
  await setGrants([grant]);
  const gate = new PolicyGate(authority, audit, async () => JSON.parse(await fs.readFile(grantFile, 'utf8')));
  let dispatches = 0;
  let privateReads = 0;
  let skipChecks = 0;
  let held: (() => Promise<void>) | undefined;
  let release: (() => void) | undefined;
  const facade: HostDeckFacade = new HostDeckFacade({ deviceId: 'device', executorId: 'executor', gate, appHtml: marker,
    checkExecutor: async () => { if (held && skipChecks-- > 0) return; const check = held; held = undefined; await check?.(); },
    adapters: [{ implementedTools: new Set(['hostdeck_read_file']), handle: async (name, args) => {
      dispatches++;
      if (reauthorizeInsideAdapter) await facade.reauthorize(name, args);
      privateReads++;
      return { content: await fs.readFile(canaryFile, 'utf8') };
    } }] });
  const allowedHosts: string[] = [];
  const boundary = createHttpBoundary(facade, authority, { issuer, resource, allowedHosts, allowedOrigins: [] });
  const nodeHandler = toNodeHandler(boundary);
  const server = http.createServer((req, res) => void nodeHandler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  allowedHosts.push(`127.0.0.1:${port}`);
  let id = 0;
  const token = async (expiresAt = Math.floor(Date.now() / 1000) + 300) => new SignJWT({
    sub: 'owned-subject', client_id: 'owned-client', scope: 'files:read devices:read',
  }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'owned-fixture' }).setIssuer(issuer)
    .setAudience(resource).setIssuedAt(Math.floor(Date.now() / 1000)).setExpirationTime(expiresAt).sign(privateKey);
  const rpc = async (bearer: string, method = 'tools/call') => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method,
        params: method === 'tools/call' ? { name: 'hostdeck_read_file', arguments: { device_id: 'device', path: 'canary.txt' } }
          : method === 'resources/read' ? { uri: 'ui://hostdeck/management/v2' } : {} }),
      signal: AbortSignal.timeout(8000),
    });
    const raw = await response.text();
    const payload = raw.startsWith('event:') || raw.startsWith('data:')
      ? raw.split('\n').find(line => line.startsWith('data:'))!.slice(5) : raw;
    return { status: response.status, raw, data: response.status === 200 ? JSON.parse(payload) : undefined };
  };
  return { root, marker, grant, token, rpc, setGrants, dispatches: () => dispatches, privateReads: () => privateReads,
    holdExecutorCheck: (skip = 0) => {
      skipChecks = skip;
      let entered!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      held = async () => { entered(); await resumed; };
      return { entered: enteredPromise, release: () => release?.() };
    },
    close: async () => {
      release?.();
      await boundary.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      audit.close();
      // Only the canonical newly created fixture tree, never a supplied path.
      assert.equal(path.dirname(await fs.realpath(root)), parent);
      await fs.rm(root, { recursive: true });
    } };
}

test('grant revoked during executor validation denies the real HTTP response before backend dispatch', async t => {
  const h = await harness(); t.after(h.close);
  const bearer = await h.token();
  const barrier = h.holdExecutorCheck();
  const pending = h.rpc(bearer);
  await Promise.race([barrier.entered, pending.then(() => { throw new Error('executor check was not reached'); })]);
  await h.setGrants([]);
  barrier.release();
  const denied = await pending;
  t.diagnostic(JSON.stringify({ case: 'revoke_during_executor_check', status: denied.status,
    backend_dispatches: h.dispatches(), canary_disclosed: denied.raw.includes(h.marker) }));
  assert.equal(denied.data.result.isError, true, 'revoked grant must not release private backend data');
  assert.ok(!denied.raw.includes(h.marker), 'revocation during the trust check must not disclose the canary');
  assert.equal(h.dispatches(), 0, 'backend must not be reached after revocation');
  await h.setGrants([{ ...h.grant, revision: '2' }]);
  const allowed = await h.rpc(bearer);
  assert.equal(allowed.data.result.structuredContent.result.content, h.marker);
  assert.equal(h.dispatches(), 1, 'renewal permits exactly one newly requested operation, without replay');
});

test('a replaced grant revision cannot authorize an operation already waiting on executor validation', async t => {
  const h = await harness(); t.after(h.close);
  const bearer = await h.token();
  const barrier = h.holdExecutorCheck();
  const pending = h.rpc(bearer);
  await Promise.race([barrier.entered, pending.then(() => { throw new Error('executor check was not reached'); })]);
  await h.setGrants([{ ...h.grant, revision: '2' }]);
  barrier.release();
  const stale = await pending;
  t.diagnostic(JSON.stringify({ case: 'replace_revision_during_executor_check', status: stale.status,
    backend_dispatches: h.dispatches(), canary_disclosed: stale.raw.includes(h.marker) }));
  assert.equal(stale.data.result.isError, true, 'the old admission must not inherit a replaced grant revision');
  assert.ok(!stale.raw.includes(h.marker));
  assert.equal(h.dispatches(), 0);
  const fresh = await h.rpc(bearer);
  assert.equal(fresh.data.result.structuredContent.result.content, h.marker);
  assert.equal(h.dispatches(), 1);
});

test('on-disk grant expiry and renewal affect existing tokens and discovery on each HTTP request', async t => {
  const h = await harness(); t.after(h.close);
  const bearer = await h.token();
  assert.equal((await h.rpc(bearer)).data.result.structuredContent.result.content, h.marker);
  await h.setGrants([{ ...h.grant, expiresAt: Math.floor(Date.now() / 1000) - 1 }]);
  const expired = await h.rpc(bearer);
  assert.equal(expired.data.result.isError, true); assert.ok(!expired.raw.includes(h.marker));
  assert.equal((await h.rpc(bearer, 'tools/list')).data.result.tools.length, 0);
  assert.equal(h.dispatches(), 1);
  await h.setGrants([{ ...h.grant, revision: '2' }]);
  assert.equal((await h.rpc(bearer)).data.result.structuredContent.result.content, h.marker);
  assert.equal(h.dispatches(), 2);
});

test('adapter reauthorization rechecks revocation after its own asynchronous executor validation', async t => {
  const h = await harness(true); t.after(h.close);
  const bearer = await h.token();
  const barrier = h.holdExecutorCheck(1); // first check admits the adapter; hold its fresh reauthorization
  const pending = h.rpc(bearer);
  await Promise.race([barrier.entered, pending.then(() => { throw new Error('adapter reauthorization was not reached'); })]);
  await h.setGrants([]);
  barrier.release();
  const denied = await pending;
  t.diagnostic(JSON.stringify({ case: 'revoke_during_adapter_reauthorization', status: denied.status,
    backend_dispatches: h.dispatches(), private_reads: h.privateReads(), canary_disclosed: denied.raw.includes(h.marker) }));
  assert.equal(denied.data.result.isError, true);
  assert.ok(!denied.raw.includes(h.marker));
  assert.equal(h.dispatches(), 1);
  assert.equal(h.privateReads(), 0, 'an adapter waiting to reauthorize must not read private bytes after revocation');
});

test('a signed token expiring during executor validation cannot be renewed by replacing its grant', async t => {
  const h = await harness(); t.after(h.close);
  const expiresAt = Math.floor(Date.now() / 1000) + 2;
  const bearer = await h.token(expiresAt);
  const barrier = h.holdExecutorCheck();
  const pending = h.rpc(bearer);
  await Promise.race([barrier.entered, pending.then(() => { throw new Error('executor check was not reached'); })]);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt * 1000 - Date.now() + 20)));
  barrier.release();
  const expired = await pending;
  assert.equal(expired.data.result.isError, true);
  assert.ok(!expired.raw.includes(h.marker));
  assert.equal(h.dispatches(), 0);
  await h.setGrants([{ ...h.grant, revision: '2' }]);
  assert.equal((await h.rpc(bearer)).status, 401, 'a renewed grant cannot extend an expired token');
  assert.equal(h.dispatches(), 0);
  const renewed = await h.rpc(await h.token());
  assert.equal(renewed.data.result.structuredContent.result.content, h.marker);
  assert.equal(h.dispatches(), 1);
});

test('manager resource reads also deny grants revoked during executor validation', async t => {
  const h = await harness(); t.after(h.close);
  const bearer = await h.token();
  const barrier = h.holdExecutorCheck();
  const pending = h.rpc(bearer, 'resources/read');
  await Promise.race([barrier.entered, pending.then(() => { throw new Error('executor check was not reached'); })]);
  await h.setGrants([]);
  barrier.release();
  const denied = await pending;
  assert.ok(denied.data.error?.message.includes('DENIED'));
  assert.ok(!denied.raw.includes(h.marker));
  assert.equal(h.dispatches(), 0);
  await h.setGrants([{ ...h.grant, revision: '2' }]);
  const fresh = await h.rpc(bearer, 'resources/read');
  assert.equal(fresh.data.result.contents[0].text, h.marker);
});
