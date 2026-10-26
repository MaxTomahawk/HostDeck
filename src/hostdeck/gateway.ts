import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { discoverTools, parseToolArguments, listResourceTemplates, resolveResource, listPrompts, renderPrompt, ContractError } from './contracts.js';
import { PolicyGate, TokenAuthority, AuthenticationError, type AuthenticationReason, type Principal, type ExecutionContext } from './security.js';
import { RuntimeError } from './runtime-error.js';

export interface Adapter {
  readonly implementedTools: ReadonlySet<string>;
  handle(name: string, args: Record<string, unknown>, context: ExecutionContext): Promise<unknown>;
}
export interface ConnectionDiagnostic {
  stage:'discovery'|'origin-rejected'|'authentication-rejected'|'mcp-response'|'mcp-error';
  status?:number;toolCount?:number;method?:string;protocol?:string;
  assertionPresent?:boolean;bearerPresent?:boolean;origin?:'absent'|'allowed'|'chatgpt'|'other';
  authenticationReason?:AuthenticationReason;
}
function diagnose(callback:((event:ConnectionDiagnostic)=>void)|undefined,event:ConnectionDiagnostic):void {
  try{callback?.(event);}catch{/* Connection diagnostics never change authorization or execution. */}
}
export interface FacadeOptions {
  deviceId: string; executorId: string; gate: PolicyGate;
  adapters: readonly Adapter[];
  appHtml?: string;
  checkExecutor?: () => Promise<void>;
  diagnostic?: (event:ConnectionDiagnostic)=>void;
}

/** One policy boundary for tools, resource reads and interactive App calls. */
export class HostDeckFacade {
  private readonly adapters = new Map<string, Adapter>();
  readonly requests = new AsyncLocalStorage<{principal: Principal; context: ExecutionContext}>();
  constructor(private readonly options: FacadeOptions) {
    for (const adapter of options.adapters) for (const name of adapter.implementedTools) {
      if (this.adapters.has(name)) throw new RuntimeError('DUPLICATE_ADAPTER');
      this.adapters.set(name, adapter);
    }
  }

  async reauthorize(name: string, args: Readonly<Record<string, unknown>>): Promise<void> {
    const request = this.requests.getStore();
    if (!request) throw new RuntimeError('DENIED');
    const context = await this.options.gate.authorize(request.principal, name, args);
    await this.options.checkExecutor?.();
    this.bound(context);
    if (context.revision !== request.context.revision) throw new RuntimeError('DENIED');
  }
  private bound(context: ExecutionContext): void {
    if (context.deviceId !== this.options.deviceId || context.executorId !== this.options.executorId) throw new RuntimeError('DENIED');
  }
  async call(principal: Principal, name: string, raw: unknown): Promise<unknown> {
    if (name.length > 128) throw new RuntimeError('UNAVAILABLE');
    const args = parseToolArguments(name, raw);
    const adapter = this.adapters.get(name);
    if (!adapter) throw new RuntimeError('UNAVAILABLE');
    return this.options.gate.execute(principal, name, args, async context => {
      this.bound(context);
      await this.options.checkExecutor?.();
      return this.requests.run({principal, context}, () => adapter.handle(name, args, context));
    });
  }
  private async visible(principal: Principal) {
    try {
      const allowed = await this.options.gate.visible(principal, this.options.deviceId, this.options.executorId);
      return new Set([...this.adapters.keys()].filter(name => allowed.has(name)));
    } catch { throw new RuntimeError('DENIED'); }
  }
  localUi(): string | undefined { return this.options.appHtml; }

  server(principalInput: Principal | (() => Principal)): Server {
    const principal = () => typeof principalInput === 'function' ? principalInput() : principalInput;
    const server = new Server({ name: 'HostDeck', version: '0.3.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
    server.setRequestHandler('tools/list', async () => {
      const tools=discoverTools(await this.visible(principal())).map(tool => ({ ...tool, inputSchema:{...tool.inputSchema,type:'object' as const},
        ...(this.options.appHtml ? { _meta: { ui: {resourceUri: 'ui://hostdeck/management'}, 'openai/outputTemplate': 'ui://hostdeck/management' } } : {}) }));
      diagnose(this.options.diagnostic,{stage:'discovery',toolCount:tools.length});
      return {tools};
    });
    server.setRequestHandler('tools/call', async request => {
      try {
        const result = await this.call(principal(), request.params.name, request.params.arguments ?? {});
        // Keep arbitrary text/command output as untrusted tool content, never instructions or metadata.
        const text = JSON.stringify(result ?? null);
        if (Buffer.byteLength(text) > 2_097_152) throw new RuntimeError('RESULT_LIMIT');
        return { content: [{type: 'text', text}], structuredContent: { result: result ?? null } };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: publicError(error) }] };
      }
    });
    server.setRequestHandler('resources/templates/list', async () => {
      const names = await this.visible(principal());
      return { resourceTemplates: listResourceTemplates().filter(r => names.has(resourceOperation(r.name))).map(({requiredScopes, ...r}) => r) };
    });
    server.setRequestHandler('resources/list', async () => ({ resources: this.options.appHtml && (await this.visible(principal())).size
      ? [{uri:'ui://hostdeck/management',name:'HostDeck management',mimeType:'text/html;profile=mcp-app'}] : [] }));
    server.setRequestHandler('resources/read', async request => {
      const uri = request.params.uri;
      try {
        if (uri === 'ui://hostdeck/management') {
          if (!this.options.appHtml || !(await this.visible(principal())).size) throw new RuntimeError('DENIED');
          return { contents:[{uri,mimeType:'text/html;profile=mcp-app',text:this.options.appHtml,
            _meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetPrefersBorder':true}}] };
        }
        const resource = resolveResource(uri);
        const result = await this.call(principal(), resourceOperation(resource.name), resource.arguments);
        return { contents:[{uri,mimeType:'application/json',text:JSON.stringify(result ?? null)}] };
      } catch (error) { throw new Error(publicError(error)); }
    });
    server.setRequestHandler('prompts/list', async () => ({ prompts: (await this.visible(principal())).size ? listPrompts() : [] }));
    server.setRequestHandler('prompts/get', async request => {
      try {
        const args = request.params.arguments ?? {};
        if (args.device_id !== this.options.deviceId || !(await this.visible(principal())).size) throw new RuntimeError('DENIED');
        return renderPrompt(request.params.name, args);
      } catch (error) { throw new Error(publicError(error)); }
    });
    return server;
  }
}

function resourceOperation(name: string): string {
  return ({hostdeck_device:'hostdeck_device_status',hostdeck_job:'hostdeck_read_job',hostdeck_artifact:'hostdeck_read_artifact',hostdeck_events:'hostdeck_read_events'} as Record<string,string>)[name] ?? '';
}
const publicAdapterErrors=new Set(['STALE_WINDOW','STALE_ELEMENT','STALE_MONITOR','WINDOW_NOT_FOREGROUND','OUTSIDE_WINDOW',
  'EFFECT_OUTCOME_UNCERTAIN','EDIT_CONFLICT','BROWSER_PRIVATE_EGRESS_DENIED','BROWSER_EGRESS_DENIED','BROWSER_PROTOCOL_DENIED',
  'BROWSER_SESSION_NOT_OWNED','BROWSER_STALE_ELEMENT','BROWSER_START_FAILED','BROWSER_PAGE_FAILED','BROWSER_NAVIGATION_FAILED',
  'BROWSER_INVALID_URL','OCR_LANGUAGE_UNAVAILABLE',
  'PDF_UNICODE_RENDERER_REQUIRED','PROCESS_LIST_UNAVAILABLE','FILES_DIRECTORY_NOT_EMPTY']);
export function publicError(error: unknown): string {
  if ((error instanceof RuntimeError || error instanceof ContractError) && /^[A-Z][A-Z_]{1,64}$/.test(error.code)) return error.code;
  if(error instanceof Error&&publicAdapterErrors.has(error.message))return error.message;
  return 'IO_ERROR';
}

export interface HttpBoundaryOptions {
  allowedHosts: readonly string[]; allowedOrigins: readonly string[];
  resource: string; issuer: string;
  oauthOrigin?: string;
  managementEnabled?:boolean;
  cloudflareAccess?: { audience: string; scopes: readonly string[]; clientId: string };
  diagnostic?: (event:ConnectionDiagnostic)=>void;
}
export function createHttpBoundary(facade: HostDeckFacade, authority: TokenAuthority, options: HttpBoundaryOptions) {
  const principals = new AsyncLocalStorage<Principal>();
  const handler = createMcpHandler(() => {
    const principal = principals.getStore();
    if (!principal) throw new RuntimeError('UNAUTHENTICATED');
    return facade.server(principal);
  }, { legacy:'stateless',maxRequestBodySize:2_097_152, onerror:()=>{} });
  let pending = 0;
  return {
    close: () => handler.close(),
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      const trace=(stage:ConnectionDiagnostic['stage'],status:number,authenticationReason?:AuthenticationReason)=>{
        const protocol=request.headers.get('mcp-protocol-version');
        diagnose(options.diagnostic,{stage,status,...(authenticationReason?{authenticationReason}:{}),method:['GET','POST','DELETE','OPTIONS'].includes(request.method)?request.method:'OTHER',
          ...(protocol&&/^\d{4}-\d{2}-\d{2}$/.test(protocol)?{protocol}:{}),
          assertionPresent:request.headers.has('cf-access-jwt-assertion'),bearerPresent:request.headers.get('authorization')?.startsWith('Bearer ')??false,
          origin:origin===null?'absent':options.allowedOrigins.includes(origin)?'allowed':origin==='https://chatgpt.com'?'chatgpt':'other'});
      };
      if (!options.allowedHosts.includes(url.host) || (origin !== null && !options.allowedOrigins.includes(origin))) {
        trace('origin-rejected',403);return new Response('FORBIDDEN',{status:403});
      }
      if ((url.pathname === '/ui'||url.pathname === '/oauth/callback') && request.method === 'GET') {
        const html = facade.localUi();
        if (!html) return new Response('NOT_FOUND',{status:404});
        const hash = (value:string) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
        const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => hash(match[1]));
        const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => hash(match[1]));
        return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
          'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
          'Content-Security-Policy':`default-src 'none'; script-src ${scripts.join(' ')||"'none'"}; style-src ${styles.join(' ')||"'none'"}; connect-src 'self' ${options.oauthOrigin??''}; img-src blob: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`}});
      }
      if (url.pathname === '/health' && request.method === 'GET') return Response.json({product:'HostDeck',status:'ready'});
      if (['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(url.pathname) && request.method === 'GET') {
        if (options.cloudflareAccess) return new Response('NOT_FOUND',{status:404});
        return Response.json({ resource:options.resource,authorization_servers:[options.issuer],bearer_methods_supported:['header'],scopes_supported:[
          'files:read','files:write','process:execute','desktop:observe','desktop:control','browser:control','jobs:read','jobs:control','artifacts:read','devices:read',...(options.managementEnabled?['host:manage']:[])] });
      }
      if (url.pathname !== '/mcp') return new Response('NOT_FOUND',{status:404});
      if (pending >= 32) return new Response('BUSY',{status:429});
      const authorization = request.headers.get('authorization');
      let principal: Principal;
      try {
        if (options.cloudflareAccess) {
          const assertion = request.headers.get('cf-access-jwt-assertion');
          if (!assertion) throw new RuntimeError('UNAUTHENTICATED');
          principal = await authority.verifyCloudflareAssertion(assertion, options.cloudflareAccess.audience,
            options.cloudflareAccess.scopes, options.cloudflareAccess.clientId);
        } else {
          if (!authorization?.startsWith('Bearer ') || authorization.length > 16_400) throw new RuntimeError('UNAUTHENTICATED');
          principal = await authority.verify(authorization.slice(7));
        }
      } catch (error) {
        trace('authentication-rejected',options.cloudflareAccess?403:401,error instanceof AuthenticationError?error.reason:undefined);
        return options.cloudflareAccess ? new Response('UNAUTHENTICATED',{status:403})
          : new Response('UNAUTHENTICATED',{status:401,headers:{'WWW-Authenticate':`Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp',options.resource).href}"`}});
      }
      if(!options.managementEnabled)principal=authority.withoutScopes(principal,['host:manage']);
      pending++;
      try { const response=await principals.run(principal, () => handler.fetch(request));trace('mcp-response',response.status);return response; }
      catch { trace('mcp-error',400);return new Response('REQUEST_FAILED',{status:400}); }
      finally { pending--; }
    },
  };
}
