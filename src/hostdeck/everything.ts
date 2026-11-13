import {spawn} from 'node:child_process';
import {RuntimeError} from './runtime-error.js';
import type {DesktopIdentity} from './desktop.js';

export interface EverythingOptions {
  worker:string; executable:string; sha256:string; version:string; instance:string; identity:DesktopIdentity;
}
export interface EverythingStatus {
  installed:boolean; enabled:boolean; running:boolean; compatible:boolean; healthy:boolean;
  reason:string; version:string; instance:string; session_id:number; qualified:'not_independently_accepted';
}
export interface EverythingSnapshot {paths:string[];truncated:boolean;version:string;instance:string;session_id:number;runtime_id:string;}
/** A required literal substring of the validated Node name match, never vendor search syntax. */
export interface EverythingNameFilter {workspace:string;needle:string;nameScope:'workspace_relative'|'absolute';}

/**
 * A mandatory literal fragment of the already validated Node regexp. Everything uses
 * PCRE on full paths, while Node remains the final filename/relative-path
 * matcher. Never forward a user regexp or Everything search operators.
 */
export function everythingNameNeedle(pattern: RegExp): string {
  const source = pattern.source;
  let best = '', current = '', inClass = false, bestScore = -Infinity;
  const score = (value: string) => [...value].reduce((n, ch) => n + (/[\p{L}\p{N}]/u.test(ch) ? 2 : -1), 0);
  const flush = () => {
    if (current && score(current) > bestScore) { best = current; bestScore = score(current); }
    current = '';
  };
  const escapedLiteral = new Set(['\\', '.', '^', '$', '[', ']', '/', '-', '*', '+', '?', '{', '}', '(', ')', '|']);
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      const escaped = source[++i];
      if (inClass) continue;
      if (escapedLiteral.has(escaped)) { current += escaped; continue; }
      if (escaped === 'x' || escaped === 'u') {
        const width = escaped === 'x' ? 2 : 4, hex = source.slice(i + 1, i + 1 + width);
        if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex))
          throw new RuntimeError('EVERYTHING_QUERY_SEMANTICS_UNSUPPORTED');
        const code = parseInt(hex, 16);
        if (code === 0) throw new RuntimeError('EVERYTHING_QUERY_SEMANTICS_UNSUPPORTED');
        current += String.fromCharCode(code); i += width; continue;
      }
      if ('dDwWsSbB'.includes(escaped)) { flush(); continue; }
      throw new RuntimeError('EVERYTHING_QUERY_SEMANTICS_UNSUPPORTED');
    }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { flush(); inClass = true; continue; }
    if (ch === '.' || ch === '^' || ch === '$') { flush(); continue; }
    current += ch;
  }
  flush();
  if (!best || /[\x00-\x1f]/.test(best))
    throw new RuntimeError('EVERYTHING_QUERY_SEMANTICS_UNSUPPORTED');
  return best;
}

/** One bounded, owned native IPC client per observation/query. Never starts Everything. */
export class EverythingClient {
  constructor(private readonly options:EverythingOptions) {}
  get sessionId():number{return this.options.identity.session_id;}
  private request(operation:'status'|'query',root?:string,timeout=5000,signal?:AbortSignal,filter?:EverythingNameFilter):Promise<any> {
    if(signal?.aborted)return Promise.reject(new RuntimeError('EVERYTHING_CANCELLED'));
    return new Promise((resolve,reject)=>{
      const environment:Record<string,string>={PATHEXT:'.COM;.EXE;.BAT;.CMD'};
      for(const name of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[name])environment[name]=process.env[name]!;
      const child=spawn(this.options.worker,['--everything'],{stdio:'pipe',windowsHide:true,env:environment,shell:false});
      let output=Buffer.alloc(0),settled=false,stopping:string|undefined,cleanup:NodeJS.Timeout|undefined;
      const finish=(error?:RuntimeError,result?:unknown)=>{
        if(settled)return;settled=true;clearTimeout(timer);if(cleanup)clearTimeout(cleanup);signal?.removeEventListener('abort',cancel);
        if(error)reject(error);else resolve(result);
      };
      const stop=(code:string)=>{
        if(stopping||settled)return;stopping=code;clearTimeout(timer);
        // kill() acknowledges a signal request only. Do not seal cancellation
        // until the owned child's pipes/process have actually closed.
        cleanup=setTimeout(()=>finish(new RuntimeError('EVERYTHING_TERMINATION_UNCERTAIN')),2000);
        try{child.kill();}catch{/* The bounded cleanup outcome stays uncertain without close. */}
      };
      const cancel=()=>stop('EVERYTHING_CANCELLED');
      const timer=setTimeout(()=>stop('EVERYTHING_TIMEOUT'),timeout+2000);
      signal?.addEventListener('abort',cancel,{once:true});
      child.stdout.on('data',(bytes:Buffer)=>{
        if(output.length+bytes.length>16*1024*1024){stop('EVERYTHING_RESPONSE_LIMIT');return;}
        output=Buffer.concat([output,bytes]);
      });
      child.stderr.on('data',()=>{});
      child.on('error',()=>finish(new RuntimeError('EVERYTHING_CLIENT_UNAVAILABLE')));
      child.stdin.on('error',()=>stop('EVERYTHING_CLIENT_UNAVAILABLE'));
      child.on('close',code=>{
        if(settled)return;
        if(stopping){finish(new RuntimeError(stopping));return;}
        try {
          const response=JSON.parse(output.toString('utf8'));
          if(typeof response.error==='string'&&/^EVERYTHING_[A-Z_]+$/.test(response.error))throw new RuntimeError(response.error);
          if(code!==0||!response.result)throw new RuntimeError('EVERYTHING_PROTOCOL_ERROR');
          finish(undefined,response.result);
        }catch(e){finish(e instanceof RuntimeError?e:new RuntimeError('EVERYTHING_PROTOCOL_ERROR'));}
      });
      child.stdin.end(JSON.stringify({operation,root,timeout_ms:timeout,executable:this.options.executable,
        sha256:this.options.sha256,version:this.options.version,instance:this.options.instance,
        ...(filter?{workspace:filter.workspace,name_filter:filter.needle,name_scope:filter.nameScope}:{}),
        session_id:this.options.identity.session_id,sid:this.options.identity.sid,logon_id:this.options.identity.logon_id})+'\n');
    });
  }
  async status():Promise<EverythingStatus> {return this.request('status');}
  async query(root:string,timeout:number,signal:AbortSignal,filter:EverythingNameFilter):Promise<EverythingSnapshot> {
    const result=await this.request('query',root,Math.max(1,timeout),signal,filter);
    if(!Array.isArray(result.paths)||result.paths.length>100_001||result.paths.some((p:unknown)=>typeof p!=='string'||p.length>32768)
      ||typeof result.truncated!=='boolean'||typeof result.runtime_id!=='string')throw new RuntimeError('EVERYTHING_PROTOCOL_ERROR');
    return result;
  }
}
