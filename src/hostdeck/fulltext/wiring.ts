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

export class FullTextPort {
  readonly providerId = FULLTEXT_PROVIDER_ID;
  private engine?: FullTextEngine;
  private activePrincipal?: string;
  private activeDigest?: string;
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
    const config=await this.wiring.loadSelectedConfig(c);
    if (!config || config.roots.length===0) throw new Error('FULLTEXT_ROOTS_NOT_SELECTED');
    const preview=await FullTextEngine.preview(config,c,this.wiring.authorize);
    if (preview.digest!==digest || await this.wiring.isOwnerConfirmed(c,digest)!==true)
      throw new Error('FULLTEXT_OWNER_CONFIRMATION_REQUIRED');
    if (this.engine) throw new Error('FULLTEXT_ALREADY_OPEN');
    this.engine=await FullTextEngine.openConfirmed(config,c,this.wiring.authorize,digest,this.wiring.nativeAttributes);
    this.activePrincipal=this.key(c);
    this.activeDigest=digest;
    return {ready:true,provider:this.providerId};
  }

  private async require(c: FullTextPrincipal): Promise<FullTextEngine> {
    if (!this.engine || this.activePrincipal!==this.key(c) || !this.activeDigest)
      throw new Error('FULLTEXT_NOT_CONFIGURED');
    const config=await this.wiring.loadSelectedConfig(c);
    if (!config) throw new Error('FULLTEXT_OWNER_SELECTION_REVOKED');
    const preview=await FullTextEngine.preview(config,c,this.wiring.authorize);
    if (preview.digest!==this.activeDigest || await this.wiring.isOwnerConfirmed(c,this.activeDigest)!==true)
      throw new Error('FULLTEXT_OWNER_SELECTION_REVOKED');
    return this.engine;
  }

  async start(c:FullTextPrincipal): Promise<{runId:string;state:'running'}> {
    return (await this.require(c)).start(c);
  }
  async step(c:FullTextPrincipal, runId:string, maxOperations?:number):Promise<FullTextScanReceipt> {
    return (await this.require(c)).step(c,runId,maxOperations);
  }
  async pause(c:FullTextPrincipal, runId:string):Promise<void> {await (await this.require(c)).pause(c,runId);}
  async resume(c:FullTextPrincipal, runId:string):Promise<void> {await (await this.require(c)).resume(c,runId);}
  async cancel(c:FullTextPrincipal, runId:string):Promise<void> {await (await this.require(c)).cancel(c,runId);}
  async query(c:FullTextPrincipal, phrase:string, limit?:number):Promise<FullTextSearchPage> {
    return (await this.require(c)).search(c,phrase,limit);
  }
  async status(c:FullTextPrincipal):ReturnType<FullTextEngine['status']> {
    return (await this.require(c)).status(c);
  }

  close():void {this.engine?.close();this.engine=undefined;this.activePrincipal=undefined;this.activeDigest=undefined;}
}
