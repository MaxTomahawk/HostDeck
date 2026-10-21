import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import puppeteer, { type Browser, type KeyInput, type Page } from 'puppeteer-core';

export interface BrowserContext {
  ownerId: string;
  deviceId: string;
  executorId: string;
  sessionId?: number;
  /** Current trusted session grants supplied by the gateway for this request. */
  sessionIds?: readonly number[];
}

export type BrowserNetworkPolicy = (url: URL) => boolean | Promise<boolean>;

type Session = { browser: Browser; page: Page; profile: string; context: BrowserContext; generation: number; elements: Map<string, { generation: number; selector: string }> };
const toolNames = ['hostdeck_browser_open', 'hostdeck_browser_navigate', 'hostdeck_browser_snapshot', 'hostdeck_browser_interact', 'hostdeck_browser_evaluate', 'hostdeck_browser_close'] as const;

function privateAddress(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || value.endsWith('.internal')) return true;
  const ip = isIP(value);
  if (ip === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (ip === 6) return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff');
  return false;
}

function copyContext(value: BrowserContext): BrowserContext { return { ...value }; }
function sameContext(a: BrowserContext, b: BrowserContext): boolean {
  const sessionAllowed = a.sessionId !== undefined && (b.sessionIds ? b.sessionIds.includes(a.sessionId) : b.sessionId === a.sessionId);
  return a.ownerId === b.ownerId && a.deviceId === b.deviceId && a.executorId === b.executorId && sessionAllowed;
}

export class BrowserAdapter {
  readonly implementedTools = new Set<string>(toolNames);
  private readonly sessions = new Map<string, Session>();
  private constructor(private readonly executable: string, private readonly profileRoot: string, private readonly networkPolicy?: BrowserNetworkPolicy) {}

  static async create(options: { executable: string; profileRoot: string; networkPolicy?: BrowserNetworkPolicy }): Promise<BrowserAdapter> {
    if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.profileRoot)) throw new Error('BROWSER_PATHS_MUST_BE_ABSOLUTE');
    await mkdir(options.profileRoot, { recursive: true });
    return new BrowserAdapter(options.executable, options.profileRoot, options.networkPolicy);
  }

  private async authorizeUrl(raw: string): Promise<URL> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('BROWSER_INVALID_URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('BROWSER_PROTOCOL_DENIED');
    if (privateAddress(url.hostname) && !(await this.networkPolicy?.(url))) throw new Error('BROWSER_PRIVATE_EGRESS_DENIED');
    if (this.networkPolicy && !(await this.networkPolicy(url))) throw new Error('BROWSER_EGRESS_DENIED');
    return url;
  }

  private owned(id: string, context: BrowserContext): Session {
    const session = this.sessions.get(id);
    if (!session || !sameContext(session.context, context)) throw new Error('BROWSER_SESSION_NOT_OWNED');
    return session;
  }

  async handle(name: string, args: Record<string, unknown>, context: BrowserContext): Promise<unknown> {
    if (!this.implementedTools.has(name)) throw new Error('UNKNOWN_BROWSER_OPERATION');
    if (!context.ownerId || !context.deviceId || !context.executorId) throw new Error('BROWSER_CONTEXT_REQUIRED');
    if (name === 'hostdeck_browser_open') {
      const sessionId = args.session_id;
      if (typeof sessionId !== 'number') throw new Error('BROWSER_INVALID_SESSION');
      if (context.sessionIds ? !context.sessionIds.includes(sessionId) : context.sessionId !== sessionId) throw new Error('BROWSER_SESSION_NOT_OWNED');
      if(typeof args.url==='string')await this.authorizeUrl(args.url);
      const id = `b_${randomBytes(18).toString('base64url')}`;
      const profile = await mkdtemp(path.join(this.profileRoot, 'hostdeck-'));
      let browser:Browser|undefined;
      let stage:'start'|'page'|'navigate'='start';
      try {
        browser = await puppeteer.launch({ executablePath: this.executable, headless: true, userDataDir: profile, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check'], timeout: 15_000 });
        stage='page';
        const page = await browser.newPage();
        const record: Session = { browser, page, profile, context: { ...copyContext(context), sessionIds: context.sessionIds ? [...context.sessionIds] : undefined, sessionId }, generation: 0, elements: new Map() };
        this.sessions.set(id, record);
        stage='navigate';
        if (typeof args.url === 'string') await this.navigate(record, args.url);
        return { browser_id: id, generation: record.generation, ...(page.url() !== 'about:blank' ? { url: page.url() } : {}) };
      } catch (error) {
        this.sessions.delete(id);
        await browser?.close().catch(()=>{});
        if(path.dirname(profile)===this.profileRoot)await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
        if(error instanceof Error&&/^BROWSER_[A-Z_]+$/.test(error.message))throw error;
        throw new Error(stage==='start'?'BROWSER_START_FAILED':stage==='page'?'BROWSER_PAGE_FAILED':'BROWSER_NAVIGATION_FAILED');
      }
    }
    const id = args.browser_id;
    if (typeof id !== 'string') throw new Error('BROWSER_INVALID_ID');
    const session = this.owned(id, context);
    if (name === 'hostdeck_browser_close') {
      this.sessions.delete(id);
      await session.browser.close();
      if (path.dirname(session.profile) === this.profileRoot) await rm(session.profile, { recursive: true, force: true });
      return { closed: true };
    }
    if (name === 'hostdeck_browser_navigate') {
      if (typeof args.url !== 'string') throw new Error('BROWSER_INVALID_URL');
      await this.navigate(session, args.url);
      return { url: session.page.url(), generation: session.generation };
    }
    if (name === 'hostdeck_browser_snapshot') return this.snapshot(session);
    if (name === 'hostdeck_browser_evaluate') {
      if (typeof args.expression !== 'string' || args.expression.length > 100_000) throw new Error('BROWSER_INVALID_EXPRESSION');
      return { value: await session.page.evaluate(expression => (0, eval)(expression), args.expression), generation: session.generation };
    }
    if (name === 'hostdeck_browser_interact') return this.interact(session, args);
    throw new Error('UNKNOWN_BROWSER_OPERATION');
  }

  private async navigate(session: Session, raw: string): Promise<void> {
    const target = await this.authorizeUrl(raw);
    await session.page.setRequestInterception(true);
    const listener = (request: import('puppeteer-core').HTTPRequest) => {
      void (async () => {
        try {
          const url = new URL(request.url());
          if (!['http:', 'https:', 'data:', 'blob:', 'about:'].includes(url.protocol)) return await request.abort('blockedbyclient');
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            if (privateAddress(url.hostname) && !(await this.networkPolicy?.(url))) return await request.abort('blockedbyclient');
            if (this.networkPolicy && !(await this.networkPolicy(url))) return await request.abort('blockedbyclient');
          }
          await request.continue();
        } catch { await request.abort('blockedbyclient').catch(() => undefined); }
      })();
    };
    session.page.on('request', listener);
    try { await session.page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20_000 }); }
    finally { session.page.off('request', listener); await session.page.setRequestInterception(false).catch(() => undefined); }
    session.generation++;
    session.elements.clear();
  }

  private async snapshot(session: Session): Promise<unknown> {
    const elements = await session.page.$$eval('a,button,input,textarea,select,[role],[tabindex]', nodes => nodes.slice(0, 300).map((element, index) => {
      const el = element as HTMLElement; el.dataset.hostdeckSnapshotIndex = String(index);
      return { index, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), label: el.getAttribute('aria-label') || el.innerText?.trim().slice(0, 200) || (el as HTMLInputElement).placeholder || '', text: el.innerText?.trim().slice(0, 300) || '' };
    }));
    session.elements.clear();
    const result = elements.map(item => {
      const ref = `e_${randomBytes(12).toString('base64url')}`;
      session.elements.set(ref, { generation: session.generation, selector: `[data-hostdeck-snapshot-index="${item.index}"]` });
      return { ...item, element_ref: ref };
    });
    return { url: session.page.url(), title: await session.page.title(), generation: session.generation, elements: result };
  }

  private async interact(session: Session, args: Record<string, unknown>): Promise<unknown> {
    const ref = args.element_ref;
    const action = args.action as Record<string, unknown> | undefined;
    if (typeof ref !== 'string' || !action || typeof action.kind !== 'string') throw new Error('BROWSER_INVALID_ACTION');
    const element = session.elements.get(ref);
    if (!element || element.generation !== session.generation) throw new Error('BROWSER_STALE_ELEMENT');
    const target = session.page.locator(element.selector);
    const kind = action.kind;
    if (kind === 'click') await target.click();
    else if (kind === 'hover') await target.hover();
    else if (kind === 'fill' && typeof action.value === 'string') await target.fill(action.value);
    else if (kind === 'select' && typeof action.value === 'string') await session.page.select(element.selector, action.value);
    else if (kind === 'press' && typeof action.key === 'string') { await target.click(); await session.page.keyboard.press(action.key as KeyInput); }
    else throw new Error('BROWSER_ACTION_UNSUPPORTED');
    if (kind === 'click') { session.generation++; session.elements.clear(); }
    return { ok: true, generation: session.generation };
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]; this.sessions.clear();
    await Promise.allSettled(sessions.map(async session => { await session.browser.close(); if (path.dirname(session.profile) === this.profileRoot) await rm(session.profile, { recursive: true, force: true }); }));
  }
}
