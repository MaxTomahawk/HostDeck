import { FullTextEngine } from './engine.js';
import type {FullTextAttributeProbe} from './native-attributes.js';
import type {
  FullTextAuthorizer, FullTextConfig, FullTextPreview, FullTextPrincipal,
  FullTextScanReceipt, FullTextSearchPage,
} from './types.js';

/**
 * Isolated facade/provider port. Deliberately NOT registered in existing
 * Everything/file contracts or the MCP gateway. The integrating HostDeck
 * facade must supply a live PolicyGate-backed authorizer on EVERY call.
 */
// Public manager-compatible ID; internal engine identity is versioned separately.
export const FULLTEXT_PROVIDER_ID = 'fulltext_sqlite';
export const FULLTEXT_ENGINE_ID = 'local.sqlite-fts5.document-content.v1';

export interface FullTextPortWiring {
  /** Trusted protected local settings; null until actual roots are selected. */
  loadSelectedConfig: (principal: FullTextPrincipal) => Promise<FullTextConfig | null>;
  /** Independent proof of an owner-approved exact digest, not caller truth. */
  isOwnerConfirmed: (principal: FullTextPrincipal, digest: string) => Promise<boolean>;
  /** Checks fresh device/executor and root/file privileges per operation. */
  authorize: FullTextAuthorizer;
  /** Optional at construction; REQUIRED for Windows activation (no attrib fallback). */
  nativeAttributes?: FullTextAttributeProbe;
}

type DrivenState='scheduled'|'running'|'paused'|'resource_paused'|'cancelled'|'complete'|'interrupted';
interface DrivenRun {
  runId:string;
  principal:FullTextPrincipal;
  state:DrivenState;
  stopped:boolean;
  steps:number;
  processed:number;
  lastCode?:string;
}
function safeDriverCode(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  if (/^FULLTEXT_[A-Z_]+$/.test(message))return message;
  return 'FULLTEXT_DRIVER_AUTHORIZATION_OR_RUNTIME_LOST';
}

export class FullTextPort {
  readonly providerId = FULLTEXT_PROVIDER_ID;
  private engine?: FullTextEngine;
  private activePrincipal?: string;
  private activeDigest?: string;
  private readonly stepLane: {tail:Promise<void>}={tail:Promise.resolve()};
  private driver?:DrivenRun;
  private closed=false;
  constructor(private readonly wiring: FullTextPortWiring) {}

  private key(c: FullTextPrincipal): string {
    return JSON.stringify([c.ownerId,c.deviceId,c.executorId,c.sessionId??null]);
  }

  async preview(c: FullTextPrincipal): Promise<FullTextPreview | {configured:false;reason:'ROOTS_NOT_SELECTED'}> {
    const config=await this.wiring.loadSelectedConfig(c);
    if (!config) return {configured:false,reason:'ROOTS_NOT_SELECTED'};
    return FullTextEngine.preview(config,c,this.wiring.authorize);
  }

  async confirm(c: FullTextPrincipal, digest: string): Promise<{ready:true;provider:string}> {
    if(this.closed)throw new Error('FULLTEXT_PORT_CLOSED');
    const config=await this.wiring.loadSelectedConfig(c);
    if (!config || config.roots.length===0) throw new Error('FULLTEXT_ROOTS_NOT_SELECTED');
    const preview=await FullTextEngine.preview(config,c,this.wiring.authorize);
    if (preview.digest!==digest || await this.wiring.isOwnerConfirmed(c,digest)!==true)
      throw new Error('FULLTEXT_OWNER_CONFIRMATION_REQUIRED');
    if (this.engine) throw new Error('FULLTEXT_ALREADY_OPEN');
    this.engine=await FullTextEngine.openConfirmed(config,c,this.wiring.authorize,digest,this.wiring.nativeAttributes);
    this.activePrincipal=this.key(c);
    this.activeDigest=digest;
    // Deliberately no driver launch on confirm, including after process crash.
    return {ready:true,provider:this.providerId};
  }

  private async require(c: FullTextPrincipal): Promise<FullTextEngine> {
    if(this.closed)throw new Error('FULLTEXT_PORT_CLOSED');
    if (!this.engine || this.activePrincipal!==this.key(c) || !this.activeDigest)
      throw new Error('FULLTEXT_NOT_CONFIGURED');
    const config=await this.wiring.loadSelectedConfig(c);
    if (!config) throw new Error('FULLTEXT_OWNER_SELECTION_REVOKED');
    const preview=await FullTextEngine.preview(config,c,this.wiring.authorize);
    if (preview.digest!==this.activeDigest || await this.wiring.isOwnerConfirmed(c,this.activeDigest)!==true)
      throw new Error('FULLTEXT_OWNER_SELECTION_REVOKED');
    return this.engine;
  }

  async start(c:FullTextPrincipal):Promise<{runId:string;state:'running'}> {
    return (await this.require(c)).start(c);
  }

  /**
   * Only the MCP fulltext_start/resume adapter invokes this one-shot driver.
   * Direct engine/port starts stay manual, preserving existing test semantics.
   * No cron, watcher, periodic polling or automatic resume on confirmation.
   */
  async startDriven(c:FullTextPrincipal):Promise<{runId:string;state:'running';driver:'scheduled'}> {
    this.assertNoActiveDriver();
    const started=await this.start(c);
    this.launch(c,started.runId);
    return {...started,driver:'scheduled'};
  }
  async resumeDriven(c:FullTextPrincipal,id:string):Promise<{state:'running';runId:string;driver:'scheduled'}> {
    this.assertNoActiveDriver();
    await this.resume(c,id);
    this.launch(c,id);
    return {state:'running',runId:id,driver:'scheduled'};
  }

  private assertNoActiveDriver():void {
    if(this.closed)throw new Error('FULLTEXT_PORT_CLOSED');
    if(this.driver&&!this.driver.stopped&&['scheduled','running'].includes(this.driver.state))
      throw new Error('FULLTEXT_DRIVER_ALREADY_RUNNING');
  }
  private launch(c:FullTextPrincipal,runId:string):void {
    this.assertNoActiveDriver();
    if(this.driver)this.driver.stopped=true;
    const token:DrivenRun={runId,principal:{...c},state:'scheduled',stopped:false,steps:0,processed:0};
    this.driver=token;
    this.schedule(token);
  }
  private schedule(token:DrivenRun):void {
    if(this.closed||token.stopped||this.driver!==token)return;
    // One immediate continuation for an explicitly started run; no auto-start.
    // ALS request context is inherited, so EVERY step re-enters PolicyGate.
    setImmediate(()=>{if(!this.closed&&!token.stopped&&this.driver===token)
      void this.pump(token);});
  }
  private async pump(token:DrivenRun):Promise<void> {
    if(this.closed||token.stopped||this.driver!==token)return;
    token.state='running';
    try {
      const receipt=await this.step(token.principal,token.runId);
      token.steps++;
      token.processed+=receipt.processedThisStep;
      token.state=receipt.state;
      if(receipt.reason)token.lastCode=receipt.reason;
      if(receipt.state==='running'&&!token.stopped)this.schedule(token);
      else token.stopped=true; // includes complete, resource_paused, pause, cancel
    }catch(error){
      // Authorization/selection loss must never leave an apparently active
      // durable run continuing without a live policy context. This is an
      // owner-scoped, index-only safety transition; NO source path is touched.
      const code=safeDriverCode(error);
      let state='interrupted';
      try{state=this.engine?.interruptDrivenRun(token.principal,token.runId)??state;}
      catch { /* No automatic recovery, no raw error/path disclosure. */ }
      token.lastCode=code;
      token.state=(['complete','cancelled','paused','resource_paused','interrupted'].includes(state)
        ? state:'interrupted') as DrivenState;
      token.stopped=true;
    }
  }

  async step(c:FullTextPrincipal,runId:string,maxOperations?:number):Promise<FullTextScanReceipt> {
    if(this.closed)throw new Error('FULLTEXT_PORT_CLOSED');
    // Shared per-engine serialization: a manual MCP step waits behind the
    // in-flight driver step rather than invoking engine.step concurrently.
    const work=this.stepLane.tail.then(async()=>
      (await this.require(c)).step(c,runId,maxOperations));
    this.stepLane.tail=work.then(()=>undefined,()=>undefined);
    const receipt=await work;
    if(this.driver?.runId===runId&&receipt.state!=='running'){
      this.driver.state=receipt.state;
      this.driver.stopped=true;
      if(receipt.reason)this.driver.lastCode=receipt.reason;
    }
    return receipt;
  }
  async pause(c:FullTextPrincipal,runId:string):Promise<void> {
    await (await this.require(c)).pause(c,runId);
    if(this.driver?.runId===runId){this.driver.stopped=true;this.driver.state='paused';}
  }
  async resume(c:FullTextPrincipal,runId:string):Promise<void> {
    await (await this.require(c)).resume(c,runId);
  }
  async cancel(c:FullTextPrincipal,runId:string):Promise<void> {
    await (await this.require(c)).cancel(c,runId);
    if(this.driver?.runId===runId){this.driver.stopped=true;this.driver.state='cancelled';}
  }
  async query(c:FullTextPrincipal,phrase:string,limit?:number):Promise<FullTextSearchPage> {
    return (await this.require(c)).search(c,phrase,limit);
  }
  async status(c:FullTextPrincipal) {
    const durable=await (await this.require(c)).status(c);
    const current=this.driver?.runId===durable.run?.runId?this.driver:undefined;
    return {...durable,driver:{
      state:current?.state??'inactive',
      runId:current?.runId??null,
      steps:current?.steps??0,
      processedInProcess:current?.processed??0,
      lastCode:current?.lastCode??null,
    }};
  }

  async close():Promise<void> {
    if(this.closed)return;
    this.closed=true;
    if(this.driver)this.driver.stopped=true;
    // Wait for the *same* step lane used by manual+driver operations before
    // releasing writer lock; main awaits this before closing native helper.
    await this.stepLane.tail;
    try{this.engine?.close();}
    finally{this.engine=undefined;this.activePrincipal=undefined;this.activeDigest=undefined;}
  }
}
