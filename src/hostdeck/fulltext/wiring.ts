import { FullTextEngine } from './engine.js';
import type {
  FullTextAuthorizer, FullTextConfig, FullTextPreview, FullTextPrincipal,
  FullTextScanReceipt, FullTextSearchPage,
} from './types.js';

/**
 * Isolated facade/provider port. Deliberately NOT registered in existing
 * Everything/file contracts or the MCP gateway. The integrating HostDeck
 * facade must supply a live PolicyGate-backed authorizer on EVERY call.
 */
export const FULLTEXT_PROVIDER_ID = 'local.sqlite-fts5.document-content.v1';

export interface FullTextPortWiring {
  /** Trusted protected local settings; null until actual roots are selected. */
  loadSelectedConfig: () => Promise<FullTextConfig | null>;
  /** Independent proof of an owner-approved exact digest, not caller truth. */
  isOwnerConfirmed: (principal: FullTextPrincipal, digest: string) => Promise<boolean>;
  /** Checks fresh device/executor and root/file privileges per operation. */
  authorize: FullTextAuthorizer;
}

export class FullTextPort {
  readonly providerId = FULLTEXT_PROVIDER_ID;
  private engine?: FullTextEngine;
  private activePrincipal?: string;
  constructor(private readonly wiring: FullTextPortWiring) {}

  async preview(c: FullTextPrincipal): Promise<FullTextPreview | {configured:false;reason:'ROOTS_NOT_SELECTED'}> {
    const config=await this.wiring.loadSelectedConfig();
    if (!config) return {configured:false,reason:'ROOTS_NOT_SELECTED'};
    return FullTextEngine.preview(config,c,this.wiring.authorize);
  }

  async confirm(c: FullTextPrincipal, digest: string): Promise<{ready:true;provider:string}> {
    const config=await this.wiring.loadSelectedConfig();
    if (!config || config.roots.length===0) throw new Error('FULLTEXT_ROOTS_NOT_SELECTED');
    const preview=await FullTextEngine.preview(config,c,this.wiring.authorize);
    if (preview.digest!==digest || await this.wiring.isOwnerConfirmed(c,digest)!==true)
      throw new Error('FULLTEXT_OWNER_CONFIRMATION_REQUIRED');
    if (this.engine) throw new Error('FULLTEXT_ALREADY_OPEN');
    this.engine=await FullTextEngine.openConfirmed(config,c,this.wiring.authorize,digest);
    this.activePrincipal=JSON.stringify(c);
    return {ready:true,provider:this.providerId};
  }

  private require(c: FullTextPrincipal): FullTextEngine {
    if (!this.engine || this.activePrincipal!==JSON.stringify(c)) throw new Error('FULLTEXT_NOT_CONFIGURED');
    return this.engine;
  }
  start(c:FullTextPrincipal): Promise<{runId:string;state:'running'}> {
    return this.require(c).start(c);
  }
  step(c:FullTextPrincipal, runId:string, maxOperations?:number):Promise<FullTextScanReceipt> {
    return this.require(c).step(c,runId,maxOperations);
  }
  pause(c:FullTextPrincipal, runId:string):Promise<void> {return this.require(c).pause(c,runId);}
  resume(c:FullTextPrincipal, runId:string):Promise<void> {return this.require(c).resume(c,runId);}
  cancel(c:FullTextPrincipal, runId:string):Promise<void> {return this.require(c).cancel(c,runId);}
  query(c:FullTextPrincipal, phrase:string, limit?:number):Promise<FullTextSearchPage> {
    return this.require(c).search(c,phrase,limit);
  }
  status(c:FullTextPrincipal):ReturnType<FullTextEngine['status']> {
    return this.require(c).status(c);
  }

  close():void {this.engine?.close();this.engine=undefined;this.activePrincipal=undefined;}
}
