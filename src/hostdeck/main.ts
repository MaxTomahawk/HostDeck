#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import httpsServer from 'node:https';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createRemoteJWKSet} from 'jose';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {AuditLog,TokenAuthority,PolicyGate,type Grant} from './security.js';
import {HostDeckFacade,createHttpBoundary,publicError,type Adapter,type ConnectionDiagnostic} from './gateway.js';
import {UserRuntime} from './user-runtime.js';
import {ProcessAdapter} from './processes.js';
import {DocumentAdapter} from './documents.js';
import {FileAdapter} from './files.js';
import {BrowserAdapter} from './browser.js';
import {StateServices} from './state/index.js';
import {DesktopAdapter,inspectDesktopIdentity} from './desktop.js';
import {SafeCommitter} from './commit.js';
import {RuntimeError} from './runtime-error.js';
import {loadOAuthMetadata} from './oauth-metadata.js';
import {loadBackendTls} from './tls.js';
import {PrivilegeAdapter} from './privilege.js';
import {ProviderRegistry} from './providers.js';
import {EverythingClient} from './everything.js';

const absolute=z.string().min(1).max(4096).refine(path.isAbsolute);
const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const https=z.string().url().refine(value=>new URL(value).protocol==='https:'&&!new URL(value).username&&!new URL(value).password);
const scopes=z.array(z.enum(['files:read','files:write','process:execute','desktop:observe','desktop:control','browser:control','jobs:read','jobs:control','artifacts:read','devices:read','host:manage'])).max(11);
const configuration=z.object({
  version:z.literal(1),device_id:identifier,executor_id:identifier,expected_user_sid:z.string().regex(/^S-1-5-[0-9-]+$/),
  workspace:absolute,state_directory:absolute,desktop_worker:absolute,browser_executable:absolute.optional(),grants_file:absolute,
  installed:z.boolean().default(false),enrollment_file:absolute.optional(),
  everything:z.object({executable:absolute,sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),version:z.string().regex(/^1\.[45]\.\d+\.\d+b?$/),instance:z.string().regex(/^[A-Za-z0-9_. -]{0,64}$/)}).strict().optional(),
  privilege_broker:z.object({enabled:z.boolean(),allow_remote:z.boolean().default(false),powershell_executable:absolute,
    submit_script:absolute,submit_sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),receipt_script:absolute,receipt_sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),
    verification_script:absolute,verification_sha256:z.string().regex(/^[a-fA-F0-9]{64}$/),signer_thumbprint:z.string().regex(/^([a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
    client_id:z.literal('hostdeck-local')}).strict().optional(),
  remote_tls:z.object({host:z.string().refine(value=>/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$/.test(value)&&value.split('.').every(part=>Number(part)<=255)),port:z.number().int().min(1024).max(65535),pfx_file:absolute}).strict().optional(),
  http:z.object({port:z.number().int().min(1024).max(65535),resource:https,issuer:https,jwks_uri:https,
    access_token_profile:z.enum(['rfc9068','keycloak']).default('rfc9068'),oauth_client_id:z.string().min(1).max(256).optional(),
    auth_mode:z.enum(['native-oauth','cloudflare-access']).default('native-oauth'),
    cloudflare_access:z.object({audience:z.string().min(1).max(256),capability_ceiling:z.array(z.enum(['files:read','files:write','process:execute','desktop:observe','desktop:control','browser:control','jobs:read','jobs:control','artifacts:read','devices:read','host:manage'])).min(1).max(11)}).strict().optional(),
    allowed_origins:z.array(z.string().url()).max(20).default([]),proxy_hosts:z.array(z.string().regex(/^[A-Za-z0-9.:[\]-]{1,255}$/)).max(10).default([])}).strict().optional(),
}).strict();
const grantSchema=z.array(z.object({issuer:z.string().min(1).max(2048),subject:z.string().min(1).max(256),clientId:z.string().min(1).max(256),
  deviceId:identifier,executorId:identifier,scopes,expiresAt:z.number().finite().positive(),revision:identifier,
  broadUserAuthority:z.literal(true),sessionIds:z.array(z.number().int().positive()).max(32)}).strict()).max(100);

async function jsonFile(file:string,max=262144):Promise<unknown>{
  const handle=await fs.open(file,'r');
  try {if((await handle.stat()).size>max)throw new RuntimeError('CONFIGURATION_LIMIT');return JSON.parse(await handle.readFile('utf8'));}
  finally {await handle.close();}
}
function outside(workspace:string,target:string):boolean {const relative=path.relative(workspace,target);return relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative);}

/** Side-effect-free until explicitly called by the CLI or installer. No inherited onboarding/telemetry. */
export async function startHostDeck(configPath:string,transport:'stdio'|'http') {
  if(process.platform!=='win32')throw new RuntimeError('WINDOWS_REQUIRED');
  const config=configuration.parse(await jsonFile(configPath));
  if(config.http?.auth_mode==='cloudflare-access'){
    const issuer=new URL(config.http.issuer);
    if(config.http.oauth_client_id!==undefined||issuer.protocol!=='https:'||!issuer.hostname.endsWith('.cloudflareaccess.com')
      ||issuer.pathname!=='/'||issuer.search||issuer.hash||issuer.username||issuer.password
      ||config.http.jwks_uri!==new URL('/cdn-cgi/access/certs',issuer).href)throw new RuntimeError('CLOUDFLARE_AUTH_CONFIGURATION_INVALID');
  }
  if(config.remote_tls&&(!config.installed||!(config.http?.auth_mode==='cloudflare-access'||config.http?.oauth_client_id)))throw new RuntimeError('REMOTE_NOT_ENROLLED');
  if(config.http?.auth_mode==='cloudflare-access'&&!config.http.cloudflare_access)throw new RuntimeError('CLOUDFLARE_AUTH_CONFIGURATION_REQUIRED');
  if(config.http?.auth_mode!=='cloudflare-access'&&config.http?.cloudflare_access)throw new RuntimeError('CLOUDFLARE_AUTH_CONFIGURATION_INVALID');
  if(config.privilege_broker?.allow_remote&&!config.privilege_broker.enabled)throw new RuntimeError('PRIVILEGE_CONFIGURATION_INVALID');
  if(config.http?.auth_mode==='cloudflare-access'&&config.http.cloudflare_access?.capability_ceiling.includes('host:manage')
    &&(!config.privilege_broker?.enabled||!config.privilege_broker.allow_remote))throw new RuntimeError('REMOTE_PRIVILEGE_OPT_IN_REQUIRED');
  const workspace=await fs.realpath(config.workspace);
  // The file adapter must not reach its own grant store, audit keys or executable configuration.
  for(const protectedPath of [configPath,config.state_directory,config.grants_file,config.desktop_worker]) {
    if(!outside(workspace,path.resolve(protectedPath)))throw new RuntimeError('CONFIGURATION_INSIDE_WORKSPACE');
  }
  const identity=await inspectDesktopIdentity(config.desktop_worker);
  if(identity.sid!==config.expected_user_sid||identity.elevated||!identity.eligible||identity.integrity.toLowerCase()!=='medium')throw new RuntimeError('EXECUTOR_UNAVAILABLE');
  if(config.installed&&!config.enrollment_file)throw new RuntimeError('ENROLLMENT_REQUIRED');
  let pinnedEnrollment:{generation:number;fingerprint:string}|undefined;
  const checkExecutor=async()=>{
    if(!config.enrollment_file)return;
    if(!outside(workspace,config.enrollment_file))throw new RuntimeError('CONFIGURATION_INSIDE_WORKSPACE');
    const {stdout}=await promisify(execFile)(config.desktop_worker,['--verify-enrollment',config.enrollment_file],{windowsHide:true,timeout:5000,maxBuffer:65536,encoding:'utf8'});
    const proof=JSON.parse(stdout);
    if(proof.verified!==true||proof.device_id!==config.device_id||proof.sid!==identity.sid||proof.session_id!==identity.session_id||proof.logon_id!==identity.logon_id
      ||!Number.isSafeInteger(proof.generation)||proof.generation<1||!/^([a-f0-9]{64})$/.test(proof.fingerprint))throw new RuntimeError('ENROLLMENT_DENIED');
    if(pinnedEnrollment&&(pinnedEnrollment.generation!==proof.generation||pinnedEnrollment.fingerprint!==proof.fingerprint))throw new RuntimeError('ENROLLMENT_CHANGED');
    pinnedEnrollment={generation:proof.generation,fingerprint:proof.fingerprint};
  };
  await checkExecutor();
  const audit=await AuditLog.open(path.join(config.state_directory,'audit'));
  const settings=config.http;
  const authority=new TokenAuthority({issuer:settings?.issuer??'https://localhost.invalid',audience:settings?.resource??'https://localhost.invalid/mcp',
    accessTokenProfile:settings?.access_token_profile,
    jwks:settings?createRemoteJWKSet(new URL(settings.jwks_uri),{timeoutDuration:5000,cooldownDuration:30000,cacheMaxAge:300000}):async()=>{throw new RuntimeError('UNAUTHENTICATED');}});
  const loadGrants=async():Promise<Grant[]>=>grantSchema.parse(await jsonFile(config.grants_file));
  const gate=new PolicyGate(authority,audit,loadGrants);
  // Bounded connection metadata only: never tokens, claims, arguments, paths or tool output.
  const diagnosticEvents:Array<ConnectionDiagnostic&{time:string}>=[];
  const diagnosticGeneration=randomUUID(),diagnosticPath=path.join(config.state_directory,`connection-diagnostics-${transport}.json`);
  let diagnosticDirty=false,diagnosticTask:Promise<void>|undefined;
  const diagnostic=(event:ConnectionDiagnostic)=>{
    diagnosticEvents.push({...event,time:new Date().toISOString()});
    if(diagnosticEvents.length>128)diagnosticEvents.shift();
    diagnosticDirty=true;
    if(!diagnosticTask)diagnosticTask=(async()=>{
      while(diagnosticDirty){
        diagnosticDirty=false;
        const snapshot=JSON.stringify({generation:diagnosticGeneration,transport,events:diagnosticEvents});
        const temporary=diagnosticPath+'.'+randomUUID()+'.tmp';
        try{await fs.writeFile(temporary,snapshot,{flag:'wx',mode:0o600});await fs.rename(temporary,diagnosticPath);}
        catch{/* Non-authoritative diagnostic storage cannot change request admission. */}
        finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
      }
    })().finally(()=>{diagnosticTask=undefined;});
  };
  const environment:Record<string,string>={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']) if(process.env[key])environment[key]=process.env[key]!;
  const systemRoot=process.env.SystemRoot;
  if(!systemRoot||!path.isAbsolute(systemRoot))throw new RuntimeError('EXECUTOR_UNAVAILABLE');
  const shell=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  if(config.privilege_broker&&path.resolve(config.privilege_broker.powershell_executable).toLowerCase()!==path.resolve(shell).toLowerCase())throw new RuntimeError('PRIVILEGE_CONFIGURATION_INVALID');
  environment.PATH=[path.join(systemRoot,'System32'),systemRoot,path.dirname(shell),path.dirname(process.execPath)].join(path.delimiter);
  // PowerShell 5.1 otherwise treats native executables as shell-open targets.
  environment.PATHEXT='.COM;.EXE;.BAT;.CMD';
  const state=StateServices.create({root:path.join(config.state_directory,'state'),deviceId:config.device_id,workspace,shellExecutable:shell,
    environment,desktopWorkerExecutable:config.desktop_worker});
  let facade:HostDeckFacade;
  const reauthorize=(name:string,args:Readonly<Record<string,unknown>>)=>facade.reauthorize(name,args);
  const committer=await SafeCommitter.create({workspace,reauthorize});
  const providers=await ProviderRegistry.open(path.join(config.state_directory,'provider-preferences.sqlite'));
  const everything=config.everything?new EverythingClient({worker:config.desktop_worker,...config.everything,identity}):undefined;
  const files=await FileAdapter.create({workspace,reauthorize,providers,everything});
  const documents=await DocumentAdapter.create({workspace,browserExecutable:config.browser_executable});
  const desktop=await DesktopAdapter.create({executable:config.desktop_worker,expectedSid:config.expected_user_sid,identity,
    reauthorize,storeArtifact:(context,bytes,name,mime)=>state.storeArtifact(context,Buffer.from(bytes),name,mime),
    artifactBytes:async(context,id)=>{const result=await state.artifactBytes(context,id);if(!result)throw new RuntimeError('DENIED');return result;}});
  const runtimes=new Map<string,Promise<UserRuntime>>();
  const processes=await ProcessAdapter.create({executable:config.desktop_worker,expectedSid:config.expected_user_sid,identity,workspace,
    shells:{powershell:shell,cmd:path.join(systemRoot,'System32','cmd.exe')},environment,reauthorize});
  const processAdapter:Adapter={implementedTools:processes.implementedTools,handle(name,args,context){
    if(!context.sessionIds.includes(identity.session_id))throw new RuntimeError('DENIED');
    return processes.handle(name,args,{...context,sessionId:identity.session_id});
  }};
  const runtimeAdapter:Adapter={implementedTools:new Set(['hostdeck_read_file','hostdeck_write_file','hostdeck_edit_text','hostdeck_file_info']),
    async handle(name,args,context){
      let runtime=runtimes.get(context.ownerId);
      if(!runtime){if(runtimes.size>=8)throw new RuntimeError('LIMIT_EXCEEDED');
        runtime=UserRuntime.create({deviceId:config.device_id,workspace,environment,shells:{powershell:shell,cmd:path.join(systemRoot,'System32','cmd.exe')},
          authorize:async(operation,arguments_)=>{await reauthorize(operation,arguments_);return true;}});
        runtimes.set(context.ownerId,runtime);
      }
      return(await runtime).invoke(name,args);
    }};
  const documentAdapter:Adapter={implementedTools:documents.implementedTools,async handle(name,args,context){
    const expected=name==='hostdeck_edit_document'?await committer.snapshot(String(args.path)):undefined;
    const result=await documents.handle(name,args);
    if(name==='hostdeck_read_document')return result;
    return committer.commit(name,args,result as {destination:string;bytes:Uint8Array;mimeType:string},{overwrite:name==='hostdeck_edit_document',expectedSha256:expected});
  }};
  const stateAdapter:Adapter={implementedTools:state.implementedTools,async handle(name,args,context){
    const result=await state.handle(name,args,context);
    if(name==='hostdeck_apply_artifact'){
      if(!result)throw new RuntimeError('DENIED');
      return committer.commit(name,args,result as {destination:string;bytes:Uint8Array},{overwrite:args.overwrite===true});
    }
    if(name==='hostdeck_device_status')return {...result as object,sessions:[{session_id:identity.session_id,eligible:identity.eligible}],executor_id:config.executor_id};
    return result;
  }};
  const privilegeOptions=config.privilege_broker;
  const privilege=privilegeOptions?.enabled?await PrivilegeAdapter.create({powershellExecutable:privilegeOptions.powershell_executable,
    submitScript:privilegeOptions.submit_script,submitSha256:privilegeOptions.submit_sha256,receiptScript:privilegeOptions.receipt_script,
    receiptSha256:privilegeOptions.receipt_sha256,verificationScript:privilegeOptions.verification_script,verificationSha256:privilegeOptions.verification_sha256,
    signerThumbprint:privilegeOptions.signer_thumbprint,clientId:privilegeOptions.client_id,stateDirectory:config.state_directory,
    reauthorize,assertAuthorized:(context,name,args)=>gate.assertAuthorizedContext(context,name,args),
    artifactBytes:async(context,id)=>{const result=await state.artifactBytes(context,id);return result?{bytes:result.bytes,mimeType:result.mimeType}:null;}}):undefined;
  const browser=config.browser_executable?await BrowserAdapter.create({executable:config.browser_executable,profileRoot:path.join(config.state_directory,'browsers')}):undefined;
  const appRoot=fileURLToPath(new URL('../../ui/newtree/',import.meta.url));
  let appHtml:string|undefined;
  try{const [html,css,js]=await Promise.all(['index.html','styles.css','app.js'].map(file=>fs.readFile(path.join(appRoot,file),'utf8')));
    appHtml=html.replace('<link rel="stylesheet" href="./styles.css">',()=>`<style>${css}</style>`).replace('<script type="module" src="./app.js"></script>',()=>`<script type="module">${js.replace(/<\/script/gi,'<\\/script')}</script>`);
    if(settings?.auth_mode==='cloudflare-access'){
      appHtml=appHtml.replace('</head>',()=>`<script>window.__HOSTDECK_AUTH_MODE__="cloudflare-access";</script></head>`);
    } else if(settings?.oauth_client_id){
      const oauth=await loadOAuthMetadata({issuer:settings.issuer,clientId:settings.oauth_client_id,resource:settings.resource,
        scopes:[...new Set((await loadGrants()).filter(g=>g.issuer===settings.issuer&&g.clientId===settings.oauth_client_id).flatMap(g=>g.scopes))]});
      appHtml=appHtml.replace('</head>',()=>`<script>window.__HOSTDECK_OAUTH__=${JSON.stringify(oauth).replace(/</g,'\\u003c')};</script></head>`);
    }
  }catch{throw new RuntimeError('APP_ASSETS_MISSING');}
  facade=new HostDeckFacade({deviceId:config.device_id,executorId:config.executor_id,gate,appHtml,checkExecutor,diagnostic,
    adapters:[runtimeAdapter,processAdapter,files,documentAdapter,stateAdapter,desktop,...(browser?[browser]:[]),...(privilege?[privilege]:[])]});
  let stopTransport:()=>Promise<void>;
  if(transport==='stdio'){
    // Re-mint only from the still-running native identity bootstrap; every tool rechecks current grants.
    const localScopes=[...new Set((await loadGrants()).filter(g=>g.issuer==='hostdeck:local'&&g.subject===identity.sid&&g.clientId==='stdio').flatMap(g=>g.scopes))];
    const principal=()=>authority.local({sid:config.expected_user_sid,sessionId:identity.session_id,elevated:identity.elevated,eligible:identity.eligible},config.expected_user_sid,localScopes);
    const handle=serveStdio(()=>facade.server(principal),{onerror:()=>{}});
    stopTransport=()=>handle.close();
  }else{
    if(!settings)throw new RuntimeError('HTTP_NOT_CONFIGURED');
    // The fixed sentinel binds grants to this Access application/AUD, not an individual DCR OAuth client.
    const cloudflareClientId=settings.auth_mode==='cloudflare-access'?`cloudflare-access:${settings.cloudflare_access!.audience}`:undefined;
    if(config.remote_tls&&!(await loadGrants()).some(g=>g.issuer===settings.issuer&&g.clientId===(cloudflareClientId??settings.oauth_client_id)&&g.deviceId===config.device_id&&g.executorId===config.executor_id&&g.expiresAt>Date.now()/1000))throw new RuntimeError('REMOTE_GRANT_REQUIRED');
    const resource=new URL(settings.resource);
    if(resource.pathname!=='/mcp'||resource.search||resource.hash)throw new RuntimeError('INVALID_RESOURCE');
    const boundary=createHttpBoundary(facade,authority,{issuer:settings.issuer,resource:settings.resource,diagnostic,
      managementEnabled:privilegeOptions?.enabled===true&&privilegeOptions.allow_remote,
      oauthOrigin:settings.auth_mode==='native-oauth'&&settings.oauth_client_id?new URL(settings.issuer).origin:undefined,
      cloudflareAccess:settings.auth_mode==='cloudflare-access'?{audience:settings.cloudflare_access!.audience,
        scopes:settings.cloudflare_access!.capability_ceiling,clientId:cloudflareClientId!}:undefined,
      allowedHosts:[`127.0.0.1:${settings.port}`,resource.host,...settings.proxy_hosts,...(config.remote_tls?[`${config.remote_tls.host}:${config.remote_tls.port}`]:[])],allowedOrigins:[`http://127.0.0.1:${settings.port}`,...settings.allowed_origins]});
    const nodeHandler=toNodeHandler(boundary,{maxRequestBodySize:2_097_152,onerror:()=>{}});
    const server=http.createServer((req,res)=>void nodeHandler(req,res));
    server.requestTimeout=30000;server.headersTimeout=10000;server.maxConnections=64;
    const secureServer=config.remote_tls?httpsServer.createServer(await loadBackendTls({pfxFile:config.remote_tls.pfx_file}),(req,res)=>void nodeHandler(req,res)):undefined;
    if(secureServer){secureServer.requestTimeout=30000;secureServer.headersTimeout=10000;secureServer.maxConnections=64;}
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(settings.port,'127.0.0.1',resolve);});
    if(secureServer&&config.remote_tls)try{await new Promise<void>((resolve,reject)=>{secureServer.once('error',reject);secureServer.listen(config.remote_tls!.port,config.remote_tls!.host,resolve);});}catch(error){server.closeAllConnections();server.close();await boundary.close();throw error;}
    stopTransport=async()=>{await boundary.close();server.closeAllConnections();secureServer?.closeAllConnections();await Promise.all([
      new Promise<void>(resolve=>server.close(()=>resolve())),...(secureServer?[new Promise<void>(resolve=>secureServer.close(()=>resolve()))]:[])]);};
  }
  let closed=false,stopTimer:ReturnType<typeof setInterval>|undefined;
  const generation=randomUUID(),controlPath=path.join(config.state_directory,'agent-control.json'),stopPath=path.join(config.state_directory,'agent-stop.json');
  const close=async()=>{if(closed)return;closed=true;if(stopTimer)clearInterval(stopTimer);await stopTransport();
    await diagnosticTask;
    await Promise.allSettled([processes.dispose(),desktop.dispose(),browser?.dispose(),privilege?.dispose(),...[...runtimes.values()].map(async runtime=>(await runtime).dispose())]);
    await state.close();audit.close();
    if(transport==='http')try{if((await jsonFile(controlPath) as {generation?:string}).generation===generation){await fs.rm(controlPath,{force:true});await fs.rm(stopPath,{force:true});}}catch{/* A replacement agent owns its own generation. */}
  };
  if(transport==='http'){
    await fs.writeFile(controlPath,JSON.stringify({generation,pid:process.pid,started_at:new Date().toISOString()}),{mode:0o600});
    let checking=false;
    stopTimer=setInterval(()=>{if(checking||closed)return;checking=true;
      void jsonFile(stopPath,4096).then(async value=>{if((value as {generation?:string}).generation===generation)await close();}).catch(()=>{}).finally(()=>{checking=false;});
    },250);stopTimer.unref();
  }
  return {facade,identity,close};
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length!==3||!['--stdio','--http','--status','--stop','--ui'].includes(args[0])||args[1]!=='--config'||!path.isAbsolute(args[2]))throw new RuntimeError('USAGE_HOSTDECK_MODE_CONFIG');
  if(['--status','--stop','--ui'].includes(args[0])){
    const config=configuration.parse(await jsonFile(args[2]));
    const identity=await inspectDesktopIdentity(config.desktop_worker);
    if(identity.sid!==config.expected_user_sid||identity.elevated)throw new RuntimeError('DENIED');
    if(args[0]==='--status'){
      let ready=false;try{if(config.http)ready=(await fetch(`http://127.0.0.1:${config.http.port}/health`,{signal:AbortSignal.timeout(1500)})).ok;}catch{}
      process.stdout.write(JSON.stringify({device_id:config.device_id,installed:config.installed,session_id:identity.session_id,desktop_eligible:identity.eligible,http_ready:ready})+'\n');return;
    }
    if(args[0]==='--stop'){
      const control=await jsonFile(path.join(config.state_directory,'agent-control.json'),4096) as {generation:string};
      if(!z.string().uuid().safeParse(control.generation).success)throw new RuntimeError('DENIED');
      const target=path.join(config.state_directory,'agent-stop.json'),temporary=target+'.'+randomUUID();
      await fs.writeFile(temporary,JSON.stringify({generation:control.generation}),{flag:'wx',mode:0o600});await fs.rename(temporary,target);return;
    }
    if(!config.http)throw new RuntimeError('HTTP_NOT_CONFIGURED');
    const managementUrl=config.http.auth_mode==='cloudflare-access'?new URL('/ui',config.http.resource).href:`http://127.0.0.1:${config.http.port}/ui`;
    await promisify(execFile)(path.join(process.env.SystemRoot!,'System32','rundll32.exe'),['url.dll,FileProtocolHandler',managementUrl],{windowsHide:true});return;
  }
  const running=await startHostDeck(args[2],args[0]==='--stdio'?'stdio':'http');
  const stop=()=>{void running.close().then(()=>process.exit(0),()=>process.exit(1));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  if(args[0]==='--stdio')process.stdin.once('end',stop);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(`HostDeck: ${publicError(error)}\n`);process.exitCode=1;});
