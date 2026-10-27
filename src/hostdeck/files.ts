import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseToolArguments } from './contracts.js';
import {RuntimeError} from './runtime-error.js';
import type {ProviderRegistry,SearchProvider,SearchCapability} from './providers.js';
import type {EverythingClient} from './everything.js';
import type {ReadRootAccess,ReadRootScope} from './read-root-access.js';
import type {ReadOnlyOperation} from './read-root-boundary.js';

const execFile = promisify(execFileCallback);
const TOOL_NAMES = ['hostdeck_list_directory', 'hostdeck_create_directory', 'hostdeck_move_file', 'hostdeck_delete_path', 'hostdeck_search_files', 'hostdeck_search_results', 'hostdeck_stop_search', 'hostdeck_list_processes','hostdeck_list_providers','hostdeck_set_provider_preference','hostdeck_set_provider_enabled'] as const;
const MAX_TRAVERSAL_ENTRIES = 100_000;
const MAX_SEARCH_MATCHES = 10_000;
const MAX_SEARCH_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_FILE_BYTES = 1024 * 1024;
const SEARCH_RETENTION_MS = 10 * 60_000;

export interface FileOwnerContext { ownerId: string; deviceId: string; executorId: string; revision?:string;sessionId?:number;sessionIds?:readonly number[]; }
export type Reauthorize = (name: string, args: Record<string, unknown>) => Promise<void>;
interface SearchMatch { path: string; kind: 'file' | 'directory' | 'content'; line?: number; text?: string; size?:number;modified?:string;metadata_source?:'filesystem_readback';
  /** Internal only; never serialize this with public result-page items. */
  privateIdentity?:{dev:string;ino:string;mtimeNs:string;size:string};
}
interface SearchJob {
  id: string; owner: FileOwnerContext; root: string; pattern: string; mode: 'files' | 'content'; regex?: RegExp;
  includeHidden: boolean; deadline: number; resultLimit: number; matches: SearchMatch[]; bytes: number;
  visited: number; truncated: boolean; done: boolean; stopped: boolean; error?: string; startedAt: number; touchedAt: number;
  provider:SearchProvider; entryType:'files'|'directories'|'all'; sort?:'path'|'name'; metadata:boolean; abort:AbortController;
  provenance?:{version:string;instance:string;session_id:number;runtime_id:string};
  coverageTruncated:boolean;rootIsFile:boolean;readScope?:ReadRootScope;
}
interface FileOptions {workspace:string;reauthorize?:Reauthorize;providers?:ProviderRegistry;everything?:Pick<EverythingClient,'status'|'query'|'sessionId'>;readRoots?:ReadRootAccess;}

function inside(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isReparseOrLink(stat: import('node:fs').Stats): boolean { return stat.isSymbolicLink(); }

function ownerMatches(a: FileOwnerContext, b: FileOwnerContext): boolean {
  return a.ownerId === b.ownerId && a.deviceId === b.deviceId && a.executorId === b.executorId;
}

function safePattern(pattern: string, literal: boolean): RegExp {
  if (pattern.length > 256) throw new RuntimeError('SEARCH_PATTERN_LIMIT');
  if (literal) return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  // Avoid quantified groups, alternation and nested/overlapping quantifiers that can stall the service.
  if (/[?*+{}()|]/.test(pattern) || /\\[1-9]/.test(pattern)) throw new RuntimeError('SEARCH_REGEX_FEATURE_DENIED');
  try { return new RegExp(pattern, 'i'); } catch { throw new RuntimeError('SEARCH_PATTERN_INVALID'); }
}

function visibleName(name: string, includeHidden: boolean): boolean { return includeHidden || !name.startsWith('.'); }
function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

export class FileAdapter {
  readonly implementedTools = new Set<string>(TOOL_NAMES);
  private readonly searches = new Map<string, SearchJob>();
  private constructor(private readonly workspace: string, private readonly reauthorize?: Reauthorize,private readonly options?:FileOptions) {}

  static async create(options: FileOptions): Promise<FileAdapter> {
    if (!path.isAbsolute(options.workspace)) throw new Error('FILES_WORKSPACE_MUST_BE_ABSOLUTE');
    await fs.mkdir(options.workspace, { recursive: true });
    return new FileAdapter(await fs.realpath(options.workspace), options.reauthorize,options);
  }

  private async guardPath(input: unknown, allowMissing = false): Promise<{ absolute: string; stat?: import('node:fs').Stats }> {
    if (typeof input !== 'string' || !input.trim()) throw new Error('FILES_PATH_INVALID');
    const absolute = path.resolve(path.isAbsolute(input) ? input : path.join(this.workspace, input));
    if (!inside(this.workspace, absolute)) throw new Error('FILES_PATH_OUTSIDE_WORKSPACE');
    const relative = path.relative(this.workspace, absolute);
    if (relative.split(path.sep).some(part => part.includes(':'))) throw new Error('FILES_ALTERNATE_STREAM_DENIED');
    let cursor = this.workspace;
    const parts = relative ? relative.split(path.sep) : [];
    let lastStat: import('node:fs').Stats | undefined;
    if (parts.length === 0) lastStat = await fs.lstat(this.workspace);
    for (let index = 0; index < parts.length; index++) {
      cursor = path.join(cursor, parts[index]);
      let current: import('node:fs').Stats;
      try { current = await fs.lstat(cursor); }
      catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { absolute };
        throw error;
      }
      if (isReparseOrLink(current)) throw new Error('FILES_REPARSE_POINT_DENIED');
      lastStat = current;
    }
    if (allowMissing && !lastStat) return { absolute };
    const canonical = await fs.realpath(absolute);
    if (!inside(this.workspace, canonical)) throw new Error('FILES_PATH_OUTSIDE_WORKSPACE');
    return { absolute: canonical, stat: lastStat };
  }

  /** Read authority is additive and external-only; all write guards stay unmodified. */
  private async guardReadPath(input: unknown, context: FileOwnerContext,
    operation: ReadOnlyOperation): Promise<{absolute:string;stat:import('node:fs').Stats;
      readScope?:ReadRootScope}> {
    if(typeof input!=='string'||!input.trim())throw new RuntimeError('FILES_PATH_INVALID');
    const target=path.resolve(this.workspace,input);
    if(inside(this.workspace,target)){
      const baseline=await this.guardPath(input);
      if(!baseline.stat)throw new RuntimeError('FILES_PATH_INVALID');
      return {absolute:baseline.absolute,stat:baseline.stat};
    }
    const access=this.options?.readRoots;
    if(!access)throw new RuntimeError('FILES_PATH_OUTSIDE_WORKSPACE');
    const candidate=await access.resolve(input,context,operation);
    if(!candidate.external||!candidate.rootIdentity||!candidate.revision||!candidate.digest)
      throw new RuntimeError('READ_ROOT_DENIED');
    const scope=candidate as ReadRootScope;
    const observed=await access.metadata(scope,context,operation);
    const stat=await fs.lstat(scope.absolute);
    if((observed.isFile!==stat.isFile())||(observed.isDirectory!==stat.isDirectory()))
      throw new RuntimeError('READ_ROOT_CHANGED');
    return {absolute:scope.absolute,stat,readScope:scope};
  }

  private displayRead(value:string,scope?:ReadRootScope):string{
    return scope?.external?value:this.relative(value);
  }

  private relative(value: string): string {
    const rel = path.relative(this.workspace, value);
    return rel || '.';
  }

  private async authorize(name: string, args: Record<string, unknown>): Promise<void> { await this.reauthorize?.(name, args); }

  async handle(name: string, rawArgs: Record<string, unknown>, context: FileOwnerContext): Promise<unknown> {
    if (!this.implementedTools.has(name)) throw new Error('UNKNOWN_FILE_OPERATION');
    if (!context?.ownerId || !context.deviceId || !context.executorId) throw new Error('FILES_OWNER_CONTEXT_REQUIRED');
    const args = parseToolArguments(name, rawArgs);
    if (args.device_id !== context.deviceId) throw new Error('FILES_DEVICE_CONTEXT_MISMATCH');
    switch (name) {
      case 'hostdeck_list_directory': return this.listDirectory(args,context);
      case 'hostdeck_create_directory': return this.createDirectory(name, args);
      case 'hostdeck_move_file': return this.moveFile(name, args);
      case 'hostdeck_delete_path': return this.deletePath(name, args);
      case 'hostdeck_search_files': return this.startSearch(args, context);
      case 'hostdeck_search_results': return this.searchResults(args, context);
      case 'hostdeck_stop_search': return this.stopSearch(args, context);
      case 'hostdeck_list_processes': return this.listProcesses(args);
      case 'hostdeck_list_providers': {
        await this.authorize(name,args);
        const result=await this.listProviders(context);
        await this.authorize(name,args);
        return result;
      }
      case 'hostdeck_set_provider_enabled': {
        if(!this.options?.providers)throw new RuntimeError('PROVIDER_CONFIGURATION_UNAVAILABLE');
        if(!this.reauthorize)throw new RuntimeError('DENIED');
        await this.authorize(name,args);
        await this.options.providers.setEnabled(context,args.provider as SearchProvider,args.enabled as boolean|null);
        if(args.enabled===false)for(const job of this.searches.values())if(job.provider==='everything'&&ownerMatches(job.owner,context))this.disableSearch(job);
        return {provider:args.provider,enabledOverride:args.enabled,desiredEnabled:args.enabled??true,scope:'owner_device_executor',updated:true};
      }
      case 'hostdeck_set_provider_preference': {
        if(!this.options?.providers)throw new RuntimeError('PROVIDER_CONFIGURATION_UNAVAILABLE');
        if(!this.reauthorize)throw new RuntimeError('DENIED');
        await this.authorize(name,args);
        await this.options.providers.set(context,args.capability as SearchCapability,args.provider as SearchProvider|null);
        return {capability:args.capability,preference:args.provider,scope:'owner_device_function',updated:true};
      }
      default: throw new Error('UNKNOWN_FILE_OPERATION');
    }
  }

  private async listDirectory(args: Record<string, unknown>,
    context: FileOwnerContext): Promise<unknown> {
    if(path.isAbsolute(args.path as string) &&
        !inside(this.workspace,path.resolve(args.path as string)))
      await this.authorize('hostdeck_list_directory',args);
    const base=await this.guardReadPath(args.path,context,'list_directory');
    if(!base.stat.isDirectory())throw new RuntimeError('FILES_NOT_A_DIRECTORY');
    const depth=args.depth as number,limit=args.limit as number;
    const deadline=Date.now()+3000;
    const results:Array<Record<string,unknown>>=[];
    const queue:Array<{dir:string;level:number}>=[{dir:base.absolute,level:0}];
    let visited=0,skippedLinks=0,outputBytes=0,truncated=false;
    while(queue.length){
      if(Date.now()>=deadline||visited>=MAX_TRAVERSAL_ENTRIES||results.length>=limit){
        truncated=true;break;
      }
      const current=queue.shift()!;
      const guarded=await this.guardReadPath(current.dir,context,'list_directory');
      if(!guarded.stat.isDirectory())continue;
      if(base.readScope&&(!guarded.readScope||
          guarded.readScope.digest!==base.readScope.digest||
          guarded.readScope.revision!==base.readScope.revision))
        throw new RuntimeError('READ_ROOT_REVOKED');
      const scan=async(directory:AsyncIterable<{name:string}>):Promise<void>=>{
        for await(const entry of directory){
          if(Date.now()>=deadline||visited>=MAX_TRAVERSAL_ENTRIES||results.length>=limit){
            truncated=true;break;
          }
          if(!visibleName(entry.name,false))continue;
          const full=path.join(current.dir,entry.name);
          let item:Awaited<ReturnType<FileAdapter['guardReadPath']>>;
          try{item=await this.guardReadPath(full,context,'list_directory');}
          catch{skippedLinks++;continue;}
          if(isReparseOrLink(item.stat)){skippedLinks++;continue;}
          if(base.readScope&&(!item.readScope||
              item.readScope.digest!==base.readScope.digest||
              item.readScope.revision!==base.readScope.revision))continue;
          visited++;
          const isDirectory=item.stat.isDirectory();
          const result={path:this.displayRead(item.absolute,item.readScope),
            name:entry.name,type:isDirectory?'directory':item.stat.isFile()?'file':'other',
            size:item.stat.isFile()?item.stat.size:undefined,
            modified:item.stat.mtime.toISOString(),depth:current.level+1,
            ...(item.readScope?{root_scope:item.readScope.root}: {})};
          const bytes=Buffer.byteLength(JSON.stringify(result));
          if(outputBytes+bytes>MAX_SEARCH_RESULT_BYTES){truncated=true;break;}
          results.push(result);outputBytes+=bytes;
          if(isDirectory&&current.level+1<depth)
            queue.push({dir:item.absolute,level:current.level+1});
        }
      };
      if(guarded.readScope){
        await this.options!.readRoots!.withDirectory(guarded.readScope,context,
          'list_directory',scan);
      }else{
        const directory=await fs.opendir(guarded.absolute);
        try{await scan(directory);}finally{await directory.close().catch(()=>{});}
      }
    }
    // A selection revoked during enumeration must withhold EVERY result.
    if(base.readScope){
      await this.authorize('hostdeck_list_directory',args);
      await this.options!.readRoots!.assertScope(base.readScope,context,'list_directory');
    }
    return {directory:this.displayRead(base.absolute,base.readScope),
      entries:results,truncated,visited,skipped_reparse_points:skippedLinks,
      ...(base.readScope?{root_scope:base.readScope.root}: {})};
  }

  private async createDirectory(name: string, args: Record<string, unknown>): Promise<unknown> {
    const target = await this.guardPath(args.path, true);
    const parentPath = path.dirname(target.absolute);
    const parent = await this.guardPath(parentPath);
    if (!parent.stat?.isDirectory()) throw new Error('FILES_PARENT_NOT_DIRECTORY');
    await this.authorize(name, args);
    await fs.mkdir(target.absolute);
    return { created: true, path: this.relative(target.absolute) };
  }

  private async moveFile(name: string, args: Record<string, unknown>): Promise<unknown> {
    const source = await this.guardPath(args.source);
    if (!source.stat?.isFile() && !source.stat?.isDirectory()) throw new Error('FILES_NOT_A_REGULAR_FILE');
    const isDirectory = source.stat.isDirectory();
    if (isDirectory && args.overwrite === true) throw new Error('FILES_DIRECTORY_OVERWRITE_UNSUPPORTED');
    if (isDirectory) await this.inspectTree(source.absolute, true);
    const destination = await this.guardPath(args.destination, true);
    if (source.absolute === this.workspace || (isDirectory && inside(source.absolute, destination.absolute))) throw new Error('FILES_MOVE_INVALID_TARGET');
    const parent = await this.guardPath(path.dirname(destination.absolute));
    if (!parent.stat?.isDirectory()) throw new Error('FILES_PARENT_NOT_DIRECTORY');
    if (isDirectory && process.platform !== 'win32') throw new Error('FILES_DIRECTORY_MOVE_UNAVAILABLE_PLATFORM');
    await this.authorize(name, args);
    if (isDirectory) {
      const script = `[System.IO.Directory]::Move(${psQuote(source.absolute)},${psQuote(destination.absolute)})`;
      await this.runPowerShell(script, 'FILES_DIRECTORY_MOVE_FAILED');
    } else if (args.overwrite === true) {
      // Same-volume rename is atomic; on failure Node leaves the destination intact.
      await fs.rename(source.absolute, destination.absolute);
    } else {
      // link() is exclusive and atomic: an existing destination is never replaced.
      await fs.link(source.absolute, destination.absolute);
      try { await fs.unlink(source.absolute); }
      catch {
        try { await fs.unlink(destination.absolute); }
        catch { throw new Error('FILES_MOVE_PARTIAL_DESTINATION_REMAINS'); }
        throw new Error('FILES_MOVE_SOURCE_REMAINS');
      }
    }
    return { moved: true, path: this.relative(destination.absolute) };
  }

  private async runPowerShell(script: string, failureCode: string): Promise<void> {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try { await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error(failureCode); }
  }

  private async inspectTree(root: string, recursive: boolean): Promise<number> {
    const stat = await fs.lstat(root);
    if (isReparseOrLink(stat)) throw new Error('FILES_REPARSE_POINT_DENIED');
    if (!stat.isDirectory()) return 1;
    if (!recursive) {
      const directory = await fs.opendir(root);
      const first = await directory.read();
      await directory.close();
      if (first) throw new Error('FILES_DIRECTORY_NOT_EMPTY');
      return 1;
    }
    let count = 0;
    const queue = [root]; const deadline = Date.now() + 3000;
    while (queue.length) {
      if (Date.now() > deadline || count >= MAX_TRAVERSAL_ENTRIES) throw new Error('FILES_DELETE_LIMIT');
      const dir = queue.pop()!;
      const directory = await fs.opendir(dir);
      for await (const entry of directory) {
        count++;
        if (count >= MAX_TRAVERSAL_ENTRIES) throw new Error('FILES_DELETE_LIMIT');
        const full = path.join(dir, entry.name); const child = await fs.lstat(full);
        if (isReparseOrLink(child)) throw new Error('FILES_REPARSE_POINT_DENIED');
        if (child.isDirectory()) queue.push(full);
      }
    }
    return count + 1;
  }

  private async deletePath(name: string, args: Record<string, unknown>): Promise<unknown> {
    const target = await this.guardPath(args.path);
    if (!target.stat || target.absolute === this.workspace) throw new Error('FILES_DELETE_ROOT_DENIED');
    if (args.recycle !== false && process.platform !== 'win32') throw new Error('FILES_RECYCLE_UNAVAILABLE_PLATFORM');
    const count = await this.inspectTree(target.absolute, args.recursive === true);
    if (count > MAX_TRAVERSAL_ENTRIES) throw new Error('FILES_DELETE_LIMIT');
    await this.authorize(name, args);
    if (args.recycle !== false) {
      if (process.platform !== 'win32') throw new Error('FILES_RECYCLE_UNAVAILABLE_PLATFORM');
      const quoted = psQuote(target.absolute);
      const script = `Add-Type -AssemblyName Microsoft.VisualBasic; $p=${quoted}; if ([System.IO.Directory]::Exists($p)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) }`;
      await this.runPowerShell(script, 'FILES_RECYCLE_FAILED');
      return { deleted: true, permanent: false, recycled: true, entries: count };
    }
    if(target.stat.isDirectory()&&args.recursive!==true)await fs.rmdir(target.absolute);
    else await fs.rm(target.absolute, { recursive: args.recursive === true, force: false });
    return { deleted: true, permanent: true, entries: count };
  }

  private pruneSearches(): void {
    const now = Date.now();
    for (const [id, job] of this.searches) if (job.done && now - job.touchedAt > SEARCH_RETENTION_MS) this.searches.delete(id);
    if (this.searches.size < 100) return;
    for (const [id, job] of this.searches) if (job.done) this.searches.delete(id);
  }

  private async listProviders(context:FileOwnerContext):Promise<unknown> {
    const enabledOverride=await this.options?.providers?.enabledOverride(context,'everything')??null;
    const desiredEnabled=enabledOverride??true;
    let everything:unknown={installed:null,running:null,compatible:null,healthy:null,reason:'not_configured',qualified:'not_independently_accepted'};
    if(this.options?.everything)try{this.authorizeEverythingSession(context);everything=await this.options.everything.status();}
    catch(e){everything={installed:null,running:null,compatible:null,healthy:null,reason:e instanceof RuntimeError?e.code:'EVERYTHING_UNAVAILABLE',qualified:'not_independently_accepted'};}
    return {providers:[{id:'direct',capabilities:['files.name','files.content'],installed:true,configured:true,enabled:true,desiredEnabled:true,enabledOverride:null,running:'on_demand',compatible:true,healthy:true},
      {id:'everything',capabilities:['files.name'],...(everything as object),configured:!!this.options?.everything,enabled:desiredEnabled,desiredEnabled,enabledOverride}],functions:await Promise.all((['files.name','files.content'] as const).map(async capability=>({
        capability,preference:await this.options?.providers?.preference(context,capability)??null,default:'direct',selected:await this.options?.providers?.select(context,capability)??'direct'})))};
  }

  private authorizeEverythingSession(context:FileOwnerContext):void {
    if(!this.options?.everything||!context.sessionIds?.includes(this.options.everything.sessionId)
      ||context.sessionId!==undefined&&context.sessionId!==this.options.everything.sessionId)throw new RuntimeError('EVERYTHING_WRONG_SESSION');
  }

  private async assertProviderEnabled(context:FileOwnerContext,provider:SearchProvider):Promise<void> {
    if(await this.options?.providers?.enabled(context,provider)===false)throw new RuntimeError('PROVIDER_DISABLED');
  }

  private disableSearch(job:SearchJob):void {
    job.error='PROVIDER_DISABLED';job.matches=[];job.bytes=0;job.abort.abort();
  }

  private async authorizeEverythingSearch(job:SearchJob):Promise<void> {
    if(job.error==='PROVIDER_DISABLED')throw new RuntimeError('PROVIDER_DISABLED');
    await this.authorize('hostdeck_search_files',{device_id:job.owner.deviceId,session_id:this.options?.everything?.sessionId,path:job.root,pattern:job.pattern,mode:job.mode,provider:'everything'});
    try{await this.assertProviderEnabled(job.owner,'everything');}
    catch(error){if(error instanceof RuntimeError&&error.code==='PROVIDER_DISABLED')this.disableSearch(job);throw error;}
    if(job.error==='PROVIDER_DISABLED')throw new RuntimeError('PROVIDER_DISABLED');
  }

  private async startSearch(args: Record<string, unknown>, context: FileOwnerContext): Promise<unknown> {
    this.pruneSearches();
    if (this.searches.size >= 100) throw new Error('SEARCH_CAPACITY_REACHED');
    const mode=args.mode==='content'?'content_search':'name_search';
    // Current PolicyGate/grant revision must be checked before any external
    // root metadata or search handle can be disclosed.
    if(path.isAbsolute(args.path as string) &&
        !inside(this.workspace,path.resolve(args.path as string)))
      await this.authorize('hostdeck_search_files',args);
    const root=await this.guardReadPath(args.path,context,mode);
    const pattern = args.pattern as string;
    const literal = args.literal as boolean;
    const capability=args.mode==='content'?'files.content':'files.name';
    const provider=await this.options?.providers?.select(context,capability,args.provider as SearchProvider|undefined)??args.provider as SearchProvider|undefined??'direct';
    if(provider==='everything') {
      await this.authorize('hostdeck_search_files',args);
      await this.assertProviderEnabled(context,provider);
    }
    if(provider==='everything'&&capability!=='files.name')throw new RuntimeError('PROVIDER_CAPABILITY_UNSUPPORTED');
    if(provider==='everything'&&!this.options?.everything)throw new RuntimeError('EVERYTHING_NOT_CONFIGURED');
    if(provider==='everything')this.authorizeEverythingSession(context);
    const job: SearchJob = {
      id: randomUUID(), owner: { ...context }, root: root.absolute, pattern, mode: args.mode as 'files' | 'content',
      regex: safePattern(pattern, literal), includeHidden: args.include_hidden as boolean,
      deadline: Date.now() + (args.timeout_ms as number), resultLimit: Math.min(args.limit as number, MAX_SEARCH_MATCHES),
      matches: [], bytes: 0, visited: 0, truncated: false, done: false, stopped: false,
      startedAt: Date.now(), touchedAt: Date.now(),
      provider,entryType:args.entry_type as SearchJob['entryType'],sort:args.sort as SearchJob['sort'],metadata:args.metadata===true,abort:new AbortController(),
      coverageTruncated:false,rootIsFile:root.stat.isFile()===true,
      ...(root.readScope?{readScope:root.readScope}:{}),
    };
    this.searches.set(job.id, job);
    void (provider==='everything'?this.runEverything(job):this.runSearch(job));
    return { search_id: job.id, state: 'running', result_limit: job.resultLimit,provider,retention_ms:SEARCH_RETENTION_MS };
  }

  private async runEverything(job:SearchJob):Promise<void> {
    try {
      await this.authorizeEverythingSearch(job);
      const result=await this.options!.everything!.query(job.root,Math.max(1,job.deadline-Date.now()),job.abort.signal);
      await this.authorizeEverythingSearch(job);
      job.provenance={version:result.version,instance:result.instance,session_id:result.session_id,runtime_id:result.runtime_id};
      const seen=new Set<string>();
      for(const candidate of result.paths){
        if(job.error==='PROVIDER_DISABLED')throw new RuntimeError('PROVIDER_DISABLED');
        if(job.stopped||Date.now()>job.deadline||job.truncated){job.truncated||=!job.stopped;break;}
        // Do not expose engine counts or unchecked paths, even on malformed replies.
        if(!inside(job.root,candidate)||
            (!job.readScope&&!inside(this.workspace,candidate)))continue;
        let safe:Awaited<ReturnType<FileAdapter['guardReadPath']>>;
        try{safe=await this.guardReadPath(candidate,job.owner,'name_search');}
        catch{continue;}
        if(job.readScope&&(!safe.readScope||
            safe.readScope.digest!==job.readScope.digest||
            safe.readScope.revision!==job.readScope.revision))continue;
        if(!safe.stat.isFile()&&!safe.stat.isDirectory())continue;
        const fromRoot=path.relative(job.root,safe.absolute);
        if(!job.rootIsFile&&fromRoot==='')continue;
        const components=fromRoot?fromRoot.split(path.sep):[];
        if(components.length>21){job.coverageTruncated=true;continue;}
        const relative=this.displayRead(safe.absolute,safe.readScope);
        if(seen.has(relative))continue;seen.add(relative);
        if(!job.includeHidden&&components.some(p=>p.startsWith('.')))continue;
        job.visited++;
        await this.inspectSearchEntry(job,safe.absolute,safe.stat);
      }
      job.truncated ||= result.truncated;
      await this.authorizeEverythingSearch(job);
    }catch(e){
      if(e instanceof RuntimeError&&e.code==='EVERYTHING_TERMINATION_UNCERTAIN')job.error=e.code;
      else if(!job.stopped)job.error=job.error??(e instanceof RuntimeError?e.code:'EVERYTHING_UNAVAILABLE');
      if(job.error==='PROVIDER_DISABLED'||job.error==='DENIED'){job.matches=[];job.bytes=0;}
    }
    finally{this.finishSearch(job);}
  }

  private finishSearch(job:SearchJob):void {
    job.truncated ||= job.coverageTruncated;
    if(job.sort)job.matches.sort((a,b)=>{
      const key=(m:SearchMatch)=>job.sort==='name'?path.basename(m.path):m.path;
      const x=key(a),y=key(b);return x<y?-1:x>y?1:a.path<b.path?-1:a.path>b.path?1:0;
    });
    job.done=true;job.touchedAt=Date.now();
  }

  private async inspectSearchEntry(job:SearchJob,file:string,stat:import('node:fs').Stats):Promise<void> {
    if(job.mode==='content'){if(stat.isFile())await this.inspectSearchFile(job,file,stat.size,MAX_CONTENT_FILE_BYTES);return;}
    if(stat.isDirectory()&&job.entryType==='files'||stat.isFile()&&job.entryType==='directories')return;
    if(!stat.isDirectory()&&!stat.isFile())return;
    const relative=this.displayRead(file,job.readScope);
    if(job.regex!.test(path.basename(file))||job.regex!.test(relative)){
      const observed=job.readScope?await fs.stat(file,{bigint:true}):null;
      this.addMatch(job,{path:relative,kind:stat.isDirectory()?'directory':'file',
        ...(observed?{privateIdentity:{dev:observed.dev.toString(),ino:observed.ino.toString(),
          mtimeNs:observed.mtimeNs.toString(),size:observed.size.toString()}}:{}),
        ...(job.metadata?{size:stat.isFile()?stat.size:undefined,modified:stat.mtime.toISOString(),
          metadata_source:'filesystem_readback' as const}:{})});
    }
  }

  private async runSearch(job:SearchJob):Promise<void>{
    const scoped=job.readScope?this.options?.readRoots:undefined;
    const operation=job.mode==='content'?'content_search':'name_search';
    const queue:Array<{target:string;level:number}>=[{target:job.root,level:0}];
    const maxDepth=20,maxFile=MAX_CONTENT_FILE_BYTES;
    try{
      while(queue.length){
        if(job.stopped||Date.now()>job.deadline||job.visited>=MAX_TRAVERSAL_ENTRIES||
            job.truncated||job.bytes>=MAX_SEARCH_RESULT_BYTES){
          job.truncated=!job.stopped;break;
        }
        const current=queue.shift()!;
        let currentPath:Awaited<ReturnType<FileAdapter['guardReadPath']>>;
        try{currentPath=await this.guardReadPath(current.target,job.owner,operation);}
        catch{continue;}
        if(job.readScope&&(!currentPath.readScope||
            currentPath.readScope.digest!==job.readScope.digest||
            currentPath.readScope.revision!==job.readScope.revision))continue;
        if(isReparseOrLink(currentPath.stat))continue;
        if(currentPath.stat.isDirectory()){
          const scan=async(dir:AsyncIterable<{name:string}>)=>{
            for await(const entry of dir){
              if(!visibleName(entry.name,job.includeHidden))continue;
              if(job.stopped||job.truncated||Date.now()>job.deadline)break;
              const full=path.join(current.target,entry.name);
              let child:Awaited<ReturnType<FileAdapter['guardReadPath']>>;
              try{child=await this.guardReadPath(full,job.owner,operation);}
              catch{continue;} // Excluded/protected/reparse are never counted as matches.
              if(job.readScope&&(!child.readScope||
                  child.readScope.digest!==job.readScope.digest||
                  child.readScope.revision!==job.readScope.revision))continue;
              if(isReparseOrLink(child.stat))continue;
              if(++job.visited>MAX_TRAVERSAL_ENTRIES){job.truncated=true;break;}
              if(child.stat.isDirectory()){
                if(current.level<maxDepth)queue.push({target:full,level:current.level+1});
                else job.coverageTruncated=true;
              }
              await this.inspectSearchEntry(job,child.absolute,child.stat);
              if(job.stopped||job.truncated||job.bytes>=MAX_SEARCH_RESULT_BYTES||
                  Date.now()>job.deadline){
                job.truncated||=!job.stopped&&
                  (job.bytes>=MAX_SEARCH_RESULT_BYTES||Date.now()>job.deadline);break;
              }
            }
          };
          if(currentPath.readScope)await scoped!.withDirectory(currentPath.readScope,
            job.owner,operation,scan);
          else {
            const dir=await fs.opendir(currentPath.absolute);
            try{await scan(dir);}finally{await dir.close().catch(()=>{});}
          }
        }else if(currentPath.stat.isFile()){
          job.visited++;
          await this.inspectSearchEntry(job,currentPath.absolute,currentPath.stat);
        }
      }
      if(job.readScope)await scoped!.assertScope(job.readScope,job.owner,operation);
    }catch(error){
      job.error=job.readScope?'READ_ROOT_REVOKED':
        error instanceof Error?error.message:'SEARCH_FAILED';
    }finally{this.finishSearch(job);}
  }

  private async inspectSearchFile(job: SearchJob, file: string, size: number, maxFile: number): Promise<void> {
    const relative = this.displayRead(file,job.readScope);
    if (job.mode === 'files') {
      if (job.regex!.test(path.basename(file)) || job.regex!.test(relative)) {
        const observed=job.readScope?await fs.stat(file,{bigint:true}):null;
        this.addMatch(job,{path:relative,kind:'file',
          ...(observed?{privateIdentity:{dev:observed.dev.toString(),ino:observed.ino.toString(),
            mtimeNs:observed.mtimeNs.toString(),size:observed.size.toString()}}:{})});
      }
      return;
    }
    if (size > maxFile || job.matches.length >= job.resultLimit) { if (size > maxFile) job.truncated = true; return; }
    let bytes:Buffer;
    let privateIdentity:SearchMatch['privateIdentity'];
    if(job.readScope){
      const source=await this.guardReadPath(file,job.owner,'content_search');
      if(!source.readScope||
          source.readScope.digest!==job.readScope.digest||
          source.readScope.revision!==job.readScope.revision)return;
      const opened=await this.options!.readRoots!.readBytesVerified(
        source.readScope,job.owner,'content_search',maxFile);
      bytes=opened.bytes;privateIdentity=opened.identity;
    }else bytes=await fs.readFile(file);
    if (bytes.includes(0)) return;
    const content = bytes.toString('utf8');
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (job.stopped || job.truncated || Date.now() > job.deadline || job.bytes >= MAX_SEARCH_RESULT_BYTES) break;
      const line = lines[index];
      if (job.regex!.test(line)) this.addMatch(job, {path:relative,kind:'content',
        line:index+1,text:line.slice(0,512),
        ...(privateIdentity?{privateIdentity}:{})});
    }
  }

  private addMatch(job: SearchJob, match: SearchMatch): void {
    if (job.matches.length >= job.resultLimit) { job.truncated = true; return; }
    const {privateIdentity:_privateIdentity,...publicMatch}=match;
    const bytes=Buffer.byteLength(JSON.stringify(publicMatch));
    if(job.bytes+bytes>MAX_SEARCH_RESULT_BYTES){job.truncated=true;return;}
    job.matches.push(match);job.bytes+=bytes;
  }

  private searchFor(id: string, context: FileOwnerContext): SearchJob {
    const job = this.searches.get(id);
    if (!job || !ownerMatches(job.owner, context)) throw new RuntimeError('SEARCH_NOT_OWNED');
    if(job.provider==='everything')this.authorizeEverythingSession(context);
    if(job.done&&Date.now()-job.touchedAt>SEARCH_RETENTION_MS){this.searches.delete(id);throw new RuntimeError('SEARCH_EXPIRED');}
    job.touchedAt = Date.now();
    return job;
  }

  private async searchResults(args: Record<string, unknown>,
    context: FileOwnerContext): Promise<unknown> {
    const job=this.searchFor(args.search_id as string,context);
    const access=this.options?.readRoots;
    const operation=job.mode==='content'?'content_search':'name_search';
    if(job.provider==='everything') {
      await this.authorize('hostdeck_search_results',args);
      await this.authorizeEverythingSearch(job);
    } else if(job.readScope) await this.authorize('hostdeck_search_results',args);
    if(job.readScope) await access!.assertScope(job.readScope,context,operation);
    const offset=args.offset as number,limit=args.limit as number;
    const matches=job.sort&&!job.done?[]:job.matches;
    const authorized:SearchMatch[]=[];
    // Every retained result is checked BEFORE computing even total_results,
    // not only the entries inside the requested page. No stale count/metadata.
    const candidates=job.readScope?matches:matches.slice(offset,offset+limit);
    for(const match of candidates){
      try{
        const checked=await this.guardReadPath(match.path,context,operation);
        if(job.readScope&&(!checked.readScope||
            checked.readScope.digest!==job.readScope.digest||
            checked.readScope.revision!==job.readScope.revision))continue;
        if(match.privateIdentity){
          const current=await fs.stat(checked.absolute,{bigint:true});
          const prior=match.privateIdentity;
          if(current.dev.toString()!==prior.dev||
             current.ino.toString()!==prior.ino||
             current.mtimeNs.toString()!==prior.mtimeNs||
             current.size.toString()!==prior.size)continue;
        }
        const {privateIdentity:_privateIdentity,...publicItem}=match;
        authorized.push(publicItem);
      }catch{/* Failed/replaced targets cannot be disclosed. */}
    }
    if(job.provider==='everything')await this.authorizeEverythingSearch(job);
    if(job.readScope){
      await this.authorize('hostdeck_search_results',args);
      await access!.assertScope(job.readScope,context,operation);
    }
    if(job.error==='PROVIDER_DISABLED')throw new RuntimeError('PROVIDER_DISABLED');
    const total=job.readScope?authorized.length:matches.length;
    const items=job.readScope?authorized.slice(offset,offset+limit):authorized;
    return {search_id:job.id,provider:job.provider,
      ...(job.provenance?{provenance:job.provenance}:{}),
      items,offset,total_results:total,complete:job.done,
      truncated:job.truncated,stopped:job.stopped,
      state:job.done?job.error==='EVERYTHING_TERMINATION_UNCERTAIN'?'uncertain':
        job.stopped?'stopped':job.error?'failed':job.truncated?'partial':'complete':'running',
      ...(job.error?{error:job.error}:{}),
      next_offset:Math.min(offset+limit,total),
      snapshot:'retained_query_results',retention_ms:SEARCH_RETENTION_MS};
  }

  private async stopSearch(args: Record<string, unknown>, context: FileOwnerContext): Promise<unknown> {
    const job = this.searchFor(args.search_id as string, context);
    if(job.provider==='everything') {
      await this.authorize('hostdeck_stop_search',args);
      await this.authorizeEverythingSearch(job);
    }
    if (job.done) return { search_id: job.id, stopped: false, complete: true };
    job.stopped = true; job.abort.abort(); job.touchedAt = Date.now();
    return { search_id: job.id, stopped: true, complete: false };
  }

  private async listProcesses(args: Record<string, unknown>): Promise<unknown> {
    if (process.platform !== 'win32') throw new Error('PROCESS_LIST_UNAVAILABLE_PLATFORM');
    const limit = args.limit as number;
    const script = [
      "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      `Add-Type -TypeDefinition 'using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Security.Principal; public static class HostDeckProcessOwner { [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int id); [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token); [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle); public static bool Matches(int id,string sid) { IntPtr process=OpenProcess(0x1000,false,id),token=IntPtr.Zero; if(process==IntPtr.Zero)return false; try { if(!OpenProcessToken(process,8,out token))return false; using(var identity=new WindowsIdentity(token))return identity.User.Value==sid; } finally { if(token!=IntPtr.Zero)CloseHandle(token); CloseHandle(process); } } }'`,
      "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$rows=Get-Process | ForEach-Object { try { if ([HostDeckProcessOwner]::Matches($_.Id,$current)) { [pscustomobject]@{name=([string]$_.ProcessName+'.exe');session_id=[int]$_.SessionId;memory_bytes=[int64]$_.WorkingSet64} } } catch {} }",
      `$rows | Select-Object -First ${Math.min(limit + 1, 1001)} | ConvertTo-Json -Compress`,
    ].join('; ');
    let output: string;
    try {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      ({ stdout: output } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }));
    } catch { throw new Error('PROCESS_LIST_UNAVAILABLE'); }
    let rows: Array<{ name?: string; session_id?: number; memory_bytes?: number }> = [];
    try { const parsed: unknown = JSON.parse(output.trim() || '[]'); rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed as typeof rows[number]] : []; }
    catch { throw new Error('PROCESS_LIST_UNAVAILABLE'); }
    return { processes: rows.slice(0, limit).map(row => ({ name: String(row.name ?? ''), session_id: row.session_id, memory_bytes: row.memory_bytes })), truncated: rows.length > limit, identity_filter: 'current-user' };
  }
}
