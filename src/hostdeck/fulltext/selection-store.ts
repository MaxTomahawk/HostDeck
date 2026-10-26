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
    roots:z.array(z.string().min(1).max(4096)).max(16),
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
export class FullTextSelectionStore {
  readonly selectionFile:string;
  readonly approvalFile:string;
  constructor(readonly stateDirectory:string,private readonly workspace:string){
    if(!path.isAbsolute(stateDirectory)||!path.isAbsolute(workspace))
      throw new Error('FULLTEXT_PROTECTED_PATH_INVALID');
    const relative=path.relative(path.resolve(workspace),path.resolve(stateDirectory));
    if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))
      throw new Error('FULLTEXT_STATE_INSIDE_WORKSPACE');
    this.selectionFile=path.join(stateDirectory,'fulltext-selection.json');
    this.approvalFile=path.join(stateDirectory,'fulltext-approval.json');
  }

  expectedIndexFile(c:FullTextPrincipal):string{
    if(!c?.ownerId||!c.deviceId||!c.executorId)throw new Error('FULLTEXT_IDENTITY_REQUIRED');
    const token=createHash('sha256').update(JSON.stringify([c.ownerId,c.deviceId,c.executorId])).digest('hex').slice(0,24);
    return path.join(this.stateDirectory,'fulltext-'+token+'.sqlite');
  }

  private async read(file:string):Promise<unknown|null>{
    let fd:Awaited<ReturnType<typeof fs.open>>|undefined;
    try{
      await safeRealpath(this.stateDirectory);
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
    const source=await this.read(this.selectionFile);
    if(source===null)return null;
    const parsed=selectionSchema.safeParse(source);
    if(!parsed.success)throw new Error('FULLTEXT_PROTECTED_CONFIG_INVALID');
    if(!sameOwner(parsed.data.owner,c))return null;
    const config:FullTextConfig={
      indexFile:this.expectedIndexFile(c),roots:parsed.data.selection.roots,
      formats:parsed.data.selection.formats as FullTextFormat[],
      ...(parsed.data.selection.includeHidden===undefined?{}:{includeHidden:parsed.data.selection.includeHidden}),
      ...(parsed.data.selection.budgets===undefined?{}:{budgets:parsed.data.selection.budgets}),
    };
    // Also enforces explicit non-volume roots, index/corpus separation and
    // boundable budgets before any filesystem index is opened.
    normalizeConfig(config);
    return config;
  }

  async confirmed(c:FullTextPrincipal,digest:string):Promise<boolean>{
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
