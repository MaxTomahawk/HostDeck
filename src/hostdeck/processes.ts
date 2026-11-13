import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { DesktopIdentity } from './desktop.js';

export interface ProcessContext { ownerId:string; deviceId:string; executorId:string; sessionId?:number; sessionIds?:readonly number[] }
export interface ProcessOptions {
  executable:string; expectedSid:string; identity:DesktopIdentity; workspace:string;
  shells:Readonly<Partial<Record<'powershell'|'cmd',string>>>; environment:Readonly<Record<string,string>>;
  reauthorize?:(name:string,args:Record<string,unknown>)=>Promise<void>;
}
const MAX_WORKERS=8, MAX_QUEUE=16, MAX_REQUEST=2*1024*1024, MAX_RESPONSE=3*1024*1024;
const tools=['start_process','read_process','interact_process','terminate_process'];
const validIdentity=(x:any):x is DesktopIdentity=>!!x&&typeof x.sid==='string'&&typeof x.logon_id==='string'&&Number.isInteger(x.session_id)&&typeof x.elevated==='boolean'&&typeof x.integrity==='string'&&typeof x.input_desktop==='string'&&typeof x.window_station==='string'&&typeof x.eligible==='boolean';
const fail=(code:string):never=>{throw new Error(code)};

type Pending={id:string;resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;bytes:number};
class PrivateProcessWorker {
  private readonly child:ChildProcessWithoutNullStreams; private decoder=new StringDecoder('utf8'); private buffered=''; private pending?:Pending; private closed=false;
  constructor(executable:string,environment:Record<string,string>){this.child=spawn(executable,['--stdio'],{stdio:'pipe',windowsHide:true,env:environment});this.child.stdout.on('data',(b:Buffer)=>this.receive(b));this.child.on('error',()=>this.fail('DESKTOP_UNAVAILABLE'));this.child.on('close',()=>{this.closed=true;this.fail('DESKTOP_UNAVAILABLE')})}
  private receive(chunk:Buffer){if(!this.pending){this.dispose();return}this.pending.bytes+=chunk.length;if(this.pending.bytes>MAX_RESPONSE){this.fail('DESKTOP_RESPONSE_TOO_LARGE');this.dispose();return}this.buffered+=this.decoder.write(chunk);if(Buffer.byteLength(this.buffered)>MAX_RESPONSE){this.fail('DESKTOP_RESPONSE_TOO_LARGE');this.dispose();return}for(;;){const i=this.buffered.indexOf('\n');if(i<0)break;const line=this.buffered.slice(0,i).replace(/\r$/,'');this.buffered=this.buffered.slice(i+1);const p=this.pending;if(!p){this.fail('DESKTOP_PROTOCOL_ERROR');this.dispose();return}try{const response=JSON.parse(line);if(response?.id!==p.id)throw new Error();clearTimeout(p.timer);this.pending=undefined;if(response.error){const code=typeof response.error.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(response.error.code)?response.error.code:'DESKTOP_UNAVAILABLE';p.reject(new Error(code))}else p.resolve(response.result)}catch{this.fail('DESKTOP_PROTOCOL_ERROR');this.dispose();return}}}
  private fail(code:string){const p=this.pending;if(p){clearTimeout(p.timer);this.pending=undefined;p.reject(new Error(code))}}
  request(operation:string,args:Record<string,unknown>,timeout:number){if(this.closed||this.pending)return Promise.reject(new Error('DESKTOP_UNAVAILABLE'));const id=randomUUID(),data=JSON.stringify({id,operation,args});if(Buffer.byteLength(data)>MAX_REQUEST)return Promise.reject(new Error('INVALID_ARGUMENTS'));return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.fail('DESKTOP_TIMEOUT');this.dispose()},timeout);this.pending={id,resolve,reject,timer,bytes:0};this.buffered='';this.decoder=new StringDecoder('utf8');this.child.stdin.write(`${data}\n`,e=>{if(e)this.fail('DESKTOP_UNAVAILABLE')})})}
  dispose(){if(this.closed)return;this.closed=true;this.fail('DESKTOP_UNAVAILABLE');this.child.kill()}
}
type Owner={worker:PrivateProcessWorker;sessionId:number;ready:Promise<void>;tail:Promise<void>;queued:number};

/** Owner-private bridge to native interactive processes contained by Windows Job Objects. */
export class ProcessAdapter {
  readonly implementedTools=new Set(tools.map(x=>`hostdeck_${x}`));
  private readonly owners=new Map<string,Owner>(); private disposed=false;
  private constructor(private readonly options:ProcessOptions){}
  static async create(options:ProcessOptions){if(!options.expectedSid||!validIdentity(options.identity))throw new Error('DESKTOP_IDENTITY_INVALID');if(options.identity.sid?.toLowerCase()!==options.expectedSid.toLowerCase()||options.identity.elevated||options.identity.integrity.toLowerCase()!=='medium'||!options.identity.eligible||options.identity.session_id<=0||options.identity.input_desktop!=='Default'||options.identity.window_station!=='WinSta0')throw new Error('DESKTOP_IDENTITY_DENIED');return new ProcessAdapter(options)}
  async dispose(){this.disposed=true;for(const x of this.owners.values())x.worker.dispose();this.owners.clear()}
  private async session(context:ProcessContext){const requested=context.sessionId;if(typeof requested!=='number'||!Number.isInteger(requested)||requested<=0||(context.sessionIds&&!context.sessionIds.includes(requested))||requested!==this.options.identity.session_id)throw new Error('WRONG_SESSION');return requested}
  private sameIdentity(actual:DesktopIdentity,session:number){return actual.sid?.toLowerCase()===this.options.expectedSid.toLowerCase()&&actual.session_id===session&&actual.session_id===this.options.identity.session_id&&actual.logon_id===this.options.identity.logon_id&&actual.integrity.toLowerCase()==='medium'&&!actual.elevated&&actual.eligible&&actual.input_desktop==='Default'&&actual.window_station==='WinSta0'}
  private workerEnvironment(){const env:Record<string,string>={PATHEXT:'.COM;.EXE;.BAT;.CMD'};for(const k of ['SystemRoot','windir','TEMP','TMP','PATH','ComSpec','PSModulePath']){const v=this.options.environment[k];if(v)env[k]=v}return env}
  private async getOwner(owner:string,session:number){let o=this.owners.get(owner);if(o){if(o.sessionId!==session)throw new Error('WRONG_SESSION');await o.ready;return o}if(this.owners.size>=MAX_WORKERS)throw new Error('DESKTOP_CAPACITY');const worker=new PrivateProcessWorker(this.options.executable,this.workerEnvironment());o={worker,sessionId:session,ready:Promise.resolve(),tail:Promise.resolve(),queued:0};this.owners.set(owner,o);o.ready=(async()=>{try{const id=await worker.request('hostdeck_internal_identity',{},5000);if(!validIdentity(id)||!this.sameIdentity(id,session))throw new Error('DESKTOP_IDENTITY_DENIED')}catch(e){worker.dispose();this.owners.delete(owner);throw e}})();await o.ready;return o}
  private async cwd(value:unknown){const workspace=await realpath(this.options.workspace);const requested=path.resolve(workspace,typeof value==='string'&&value?value:'.');const cwd=await realpath(requested);const relative=path.relative(workspace,cwd);if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('FORBIDDEN');return cwd}
  async handle(name:string,args:unknown,context:ProcessContext):Promise<unknown>{if(this.disposed)throw new Error('DESKTOP_UNAVAILABLE');const operation=name.startsWith('hostdeck_')?name:`hostdeck_${name}`;if(!this.implementedTools.has(operation))throw new Error('UNKNOWN_OPERATION');if(!context||typeof context.ownerId!=='string'||typeof context.deviceId!=='string'||typeof context.executorId!=='string')throw new Error('FORBIDDEN');const a=(typeof args==='object'&&args!==null&&!Array.isArray(args)?args:{}) as Record<string,any>;const session=await this.session(context);const owner=await this.getOwner(context.ownerId,session);
    const run=async()=>{try{const current=await owner.worker.request('hostdeck_internal_identity',{},5000);if(!validIdentity(current)||!this.sameIdentity(current,session))throw new Error('DESKTOP_IDENTITY_DENIED');const nativeArgs:Record<string,unknown>={...a,session_id:session};if(operation==='hostdeck_start_process'){if(typeof a.command!=='string'||!a.command||a.command.length>100_000)throw new Error('INVALID_ARGUMENTS');const shell=a.shell==='cmd'?'cmd':'powershell';if(a.shell==='wsl'||!this.options.shells[shell])throw new Error('UNAVAILABLE');nativeArgs.shell=shell;nativeArgs.shell_executable=await realpath(this.options.shells[shell]!);nativeArgs.cwd=await this.cwd(a.working_directory);nativeArgs.environment=this.workerEnvironment()}
      const writes=operation!=='hostdeck_read_process';if(writes&&!this.options.reauthorize)throw new Error('FORBIDDEN');await this.options.reauthorize?.(operation,a);const result=await owner.worker.request(operation,nativeArgs,Math.max(1000,Math.min(300_000,Number(a.timeout_ms??1000)+5000)));return result
    }catch(e){const code=e instanceof Error?e.message:'DESKTOP_UNAVAILABLE';if(['DESKTOP_TIMEOUT','DESKTOP_RESPONSE_TOO_LARGE','DESKTOP_PROTOCOL_ERROR','DESKTOP_UNAVAILABLE'].includes(code)){owner.worker.dispose();this.owners.delete(context.ownerId);throw new Error('EFFECT_OUTCOME_UNCERTAIN')}throw e}};
    if(owner.queued>=MAX_QUEUE)throw new Error('DESKTOP_CAPACITY');owner.queued++;const result=owner.tail.then(run,run).finally(()=>owner.queued--);owner.tail=result.then(()=>undefined,()=>undefined);return result;
  }
}
