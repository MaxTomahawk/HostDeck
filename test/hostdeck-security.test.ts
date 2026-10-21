import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { AuditLog, TokenAuthority, PolicyGate } from '../src/hostdeck/security.js';

test('signed access tokens, current grants and restart-verifiable audit gate real dispatch', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hostdeck-security-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let audit = await AuditLog.open(directory);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'fixture' }] });
  const authority = new TokenAuthority({ issuer: 'https://issuer.example', audience: 'https://hostdeck.example/mcp', jwks });
  const now = Math.floor(Date.now() / 1000);
  const token = async (claims: object = {}, header: object = {}) => new SignJWT({ sub: 'subject', client_id: 'client', scope: 'files:read files:write', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture', typ: 'at+jwt', ...header }).setIssuer('https://issuer.example')
    .setAudience('https://hostdeck.example/mcp').setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
  const principal = await authority.verify(await token());
  let enabled = true;
  const gate = new PolicyGate(authority, audit, async () => enabled ? [{ issuer: 'https://issuer.example', subject: 'subject', clientId: 'client', deviceId: 'device_a', executorId: 'executor_a', scopes: ['files:read','files:write'], expiresAt: now + 300, revision: '1', broadUserAuthority: true, sessionIds: [1] }] : []);
  let dispatches = 0;
  await gate.execute(principal, 'hostdeck_write_file', { device_id: 'device_a', path: 'fixture.txt', content: 'sensitive body' }, async () => { dispatches++; return { ok: true }; });
  assert.equal(dispatches, 1);
  enabled = false;
  await assert.rejects(gate.execute(principal, 'hostdeck_write_file', { device_id:'device_a',path:'fixture.txt',content:'x' }, async () => { dispatches++; }), /DENIED/);
  await assert.rejects(gate.authorize({ ...principal }, 'hostdeck_read_file', { device_id:'device_a',path:'fixture.txt' }), /DENIED/);
  assert.equal(dispatches, 1);
  for (const claims of [{ exp: now - 1 }, { token_use: 'id' }]) {
    // Explicit expiry uses a separately constructed token to avoid SignJWT overwriting the fixture claim.
    const bad = claims.exp ? await new SignJWT({ sub:'subject', client_id:'client', scope:'files:read' }).setProtectedHeader({alg:'RS256',kid:'fixture',typ:'at+jwt'}).setIssuer('https://issuer.example').setAudience('https://hostdeck.example/mcp').setIssuedAt(now-30).setExpirationTime(now-1).sign(privateKey) : await token(claims, {typ:'JWT'});
    await assert.rejects(authority.verify(bad), /UNAUTHENTICATED/);
  }
  const keycloakToken = async (purpose='Bearer', audience='https://hostdeck.example/mcp') => new SignJWT({ sub:'subject', azp:'external-client', typ:purpose, scope:'files:read' })
    .setProtectedHeader({alg:'RS256',kid:'fixture',typ:'JWT'}).setIssuer('https://issuer.example').setAudience(audience).setIssuedAt(now).setExpirationTime(now+300).sign(privateKey);
  const keycloakAccess=await keycloakToken();
  await assert.rejects(authority.verify(keycloakAccess), /UNAUTHENTICATED/);
  const keycloakAuthority=new TokenAuthority({issuer:'https://issuer.example',audience:'https://hostdeck.example/mcp',jwks,accessTokenProfile:'keycloak'});
  const keycloakPrincipal=await keycloakAuthority.verify(keycloakAccess);assert.equal(keycloakPrincipal.clientId,'external-client');
  await assert.rejects(keycloakAuthority.verify(await keycloakToken('ID')), /UNAUTHENTICATED/);
  await assert.rejects(keycloakAuthority.verify(await keycloakToken('Refresh')), /UNAUTHENTICATED/);
  const wrongAudience=await keycloakToken('Bearer','https://other.example/mcp');
  await assert.rejects(keycloakAuthority.verify(wrongAudience), /UNAUTHENTICATED/);
  await assert.rejects(authority.verify((await token()).slice(0,-5)+'abcde'), /UNAUTHENTICATED/);
  audit.close();
  audit = await AuditLog.open(directory);
  assert.ok(audit.count() >= 3);
  assert.doesNotMatch(JSON.stringify(audit.records()), /sensitive body|fixture\.txt|subject/);
  audit.close();
});
