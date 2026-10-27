import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as fsFlags} from 'node:fs';
import type {Adapter} from '../gateway.js';
import type {FullTextNativeBridge} from '../fulltext-native-bridge.js';
import type {ExecutionContext} from '../security.js';
import {FullTextPort,FULLTEXT_PROVIDER_ID,FULLTEXT_ENGINE_ID} from './wiring.js';
import {FullTextSelectionStore,type FullTextProtectedAclVerifier} from './selection-store.js';
import {safeRealpath,within} from './policy.js';
import type {FullTextCheck,FullTextPrincipal,FullTextAction} from './types.js';

const TOOLS=[
  'hostdeck_fulltext_preview','hostdeck_fulltext_status','hostdeck_fulltext_confirm',
  'hostdeck_fulltext_start','hostdeck_fulltext_step','hostdeck_fulltext_query',
  'hostdeck_fulltext_pause','hostdeck_fulltext_resume','hostdeck_fulltext_cancel',
] as const;
const READ_ACTIONS=new Set<FullTextAction>(['preview','search','snippet','metadata','status']);
const READ_CONTRACT='hostdeck_fulltext_query';
const INDEX_CONTRACT='hostdeck_fulltext_start';
function equalPath(a:string,b:string):boolean{
  const left=path.resolve(a),right=path.resolve(b);
  return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
}
function p(context:ExecutionContext):FullTextPrincipal{
  // No proven multisession read-only sharing or cross-session scan ownership.
  if(context.sessionIds.length!==1||!Number.isSafeInteger(context.sessionIds[0])||context.sessionIds[0]<1)
    throw new Error('FULLTEXT_SESSION_UNQUALIFIED');
  return {ownerId:context.ownerId,deviceId:context.deviceId,executorId:context.executorId,
    sessionId:context.sessionIds[0]};
}
type Reauthorize=(name:string,args:Readonly<Record<string,unknown>>)=>Promise<void>;

export interface FullTextAdapterOptions{
  stateDirectory:string;
  workspace:string;
  /** Admin/SYSTEM-owned config/approval directory, disjoint from SQLite. */
  protectedOwnerDirectory?:string;
  /** Mandatory trusted native effective-ACL verifier. NOT a caller boolean. */
  verifyProtectedOwnerAcl?:FullTextProtectedAclVerifier;
  /** PR22 persistent native metadata bridge; no attrib.exe or synthetic fallback. */
  nativeAttributes?:Pick<FullTextNativeBridge,'attributes'>;
  /** Must be bound to HostDeckFacade.reauthorize and active ALS context. */
  reauthorize:Reauthorize;
  /** Optional MORE restrictive local policy; true never bypasses native checks. */
  additionalReadDeny?:(check:FullTextCheck)=>Promise<boolean>;
}

/**
 * MCP-facing, dormant-by-default full-text adapter. Never adds roots, creates
 * approval files or opens a DB until an owner-approved confirm call.
 */
export class FullTextAdapter implements Adapter {
  readonly implementedTools:ReadonlySet<string>=new Set(TOOLS);
  readonly store:FullTextSelectionStore;
  private readonly port:FullTextPort;
  constructor(private readonly options:FullTextAdapterOptions){
    this.store=new FullTextSelectionStore(
      options.protectedOwnerDirectory??
        path.join(path.dirname(options.stateDirectory),'FullTextOwnerProtection-Unqualified'),
      options.workspace,options.stateDirectory,options.verifyProtectedOwnerAcl,
    );
    this.port=new FullTextPort({
      loadSelectedConfig:c=>this.store.selected(c),
      isOwnerConfirmed:(c,digest)=>this.store.confirmed(c,digest),
      authorize:request=>this.authorized(request),
      nativeAttributes:options.nativeAttributes
        ? (paths,principal,root,action)=>options.nativeAttributes!.attributes(paths,
            async file=>{
              // The native worker never grants permissions. Verify current
              // PolicyGate AND selected root/file rights for each batch member.
              try{return await this.authorized({principal,root,path:file,action});}
              catch{return false;}
            })
        : undefined,
    });
  }

  private async pathReadable(candidate:string,requireFile=false):Promise<void>{
    const canonical=await safeRealpath(candidate);
    const stat=await fs.lstat(canonical);
    if(stat.isDirectory()){
      if(requireFile)throw new Error('FULLTEXT_DENIED');
      // A real directory handle checks the current Windows user token.
      const dir=await fs.opendir(canonical);await dir.close();return;
    }
    if(!stat.isFile())throw new Error('FULLTEXT_DENIED');
    const fd=await fs.open(canonical,fsFlags.O_RDONLY|(fsFlags.O_NOFOLLOW??0));
    await fd.close();
  }

  private async authorized(req:FullTextCheck):Promise<boolean>{
    // Nested PolicyGate check under the current gateway request, not a
    // caller-provided boolean or a cached grant. Revision must be unchanged.
    const operation=READ_ACTIONS.has(req.action)?READ_CONTRACT:INDEX_CONTRACT;
    await this.options.reauthorize(operation,{device_id:req.principal.deviceId});
    const selected=await this.store.selected(req.principal);
    if(!selected)throw new Error('FULLTEXT_DENIED');
    if(await this.options.additionalReadDeny?.(req)===true)throw new Error('FULLTEXT_DENIED');

    const index=this.store.expectedIndexFile(req.principal);
    if(req.action==='preview' && equalPath(req.root,index)&&equalPath(req.path,index)){
      await this.pathReadable(this.options.stateDirectory);return true;
    }
    if(req.action==='storage'){
      if(!equalPath(req.root,this.options.stateDirectory) ||
        ![index,index+'.writerlock.sqlite'].some(item=>equalPath(item,req.path)))
        throw new Error('FULLTEXT_DENIED');
      await this.pathReadable(this.options.stateDirectory);
      await fs.access(this.options.stateDirectory,fsFlags.W_OK);
      return true;
    }

    // No source path is authorized by the indexFile being authorized.
    if(!selected.roots.some(root=>equalPath(root,req.root)))throw new Error('FULLTEXT_DENIED');
    await this.pathReadable(req.root);
    if(!within(req.root,req.path))throw new Error('FULLTEXT_DENIED');
    if(equalPath(req.root,req.path))return true;
    try{await this.pathReadable(req.path,req.action==='metadata'||req.action==='snippet'||req.action==='index');}
    catch(error){
      const missing=(error as NodeJS.ErrnoException)?.code==='ENOENT';
      // An actual missing file can only be handled for index maintenance
      // (delete/rename), not exposed as a matching snippet or metadata.
      if(!missing||req.action!=='index')throw new Error('FULLTEXT_DENIED');
      await this.pathReadable(path.dirname(req.path));
    }
    return true;
  }

  async handle(name:string,args:Record<string,unknown>,context:ExecutionContext):Promise<unknown>{
    const principal=p(context);
    switch(name){
      case 'hostdeck_fulltext_preview':
        return this.port.preview(principal);
      case 'hostdeck_fulltext_status':{
        if(!await this.store.selected(principal))return {
          state:'unconfigured',provider:FULLTEXT_PROVIDER_ID,engine:FULLTEXT_ENGINE_ID,
          configured:false,actualFreshness:'not_monitored',
        };
        // Do not expose roots/counts from a not-yet confirmed connection.
        try{return await this.port.status(principal);}
        catch(error){
          if(error instanceof Error&&error.message==='FULLTEXT_NOT_CONFIGURED')return {
            state:'selected_not_active',provider:FULLTEXT_PROVIDER_ID,engine:FULLTEXT_ENGINE_ID,
            configured:true,actualFreshness:'not_monitored',
          };
          throw error;
        }
      }
      case 'hostdeck_fulltext_confirm':
        return {...await this.port.confirm(principal,String(args.digest)),engine:FULLTEXT_ENGINE_ID};
      case 'hostdeck_fulltext_start':
        return this.port.start(principal);
      case 'hostdeck_fulltext_step':
        return this.port.step(principal,String(args.run_id),Number(args.max_operations));
      case 'hostdeck_fulltext_query':
        return this.port.query(principal,String(args.query),Number(args.limit));
      case 'hostdeck_fulltext_pause':
        await this.port.pause(principal,String(args.run_id));return {state:'paused',run_id:args.run_id};
      case 'hostdeck_fulltext_resume':
        await this.port.resume(principal,String(args.run_id));return {state:'running',run_id:args.run_id};
      case 'hostdeck_fulltext_cancel':
        await this.port.cancel(principal,String(args.run_id));return {state:'cancelled',run_id:args.run_id};
      default:throw new Error('FULLTEXT_OPERATION_UNAVAILABLE');
    }
  }
  close():void{this.port.close();}
}
