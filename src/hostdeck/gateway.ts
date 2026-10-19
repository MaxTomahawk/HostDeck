import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { discoverTools, parseToolArguments, listResourceTemplates, resolveResource, listPrompts, renderPrompt, ContractError } from './contracts.js';
import { PolicyGate, TokenAuthority, type Principal, type ExecutionContext } from './security.js';
import { RuntimeError } from './runtime-error.js';

export interface Adapter {
  readonly implementedTools: ReadonlySet<string>;
  handle(name: string, args: Record<string, unknown>, context: ExecutionContext): Promise<unknown>;
}
export interface FacadeOptions {
  deviceId: string; executorId: string; gate: PolicyGate;
  adapters: readonly Adapter[];
  appHtml?: string;
  checkExecutor?: () => Promise<void>;
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
    server.setRequestHandler('tools/list', async () => ({ tools: discoverTools(await this.visible(principal())).map(tool => ({ ...tool, inputSchema:{...tool.inputSchema,type:'object' as const},
      ...(this.options.appHtml ? { _meta: { ui: {resourceUri: 'ui://hostdeck/management'}, 'openai/outputTemplate': 'ui://hostdeck/management' } } : {}) })) }));
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
export function publicError(error: unknown): string {
  if ((error instanceof RuntimeError || error instanceof ContractError) && /^[A-Z][A-Z_]{1,64}$/.test(error.code)) return error.code;
  return 'IO_ERROR';
}

export interface HttpBoundaryOptions {
  allowedHosts: readonly string[]; allowedOrigins: readonly string[];
  resource: string; issuer: string;
  oauthOrigin?: string;
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
      if (!options.allowedHosts.includes(url.host) || (origin !== null && !options.allowedOrigins.includes(origin))) return new Response('FORBIDDEN',{status:403});
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
        return Response.json({ resource:options.resource,authorization_servers:[options.issuer],bearer_methods_supported:['header'],scopes_supported:['files:read','files:write','process:execute','desktop:observe','desktop:control','browser:control','jobs:read','jobs:control','artifacts:read','devices:read'] });
      }
      if (url.pathname !== '/mcp') return new Response('NOT_FOUND',{status:404});
      if (pending >= 32) return new Response('BUSY',{status:429});
      const authorization = request.headers.get('authorization');
      let principal: Principal;
      try {
        if (!authorization?.startsWith('Bearer ') || authorization.length > 16_400) throw new RuntimeError('UNAUTHENTICATED');
        principal = await authority.verify(authorization.slice(7));
      } catch { return new Response('UNAUTHENTICATED',{status:401,headers:{'WWW-Authenticate':`Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp',options.resource).href}"`}}); }
      pending++;
      try { return await principals.run(principal, () => handler.fetch(request)); }
      catch { return new Response('REQUEST_FAILED',{status:400}); }
      finally { pending--; }
    },
  };
}
