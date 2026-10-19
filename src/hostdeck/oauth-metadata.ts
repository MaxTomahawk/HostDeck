export interface OAuthMetadataInput {
  issuer: string;
  clientId: string;
  resource: string;
  scopes: readonly string[];
  fetcher?: typeof fetch;
}
export interface OAuthBrowserConfig {
  issuer: string;
  clientId: string;
  resource: string;
  scopes: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

const MAX_METADATA_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_METADATA_BYTES) throw new Error('OAUTH_METADATA_LIMIT');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_METADATA_BYTES) throw new Error('OAUTH_METADATA_LIMIT');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function httpsUrl(value: unknown, origin: string): string {
  if (typeof value !== 'string') throw new Error('OAUTH_METADATA_INVALID');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('OAUTH_METADATA_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password || parsed.hash) throw new Error('OAUTH_ENDPOINT_UNTRUSTED');
  return parsed.href;
}

/** Load only public OIDC discovery metadata. Client credentials and tokens are never handled here. */
export async function loadOAuthMetadata(input: OAuthMetadataInput): Promise<OAuthBrowserConfig> {
  let issuer: URL;
  let resource: URL;
  try { issuer = new URL(input.issuer); resource = new URL(input.resource); }
  catch { throw new Error('OAUTH_CONFIGURATION_INVALID'); }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash || !issuer.hostname ||
      resource.protocol !== 'https:' || resource.username || resource.password || resource.hash || !input.clientId.trim() || input.clientId.length > 256 ||
      !Array.isArray(input.scopes) || input.scopes.length > 32 || input.scopes.some(scope => typeof scope !== 'string' || !scope.trim() || scope.length > 128)) {
    throw new Error('OAUTH_CONFIGURATION_INVALID');
  }
  const issuerValue = issuer.href;
  const discovery = `${issuerValue.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await (input.fetcher ?? fetch)(discovery, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('OAUTH_METADATA_UNAVAILABLE');
    const metadata = JSON.parse(await readBounded(response)) as Record<string, unknown>;
    if (metadata.issuer !== issuerValue) throw new Error('OAUTH_ISSUER_MISMATCH');
    const authorizationEndpoint = httpsUrl(metadata.authorization_endpoint, issuer.origin);
    const tokenEndpoint = httpsUrl(metadata.token_endpoint, issuer.origin);
    const methods = metadata.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) throw new Error('OAUTH_PKCE_S256_UNSUPPORTED');
    return {
      issuer: issuerValue, clientId: input.clientId, resource: resource.href,
      scopes: [...input.scopes], authorizationEndpoint, tokenEndpoint,
    };
  } catch (error) {
    if (error instanceof Error && /^OAUTH_[A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error('OAUTH_METADATA_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}
