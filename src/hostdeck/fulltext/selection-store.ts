import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as fsFlags} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {normalizeConfig, safeRealpath} from './policy.js';
import type {FullTextConfig,FullTextPrincipal,FullTextFormat} from './types.js';

const ident=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const owner=z.object({ownerId:ident,deviceId:ident,executorId:ident}).strict();
const format=z.enum(['.txt','.md','.csv','.json','.docx','.xlsx','.pdf']);
const selectionSchema=z.object({
  version:z.literal(1),owner,
  selection:z.object({
    roots:z.array(z.string().min(1).max(4096)).max(128),
    excludedRoots:z.array(z.string().min(1).max(4096)).max(256).optional(),
    fixedVolumeRoots:z.array(z.string().min(1).max(4096)).max(8).optional(),
    formats:z.array(format).max(7),
    includeHidden:z.boolean().optional(),
    budgets:z.record(z.number().int().positive()).optional(),
  }).strict(),
}).strict();
const approvalSchema=z.object({
  version:z.literal(1),owner,configDigest:z.string().regex(/^[a-f0-9]{64}$/),
  approvalId:z.string().uuid(),approvedAt:z.string().datetime({offset:true}),
  source:z.literal('protected-local-owner-approval'),
}).strict();
type Selection=z.infer<typeof selectionSchema>;
type Approval=z.infer<typeof approvalSchema>;
const CANDIDATE_SIZE=32_768;

function sameOwner(actual:Selection['owner'],c:FullTextPrincipal):boolean{
  return actual.ownerId===c.ownerId&&actual.deviceId===c.deviceId&&actual.executorId===c.executorId;
}
function equalPath(a:string,b:string):boolean{
  return process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
}

/**
 * Protected state-directory reader. It is intentionally READ ONLY: no MCP
 * operation creates selection, grants, approval or any implicit index root.
 * Owner approvals must be written by a separately authorized protected local
 * setup path and independently bound to the full normalized config digest.
 *
 * A JSON record is not a cryptographic substitute for protected OS ACLs.
 * The coordinator must qualify state-directory ACLs before enabling scopes.
 */
/** Native verifier must check effective Windows ACL of the protected files,
 * EVERY replaceable ancestor (DELETE_CHILD/rename), and user-token rights.
 * A JSON literal, MCP boolean or source-level string is not that proof.
 * The current production host does not provide such a verifier: dormant.
 */
export type FullTextProtectedAclVerifier = (paths:Readonly<{
  protectedDirectory:string;
  selectionFile:string;
  approvalFile:string;
  indexDirectory:string;
}>)=>Promise<void>;

export class FullTextSelectionStore {
  readonly selectionFile:string;
  readonly approvalFile:string;
  constructor(
    readonly protectedDirectory:string,
    private readonly workspace:string,
    readonly indexDirectory:string,
    private readonly verifiedEffectiveAcl?:FullTextProtectedAclVerifier,
  ){
    if(!path.isAbsolute(protectedDirectory)||!path.isAbsolute(workspace)||!path.isAbsolute(indexDirectory))
      throw new Error('FULLTEXT_PROTECTED_PATH_INVALID');
    const normalizedWorkspace=path.resolve(workspace),config=path.resolve(protectedDirectory);
    const index=path.resolve(indexDirectory);
    const inside=(a:string,b:string)=>{
      const rel=path.relative(a,b);
      return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));
    };
    if(inside(normalizedWorkspace,config)||inside(normalizedWorkspace,index))
      throw new Error('FULLTEXT_STATE_INSIDE_WORKSPACE');
    // Owner records and ordinary-writable SQLite index/WAL/lock MUST be in
    // disjoint directory trees. A shared ancestor requires ACL verification.
    if(inside(config,index)||inside(index,config))
      throw new Error('FULLTEXT_OWNER_CONFIG_INDEX_OVERLAP');
    this.selectionFile=path.join(protectedDirectory,'fulltext-selection.json');
    this.approvalFile=path.join(protectedDirectory,'fulltext-approval.json');
  }

  private async qualified():Promise<boolean>{
    if(!this.verifiedEffectiveAcl)return false; // production fail-closed
    await this.verifiedEffectiveAcl({
      protectedDirectory:this.protectedDirectory,
      selectionFile:this.selectionFile,approvalFile:this.approvalFile,
      indexDirectory:this.indexDirectory,
    });
    return true;
  }

  expectedIndexFile(c:FullTextPrincipal):string{
    if(!c?.ownerId||!c.deviceId||!c.executorId)throw new Error('FULLTEXT_IDENTITY_REQUIRED');
    const token=createHash('sha256').update(JSON.stringify([c.ownerId,c.deviceId,c.executorId])).digest('hex').slice(0,24);
    return path.join(this.indexDirectory,'fulltext-'+token+'.sqlite');
  }

  private async read(file:string):Promise<unknown|null>{
    let fd:Awaited<ReturnType<typeof fs.open>>|undefined;
    try{
      await safeRealpath(this.protectedDirectory);
      await safeRealpath(file); // no junction, ADS, symlink or alias
      fd=await fs.open(file,fsFlags.O_RDONLY|(fsFlags.O_NOFOLLOW??0));
      const st=await fd.stat();
      if(!st.isFile()||st.size>CANDIDATE_SIZE||st.size===0)throw new Error('FULLTEXT_PROTECTED_CONFIG_INVALID');
      return JSON.parse(await fd.readFile('utf8'));
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw new Error('FULLTEXT_PROTECTED_CONFIG_INVALID');
    }finally{await fd?.close();}
  }

  async selected(c:FullTextPrincipal):Promise<FullTextConfig|null>{
    if(!await this.qualified())return null;
    const source=await this.read(this.selectionFile);
    if(source===null)return null;
    const parsed=selectionSchema.safeParse(source);
    if(!parsed.success)throw new Error('FULLTEXT_PROTECTED_CONFIG_INVALID');
    if(!sameOwner(parsed.data.owner,c))return null;
    const config:FullTextConfig={
      indexFile:this.expectedIndexFile(c),roots:parsed.data.selection.roots,
      formats:parsed.data.selection.formats as FullTextFormat[],
      ...(parsed.data.selection.excludedRoots===undefined?{}:{excludedRoots:parsed.data.selection.excludedRoots}),
      ...(parsed.data.selection.fixedVolumeRoots===undefined?{}:{fixedVolumeRoots:parsed.data.selection.fixedVolumeRoots}),
      ...(parsed.data.selection.includeHidden===undefined?{}:{includeHidden:parsed.data.selection.includeHidden}),
      ...(parsed.data.selection.budgets===undefined?{}:{budgets:parsed.data.selection.budgets}),
    };
    // Also enforces selected fixed volumes/exclusions and bounded resource
    // budgets before any filesystem index is opened.
    normalizeConfig(config);
    return config;
  }

  async confirmed(c:FullTextPrincipal,digest:string):Promise<boolean>{
    if(!await this.qualified())return false;
    const config=await this.selected(c);
    if(!config)return false;
    if(normalizeConfig(config).digest!==digest)return false;
    const value=await this.read(this.approvalFile);
    if(value===null)return false;
    const approval=approvalSchema.safeParse(value);
    if(!approval.success)throw new Error('FULLTEXT_PROTECTED_CONFIG_INVALID');
    if(!sameOwner(approval.data.owner,c))return false;
    if(approval.data.configDigest!==digest)return false;
    const stamp=Date.parse(approval.data.approvedAt);
    // An explicitly owner-written local approval can be revoked by removing
    // this protected record. Never infer approval from an MCP caller boolean.
    return Number.isFinite(stamp)&&stamp<=Date.now();
  }
}
