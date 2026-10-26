import { App } from '@modelcontextprotocol/ext-apps';
import { PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountExtensionManager } from './extension-manager.js';

const app = new App({ name: 'HostDeck Management', version: '1.1.0' }, {});
const $ = <T extends HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)!;
const content = $('#content');
const status = $('#status');
const device = $('#device') as HTMLInputElement;
const tokenInput = $('#token') as HTMLInputElement;
const connection = $('#connection');
let connected = false;
let currentView = 'overview';
let client: Client | undefined;
let transport: StreamableHTTPClientTransport | undefined;
let activeSession = '';
let activeWindow = '';
let screenshotUrl: string | undefined;
let accessToken: string | undefined;

interface OAuthConfig { issuer: string; clientId: string; resource: string; scopes: string[]; authorizationEndpoint: string; tokenEndpoint: string; }
declare global { interface Window { __HOSTDECK_OAUTH__?: OAuthConfig; __HOSTDECK_AUTH_MODE__?: 'cloudflare-access'; } }
const OAUTH_STATE_KEY = 'hostdeck.oauth.state';
const OAUTH_VERIFIER_KEY = 'hostdeck.oauth.verifier';
const OAUTH_CREATED_KEY = 'hostdeck.oauth.createdAt';
const OAUTH_MAX_AGE_MS = 10 * 60_000;

function node(parent: HTMLElement, tag: string, text?: string, className?: string): HTMLElement {
  const child = document.createElement(tag); if (text !== undefined) child.textContent = text; if (className) child.className = className; parent.append(child); return child;
}
function input(parent: HTMLElement, labelText: string, id: string, value = '', type = 'text'): HTMLInputElement {
  const label = node(parent, 'label', labelText); const field = document.createElement('input'); field.id = id; field.type = type; field.value = value; field.autocomplete = 'off'; label.append(field); return field;
}
function button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
  const item = node(parent, 'button', text) as HTMLButtonElement; item.type = 'button'; item.addEventListener('click', action); return item;
}
function unwrap(value: any): any {
  let result = value?.structuredContent ?? value;
  for (let index = 0; index < 3 && result && typeof result === 'object' && 'result' in result; index++) result = result.result;
  if (result?.structuredContent) result = result.structuredContent;
  if (Array.isArray(result?.content) && result.content.length === 1 && result.content[0]?.type === 'text') {
    try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
  }
  return result;
}
async function call(name: string, extra: Record<string, unknown> = {}): Promise<any> {
  if (!connected) throw new Error('Connect to HostDeck first.');
  const deviceId = device.value.trim(); if (!deviceId) throw new Error('Enter the authorized device ID.');
  const args = { device_id: deviceId, ...extra };
  if (client) {
    const result: any = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.map((part: any) => part.text ?? '').join('\n') || 'HostDeck request failed.');
    return unwrap(result);
  }
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.map(part => part.type === 'text' ? part.text : '').join('\n') || 'HostDeck request failed.');
  return unwrap(result);
}
function showResult(value: unknown): void {
  let box = content.querySelector<HTMLElement>('#result');
  if (!box) { box = document.createElement('div'); box.id = 'result'; content.append(box); }
  box.replaceChildren(); node(box, 'pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
async function run(work: () => Promise<unknown>): Promise<void> {
  status.textContent = 'Loading authorized HostDeck data…';
  try { showResult(await work()); status.textContent = 'Loaded from HostDeck.'; }
  catch (error) { showResult(error instanceof Error ? error.message : 'HostDeck request failed.'); status.textContent = 'Request failed.'; }
}
function rows(value: any, key: string): any[] { const data = unwrap(value); return Array.isArray(data?.[key]) ? data[key] : []; }
function encodeBase64Url(bytes: Uint8Array): string { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function randomUrlToken(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return encodeBase64Url(bytes); }
function oauthConfig(): OAuthConfig | undefined { return window.__HOSTDECK_OAUTH__; }
async function connectWithAccessToken(token?: string): Promise<void> {
  const next = new Client({ name: 'HostDeck local panel', version: '1.2.0' }, { capabilities: {} });
  const headers: Record<string,string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const nextTransport = new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin), { requestInit: { headers, credentials: 'include', redirect: 'error' } });
  try { await next.connect(nextTransport); }
  catch (error) { await next.close().catch(() => {}); throw error; }
  client = next; transport = nextTransport; accessToken = token; connected = true;
  tokenInput.value = ''; connection.hidden = true; status.textContent = 'Connected. Enter the authorized device ID.'; render();
}
async function beginOAuth(): Promise<void> {
  const config = oauthConfig(); if (!config) throw new Error('OAuth is not configured.');
  const issuer = new URL(config.issuer); const authorization = new URL(config.authorizationEndpoint);
  if (issuer.protocol !== 'https:' || authorization.protocol !== 'https:' || authorization.origin !== issuer.origin) throw new Error('OAUTH_CONFIGURATION_INVALID');
  const state = randomUrlToken(); const verifier = randomUrlToken();
  const createdAt = Date.now();
  sessionStorage.setItem(OAUTH_STATE_KEY, state); sessionStorage.setItem(OAUTH_VERIFIER_KEY, verifier); sessionStorage.setItem(OAUTH_CREATED_KEY, String(createdAt));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const callback = `${window.location.origin}/oauth/callback`;
  authorization.searchParams.set('response_type', 'code'); authorization.searchParams.set('client_id', config.clientId);
  authorization.searchParams.set('redirect_uri', callback); authorization.searchParams.set('state', state);
  authorization.searchParams.set('code_challenge', encodeBase64Url(digest)); authorization.searchParams.set('code_challenge_method', 'S256');
  authorization.searchParams.set('resource', config.resource); authorization.searchParams.set('scope', config.scopes.join(' '));
  window.location.assign(authorization.href);
}
async function exchangeCode(code: string, verifier: string): Promise<string> {
  const config = oauthConfig(); if (!config) throw new Error('OAUTH_CONFIGURATION_UNAVAILABLE');
  const tokenEndpoint = new URL(config.tokenEndpoint); const issuer = new URL(config.issuer);
  if (tokenEndpoint.protocol !== 'https:' || tokenEndpoint.origin !== issuer.origin) throw new Error('OAUTH_CONFIGURATION_INVALID');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId,
    redirect_uri: `${window.location.origin}/oauth/callback`, code_verifier: verifier, resource: config.resource });
  const response = await fetch(tokenEndpoint.href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form,
    credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
  const declared = Number(response.headers.get('content-length') ?? 0); if (declared > 64 * 1024) throw new Error('OAUTH_EXCHANGE_FAILED');
  if (!response.ok || !response.body) throw new Error('OAUTH_EXCHANGE_FAILED');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 64 * 1024) throw new Error('OAUTH_EXCHANGE_FAILED'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let result: any; try { result = JSON.parse(body); } catch { throw new Error('OAUTH_EXCHANGE_FAILED'); }
  if (typeof result.access_token !== 'string' || result.access_token.length < 8 || result.access_token.length > 16_384 || String(result.token_type).toLowerCase() !== 'bearer') throw new Error('OAUTH_EXCHANGE_FAILED');
  return result.access_token as string;
}
async function handleOAuthCallback(): Promise<void> {
  if (window.location.pathname !== '/oauth/callback') return;
  const callback = new URL(window.location.href);
  const returnedState = callback.searchParams.get('state') ?? '';
  const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY) ?? '';
  const verifier = sessionStorage.getItem(OAUTH_VERIFIER_KEY) ?? '';
  const createdAt = Number(sessionStorage.getItem(OAUTH_CREATED_KEY) ?? 0);
  sessionStorage.removeItem(OAUTH_STATE_KEY); sessionStorage.removeItem(OAUTH_VERIFIER_KEY); sessionStorage.removeItem(OAUTH_CREATED_KEY);
  history.replaceState(null, '', '/ui');
  if (!expectedState || returnedState !== expectedState || !verifier || !Number.isSafeInteger(createdAt) || createdAt > Date.now() || Date.now() - createdAt > OAUTH_MAX_AGE_MS) {
    status.textContent = 'Sign-in expired or state validation failed. Please sign in again.'; return;
  }
  const code = callback.searchParams.get('code');
  if (!code || callback.searchParams.has('error')) { status.textContent = 'HostDeck sign-in was not completed.'; return; }
  try { const token = await exchangeCode(code, verifier); await connectWithAccessToken(token); }
  catch { status.textContent = 'HostDeck sign-in failed. Please try again.'; }
}
function fillSessions(parent: HTMLElement, data: any): HTMLSelectElement {
  const select = document.createElement('select'); select.id = 'session'; select.setAttribute('aria-label', 'Authorized session');
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  for (const item of sessions) { const option = document.createElement('option'); option.value = String(item.session_id); option.textContent = `Session ${item.session_id}${item.eligible ? ' · eligible' : ''}`; select.append(option); }
  if (sessions.length) { select.value = sessions.some((item: any) => String(item.session_id) === activeSession) ? activeSession : String(sessions[0].session_id); activeSession = select.value; }
  else node(parent, 'p', 'No eligible sessions returned by HostDeck.');
  select.addEventListener('change', () => { activeSession = select.value; activeWindow = ''; }); parent.append(select); return select;
}
async function overview(): Promise<unknown> {
  const [state, jobs] = await Promise.all([call('hostdeck_device_status'), call('hostdeck_list_jobs', { limit: 20 })]);
  const area = $('#device-overview', content); area.replaceChildren(); node(area, 'h2', 'Authorized device'); fillSessions(area, state);
  if (state.executor_id) node(area, 'p', `Executor ${state.executor_id}`);
  const recent = $('#recent-jobs', content); recent.replaceChildren(); node(recent, 'h2', 'Recent jobs');
  for (const job of rows(jobs, 'jobs')) node(recent, 'p', `${job.job_id ?? 'Job'} · ${job.state ?? job.status ?? 'unknown'}`);
  if (!rows(jobs, 'jobs').length) node(recent, 'p', 'No jobs returned.');
  return { device: state, jobs };
}
function baseCard(): HTMLElement { content.replaceChildren(); return node(content, 'section', undefined, 'card'); }
function buildOverview(): void {
  content.replaceChildren(); node(content, 'section', undefined, 'card').id = 'device-overview'; node(content, 'section', undefined, 'card').id = 'recent-jobs'; void run(overview);
}
function buildProviders(): void {
  const pane = baseCard();
  mountExtensionManager(pane, {
    call,
    deviceId: () => device.value.trim(),
    isCurrent: () => currentView === 'providers' && content.contains(pane),
  });
}

function buildFiles(): void {
  const pane = baseCard(); const pathField = input(pane, 'Workspace path', 'file-path', '.'); const output = node(pane, 'div');
  button(pane, 'List directory', () => void run(async () => { const value = await call('hostdeck_list_directory', { path: pathField.value, depth: 2, limit: 100 }); output.replaceChildren(); for (const item of rows(value, 'entries')) node(output, 'p', `${item.type} · ${item.path}`); return value; }));
  button(pane, 'Read text file', () => void run(async () => {
    const value = await call('hostdeck_read_file', { path: pathField.value, offset: 0, length: 500 });
    const editor = document.createElement('textarea'); editor.id = 'file-editor'; editor.rows = 12; editor.value = String(value?.content ?? value?.text ?? ''); editor.setAttribute('aria-label', 'File content');
    output.replaceChildren(editor); button(output, 'Save file', () => void run(() => call('hostdeck_write_file', { path: pathField.value, content: editor.value, mode: 'rewrite' }))); return value;
  }));
}
function buildJobs(): void {
  const pane = baseCard(); const detail = node(content, 'section'); detail.id = 'job-detail';
  void run(async () => { const jobs = await call('hostdeck_list_jobs', { limit: 100 }); const list = rows(jobs, 'jobs'); pane.replaceChildren(); if (!list.length) node(pane, 'p', 'No jobs returned.');
    for (const job of list) { const card = node(pane, 'article', undefined, 'card'); node(card, 'strong', `${job.job_id ?? 'Job'} · ${job.state ?? job.status ?? 'unknown'}`); node(card, 'p', String(job.command ?? job.summary ?? 'Bounded job'));
      if (job.job_id) { button(card, 'Details', () => void run(async () => { const value = await call('hostdeck_read_job', { job_id: job.job_id }); detail.replaceChildren(); node(detail, 'h2', 'Job details'); node(detail, 'pre', JSON.stringify(value, null, 2)); return value; })); button(card, 'Cancel job', () => void run(() => call('hostdeck_cancel_job', { job_id: job.job_id }))); }
      for (const artifactId of [job.stdout_artifact_id, job.stderr_artifact_id, job.artifact_id].filter(Boolean)) button(card, 'Read output', () => void run(async () => {
        const output = await call('hostdeck_read_artifact', { artifact_id: artifactId, offset: 0, length: 65536 });
        return { ...output, text: new TextDecoder().decode(Uint8Array.from(atob(output.data_base64 ?? ''), value => value.charCodeAt(0))), data_base64: undefined };
      }));
    } return jobs;
  });
}
function buildTerminal(): void {
  const pane = baseCard(); const cwd = input(pane, 'Workspace directory', 'cwd', '.'); const label = node(pane, 'label', 'Command');
  const command = document.createElement('textarea'); command.rows = 4; command.autocomplete = 'off'; label.append(command);
  button(pane, 'Submit bounded job', () => void run(() => call('hostdeck_submit_job', { command: command.value, working_directory: cwd.value, idempotency_key: crypto.randomUUID(), timeout_seconds: 300, resume: 'never' })));
}
async function readImage(artifact: any): Promise<Blob> {
  const id = String(artifact?.artifact_id ?? artifact?.artifactId ?? ''); if (!id) throw new Error('Screenshot response has no artifact ID.');
  const size = Number(artifact.size); if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) throw new Error('Screenshot artifact size unavailable or over preview limit.');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < size; offset += 1_048_576) { const part = await call('hostdeck_read_artifact', { artifact_id: id, offset, length: Math.min(1_048_576, size - offset) }); chunks.push(Uint8Array.from(atob(String(part.data_base64 ?? '')), char => char.charCodeAt(0))); }
  return new Blob(chunks.map(chunk => chunk.slice().buffer as ArrayBuffer), { type: String(artifact.mime_type ?? 'image/png') });
}
function buildScreen(): void {
  const pane = baseCard();
  void run(async () => { const state = await call('hostdeck_device_status'); const session = fillSessions(pane, state); const select = document.createElement('select'); select.id = 'window'; select.setAttribute('aria-label', 'Window'); pane.append(select);
    const load = async () => { const value = await call('hostdeck_list_windows', { session_id: Number(session.value) }); select.replaceChildren(); for (const window of rows(value, 'windows')) { const option = document.createElement('option'); option.value = String(window.window_id); option.textContent = `${window.title ?? 'Window'} · ${window.window_id}`; select.append(option); } activeWindow = select.value = rows(value, 'windows')[0] ? String(rows(value, 'windows')[0].window_id) : ''; return value; };
    session.addEventListener('change', () => { activeSession = session.value; void run(load); }); await load();
    button(pane, 'Capture selected window', () => void run(async () => { if (!select.value) throw new Error('Select a window returned by HostDeck.');
      const captured = await call('hostdeck_capture_screen', { session_id: Number(session.value), target: { kind: 'window', window_id: select.value }, max_dimension: 1400 }); const blob = await readImage(captured);
      if (screenshotUrl) URL.revokeObjectURL(screenshotUrl); screenshotUrl = URL.createObjectURL(blob); const img = document.createElement('img'); img.src = screenshotUrl; img.alt = 'Captured HostDeck window'; img.className = 'screenshot'; content.append(img); return captured;
    })); return state;
  });
}
function render(): void {
  if (!device.value.trim()) { status.textContent = 'Enter the authorized device ID.'; return; }
  if (currentView === 'overview') buildOverview(); else if (currentView === 'files') buildFiles(); else if (currentView === 'providers') buildProviders(); else if (currentView === 'jobs') buildJobs(); else if (currentView === 'terminal') buildTerminal(); else if (currentView === 'screen') buildScreen();
}
document.querySelectorAll<HTMLButtonElement>('nav button').forEach(item => item.addEventListener('click', () => { currentView = item.dataset.view!; render(); }));
$('#refresh').addEventListener('click', render);
device.addEventListener('change', () => { if (currentView === 'providers') render(); });
$('#connect').addEventListener('click', async () => {
  if (window.__HOSTDECK_AUTH_MODE__ === 'cloudflare-access') {
    try { await connectWithAccessToken(); } catch { status.textContent = 'Cloudflare Access connection failed. Sign in to the protected HostDeck page and retry.'; }
    return;
  }
  if (oauthConfig()) {
    try { await beginOAuth(); } catch { status.textContent = 'HostDeck sign-in could not be started.'; }
    return;
  }
  const token = tokenInput.value.trim(); if (!token) { status.textContent = 'Paste a short-lived HostDeck OAuth access token.'; tokenInput.focus(); return; }
  if (window.parent !== window) { status.textContent = 'Direct bearer-token sign-in is available only in standalone local mode.'; return; }
  try {
    await connectWithAccessToken(token);
  } catch (error) { status.textContent = error instanceof Error ? `Connection failed: ${error.message}` : 'Connection failed.'; }
});
$('#disconnect').addEventListener('click', async () => { await client?.close().catch(() => {}); client = undefined; transport = undefined; accessToken = undefined; connected = false; connection.hidden = false; status.textContent = 'Disconnected. Token cleared from memory.'; });
if (window.parent !== window) {
  void app.connect(new PostMessageTransport(window.parent, window.parent)).then(() => { connected = true; connection.hidden = true; status.textContent = 'Connected to HostDeck. Enter the authorized device ID.'; }).catch(() => { status.textContent = 'HostDeck MCP App connection unavailable.'; });
} else {
  connection.hidden = false;
  if (window.__HOSTDECK_AUTH_MODE__ === 'cloudflare-access') { $('#token').closest('label')!.hidden = true; $('#connect').textContent = 'Connect with Cloudflare Access'; status.textContent = 'Use the Cloudflare Access session for this protected HostDeck page.'; }
  else if (oauthConfig()) { $('#token').closest('label')!.hidden = true; $('#connect').textContent = 'Sign in with HostDeck'; status.textContent = 'Sign in with HostDeck to connect this local panel.'; }
  else status.textContent = 'Local mode: paste a short-lived access token. Token stays in memory only.';
  void handleOAuthCallback();
}
