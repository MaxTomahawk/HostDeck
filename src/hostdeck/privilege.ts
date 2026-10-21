import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExecutionContext } from './security.js';
import { RuntimeError } from './runtime-error.js';

const SCRIPT_LIMIT=128*1024, OUTPUT_LIMIT=1_048_576;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const psQuote=(value:string)=>`'${value.replace(/'/g,"''")}'`;

export interface PrivilegeAdapterOptions {
  powershellExecutable:string; submitScript:string; receiptScript:string; verificationScript:string;
  submitSha256:string; receiptSha256:string; verificationSha256:string;
  signerThumbprint:string; clientId:'hostdeck-local'; stateDirectory:string;
  reauthorize:(name:string,args:Readonly<Record<string,unknown>>)=>Promise<void>;
  assertAuthorized:(context:ExecutionContext,name:string,args:Readonly<Record<string,unknown>>)=>void;
  artifactBytes:(context:ExecutionContext,id:string)=>Promise<{bytes:Buffer;mimeType?:string}|null>;
  /** Test seam; production uses spawn with fixed executable and argument vector. */
  runPowerShell?:(args:string[],timeoutMs:number)=>Promise<{stdout:string;stderr:string}>;
}

/** Adapter for the installed signed broker. It never elevates itself or accepts a caller-selected executable. */
export class PrivilegeAdapter {
  readonly implementedTools=new Set(['hostdeck_submit_privileged_script','hostdeck_privileged_status','hostdeck_privileged_requests','hostdeck_submit_privileged_verification']);
  private readonly db:DatabaseSync;
  private readonly staging:string;
  private readonly children=new Set<ChildProcess>();
  private disposed=false;
  private constructor(private readonly options:PrivilegeAdapterOptions,db:DatabaseSync,staging:string){this.db=db;this.staging=staging;}

  static async create(options:PrivilegeAdapterOptions):Promise<PrivilegeAdapter>{
    if(!path.isAbsolute(options.stateDirectory)||!path.isAbsolute(options.powershellExecutable)||!path.isAbsolute(options.submitScript)||!path.isAbsolute(options.receiptScript)||!path.isAbsolute(options.verificationScript)
      ||options.clientId!=='hostdeck-local'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(options.signerThumbprint))throw new RuntimeError('PRIVILEGE_CONFIGURATION_INVALID');
    for(const value of [options.submitSha256,options.receiptSha256,options.verificationSha256])if(!/^[a-f0-9]{64}$/i.test(value))throw new RuntimeError('PRIVILEGE_CONFIGURATION_INVALID');
    await assertNoReparsePath(options.powershellExecutable);
    const shellInfo=await lstat(options.powershellExecutable);if(!shellInfo.isFile())throw new RuntimeError('PRIVILEGE_CONFIGURATION_INVALID');
    await verifyPinned(options.submitScript,options.submitSha256);await verifyPinned(options.receiptScript,options.receiptSha256);await verifyPinned(options.verificationScript,options.verificationSha256);
    await assertNoReparsePath(options.stateDirectory);
    const staging=path.join(options.stateDirectory,'privilege-staging');
    await mkdir(staging,{recursive:true,mode:0o700});
    const info=await lstat(staging);if(info.isSymbolicLink()||!info.isDirectory())throw new RuntimeError('PRIVILEGE_CONFIGURATION_INVALID');
    const dbPath=path.join(options.stateDirectory,'privilege.sqlite');
    try{const dbInfo=await lstat(dbPath);if(dbInfo.isSymbolicLink()||!dbInfo.isFile())throw new RuntimeError('PRIVILEGE_CONFIGURATION_INVALID');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const db=new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, device_id TEXT NOT NULL, executor_id TEXT NOT NULL, session_id INTEGER NOT NULL, goal_id TEXT NOT NULL, created_at TEXT NOT NULL)');
    return new PrivilegeAdapter(options,db,staging);
  }

  async handle(name:string,args:Record<string,unknown>,context:ExecutionContext):Promise<unknown>{
    if(this.disposed||!this.implementedTools.has(name))throw new RuntimeError('UNAVAILABLE');
    this.options.assertAuthorized(context,name,args);
    if(name==='hostdeck_submit_privileged_script')return this.submit(args,context);
    if(name==='hostdeck_privileged_status')return this.status(args,context);
    if(name==='hostdeck_privileged_requests')return this.requests(args,context);
    return this.verify(args,context);
  }

  private async submit(args:Record<string,unknown>,context:ExecutionContext){
    const script=String(args.script??'');const bytes=Buffer.from(script,'utf8');
    if(bytes.length<1||bytes.length> SCRIPT_LIMIT)throw new RuntimeError('PRIVILEGED_SCRIPT_SIZE_INVALID');
    if(args.retry_of!==undefined&&(!uuid(args.retry_of)||!this.owns(String(args.retry_of).toLowerCase(),context,String(args.goal_id).toLowerCase())))throw new RuntimeError('DENIED');
    const risk=String(args.risk);const approvalId=args.owner_approval_artifact_id;
    if(risk==='critical'&&!approvalId)throw new RuntimeError('OWNER_APPROVAL_REQUIRED');
    let approval:Buffer|undefined;
    if(typeof approvalId==='string'){
      const artifact=await this.options.artifactBytes(context,approvalId);
      if(!artifact||artifact.bytes.length>65_536)throw new RuntimeError('OWNER_APPROVAL_UNAVAILABLE');
      approval=artifact.bytes;
    }
    await this.verifyConfiguredScripts();
    const dir=await this.makeStage();const scriptPath=path.join(dir,'action.ps1');const approvalPath=approval?path.join(dir,'owner-approval.json'):undefined;
    try{
      await writeFile(scriptPath,bytes,{flag:'wx',mode:0o600});
      if(approval&&approvalPath)await writeFile(approvalPath,approval,{flag:'wx',mode:0o600});
      await this.options.reauthorize('hostdeck_submit_privileged_script',args);
      this.options.assertAuthorized(context,'hostdeck_submit_privileged_script',args);
      const psArgs=['-NoLogo','-NoProfile','-NonInteractive','-File',this.options.submitScript,
        '-ClientId',this.options.clientId,'-CertificateThumbprint',this.options.signerThumbprint,'-ScriptPath',scriptPath,
        '-GoalId',String(args.goal_id),'-Goal',String(args.goal),'-ExpectedChange',String(args.expected_change),
        '-ActionSummary',String(args.action_summary),'-MandateEvidence',`${String(args.mandate_evidence)}; HostDeck audit=${context.auditId}`,'-Risk',risk,
        '-WaitSeconds','0','-TimeoutSeconds',String(args.timeout_seconds??180)];
      if(approvalPath)psArgs.push('-OwnerApprovalBundlePath',approvalPath);
      for(const [field,param] of [['retry_of','-RetryOf'],['project_id','-ProjectId'],['chat_id','-ChatId']] as const)if(args[field])psArgs.push(param,String(args[field]));
      const result=await this.run(psArgs,30_000);
      const match=/Submitted request ([a-f0-9-]{36}); goal ([a-f0-9-]{36})\./i.exec(result.stdout);
      if(!match||!uuid(match[1])||match[2].toLowerCase()!==String(args.goal_id).toLowerCase())throw new RuntimeError('PRIVILEGED_SUBMISSION_UNCERTAIN');
      try{this.db.prepare('INSERT INTO requests(request_id,owner_id,device_id,executor_id,session_id,goal_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(match[1].toLowerCase(),context.ownerId,context.deviceId,context.executorId,context.sessionId,String(args.goal_id).toLowerCase(),new Date().toISOString());}
      catch{throw new RuntimeError('PRIVILEGED_SUBMISSION_UNCERTAIN');}
      return {request_id:match[1].toLowerCase(),goal_id:match[2].toLowerCase(),hostdeck_audit_id:context.auditId,status:'pending',message:'Signed request submitted to the local administrator broker; completion and target effect are not yet verified.'};
    }finally{await rm(dir,{recursive:true,force:true});}
  }

  private async status(args:Record<string,unknown>,context:ExecutionContext){
    const requestId=String(args.request_id).toLowerCase();
    if(!uuid(requestId)||!this.owns(requestId,context))throw new RuntimeError('DENIED');
    await this.options.reauthorize('hostdeck_privileged_status',args);
    this.options.assertAuthorized(context,'hostdeck_privileged_status',args);
    await this.verifyConfiguredScripts();
    const records=await this.readReceipts(requestId);
    const receipt=records.find(item=>item&&typeof item==='object'&&(item as Record<string,unknown>).request_id===requestId);
    if(!receipt)return {request_id:requestId,status:'receipt_unavailable'};
    const raw=receipt as Record<string,unknown>;
    const allowed=['status','error_code','exit_code','runner_status','started_unix_ms','finished_unix_ms','goal_id','goal','risk','action_summary','expected_change','retry_of','script_sha256','effect_verified','observed_change'];
    const resultFields:Record<string,unknown>={request_id:requestId};
    for(const key of allowed)if(raw[key]!==undefined)resultFields[key]=raw[key];
    return resultFields;
  }

  private async requests(args:Record<string,unknown>,context:ExecutionContext){
    await this.options.reauthorize('hostdeck_privileged_requests',args);
    this.options.assertAuthorized(context,'hostdeck_privileged_requests',args);
    const rows=this.db.prepare('SELECT request_id,goal_id,created_at FROM requests WHERE owner_id=? AND device_id=? AND executor_id=? AND session_id=? ORDER BY created_at DESC LIMIT ?')
      .all(context.ownerId,context.deviceId,context.executorId,context.sessionId,Number(args.limit??50)) as {request_id:string;goal_id:string;created_at:string}[];
    return {requests:rows.map(row=>({request_id:row.request_id,goal_id:row.goal_id,submitted_at:row.created_at,status:'submitted; query broker receipt for outcome'}))};
  }

  private async verify(args:Record<string,unknown>,context:ExecutionContext){
    const requestId=String(args.request_id).toLowerCase(),goalId=String(args.goal_id).toLowerCase();
    if(!uuid(requestId)||!uuid(goalId)||!this.owns(requestId,context,goalId))throw new RuntimeError('DENIED');
    await this.verifyConfiguredScripts();
    const parent=(await this.readReceipts(requestId)).find(item=>item&&typeof item==='object'&&(item as Record<string,unknown>).request_id===requestId) as Record<string,unknown>|undefined;
    if(!parent||parent.goal_id!==goalId||!['completed-unverified-effect','timed_out','uncertain-or-failed'].includes(String(parent.status)))throw new RuntimeError('PRIVILEGED_REQUEST_NOT_VERIFIABLE');
    await this.options.reauthorize('hostdeck_submit_privileged_verification',args);
    this.options.assertAuthorized(context,'hostdeck_submit_privileged_verification',args);
    const command=`& ${psQuote(this.options.verificationScript)} -ClientId ${psQuote(this.options.clientId)} -CertificateThumbprint ${psQuote(this.options.signerThumbprint)} -OriginalRequestId ${psQuote(requestId)} -GoalId ${psQuote(goalId)} -ObservedChange ${psQuote(String(args.observed_change))} -VerificationMethod ${psQuote(`${String(args.verification_method)}; HostDeck audit=${context.auditId}`)} -EffectVerified $${args.effect_verified===true?'true':'false'}${args.evidence_sha256?` -EvidenceSha256 ${psQuote(String(args.evidence_sha256))}`:''}${args.project_id?` -ProjectId ${psQuote(String(args.project_id))}`:''}${args.chat_id?` -ChatId ${psQuote(String(args.chat_id))}`:''}`;
    const result=await this.run(['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],20_000);
    const match=/SUBMITTED VERIFICATION ([a-f0-9-]{36}) for request ([a-f0-9-]{36})/i.exec(result.stdout);
    if(!match||match[2].toLowerCase()!==requestId)throw new RuntimeError('PRIVILEGED_VERIFICATION_UNCERTAIN');
    return {verification_id:match[1].toLowerCase(),request_id:requestId,attestation:'signed-client-assertion-not-independent-os-proof'};
  }

  private async readReceipts(requestId:string):Promise<unknown[]>{
    const command=`$ErrorActionPreference='Stop'; $item=& ${psQuote(this.options.receiptScript)} -ClientId ${psQuote(this.options.clientId)} -RequestId ${psQuote(requestId)}; ConvertTo-Json -InputObject $item -Depth 12 -Compress`;
    const result=await this.run(['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],20_000);
    let parsed:unknown;try{parsed=JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));}catch{throw new RuntimeError('PRIVILEGED_STATUS_UNAVAILABLE');}
    return Array.isArray(parsed)?parsed:[parsed];
  }

  private owns(requestId:string,context:ExecutionContext,goalId?:string):boolean{
    const row=this.db.prepare('SELECT owner_id,device_id,executor_id,session_id,goal_id FROM requests WHERE request_id=?').get(requestId) as {owner_id:string;device_id:string;executor_id:string;session_id:number;goal_id:string}|undefined;
    return !!row&&row.owner_id===context.ownerId&&row.device_id===context.deviceId&&row.executor_id===context.executorId&&row.session_id===context.sessionId&&(!goalId||row.goal_id===goalId);
  }
  private async makeStage():Promise<string>{const dir=path.join(this.staging,`${process.pid}-${randomUUID()}`);await mkdir(dir,{recursive:false,mode:0o700});return dir;}
  private async verifyConfiguredScripts(){await verifyPinned(this.options.submitScript,this.options.submitSha256);await verifyPinned(this.options.receiptScript,this.options.receiptSha256);await verifyPinned(this.options.verificationScript,this.options.verificationSha256);}
  private async run(args:string[],timeoutMs:number){
    if(this.options.runPowerShell)return this.options.runPowerShell(args,timeoutMs);
    return new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
      const child=spawn(this.options.powershellExecutable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});this.children.add(child);
      let stdout='',stderr='',total=0;let settled=false;
      const timer=setTimeout(()=>{child.kill();finish(new RuntimeError('PRIVILEGED_HELPER_TIMEOUT'));},timeoutMs);
      const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);this.children.delete(child);if(error)reject(error);else resolve({stdout,stderr});};
      child.stdout.on('data',chunk=>{total+=chunk.length;if(total>OUTPUT_LIMIT){child.kill();finish(new RuntimeError('PRIVILEGED_OUTPUT_LIMIT'));}else stdout+=String(chunk);});
      child.stderr.on('data',chunk=>{if(stderr.length<16384)stderr+=String(chunk).slice(0,16384-stderr.length);});
      child.once('error',()=>finish(new RuntimeError('PRIVILEGED_HELPER_UNAVAILABLE')));
      child.once('close',code=>code===0?finish():finish(new RuntimeError('PRIVILEGED_HELPER_FAILED')));
    });
  }
  async dispose(){if(this.disposed)return;this.disposed=true;for(const child of this.children)child.kill();this.db.close();}
}

async function verifyPinned(file:string,expected:string){
  try{await assertNoReparsePath(file);const info=await lstat(file);if(!info.isFile()||hash(await readFile(file))!==expected.toLowerCase())throw new Error();}
  catch{throw new RuntimeError('PRIVILEGE_HELPER_INTEGRITY');}
}
async function assertNoReparsePath(file:string){
  const absolute=path.resolve(file),root=path.parse(absolute).root;let cursor=root;
  for(const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,segment);const info=await lstat(cursor);
    if(info.isSymbolicLink())throw new Error('REPARSE_PATH');
  }
}
