import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AuditLog,PolicyGate,TokenAuthority,type Grant} from '../src/hostdeck/security.js';
import {parseToolArguments} from '../src/hostdeck/contracts.js';
import {PrivilegeAdapter} from '../src/hostdeck/privilege.js';

const now=()=>Math.floor(Date.now()/1000);
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const identity={sid:'S-1-5-21-1-2-3-1001',sessionId:4,elevated:false,eligible:true};

test('host:manage tools require an authority-minted owner/device/executor/session grant',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hostdeck-privilege-gate-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const audit=await AuditLog.open(directory),authority=new TokenAuthority({issuer:'unused',audience:'unused',jwks:async()=>{throw new Error('unused')}});
  const principal=authority.local(identity,identity.sid,['host:manage']);let grants:Grant[]=[];
  const gate=new PolicyGate(authority,audit,async()=>grants);
  const submit=parseToolArguments('hostdeck_submit_privileged_script',{device_id:'device',session_id:4,goal_id:'11111111-1111-4111-8111-111111111111',goal:'Routine host maintenance',mandate_evidence:'Owner requested maintenance',action_summary:'Check one service state',expected_change:'Service is reported without changes',script:'Get-Service Spooler',risk:'standard'});
  assert.equal((await gate.visible(principal,'device','executor')).has('hostdeck_submit_privileged_script'),false);
  await assert.rejects(gate.authorize(principal,'hostdeck_submit_privileged_script',submit),/DENIED/);
  grants=[{issuer:'hostdeck:local',subject:identity.sid,clientId:'stdio',deviceId:'device',executorId:'executor',scopes:['host:manage'],expiresAt:now()+300,revision:'rev1',broadUserAuthority:true,sessionIds:[4]}];
  assert.equal((await gate.visible(principal,'device','executor')).has('hostdeck_submit_privileged_script'),true);
  const context=await gate.authorize(principal,'hostdeck_submit_privileged_script',submit);
  assert.throws(()=>gate.assertAuthorizedContext(context,'hostdeck_submit_privileged_script',submit),/DENIED/);
  let audited!:import('../src/hostdeck/security.js').ExecutionContext;
  await gate.execute(principal,'hostdeck_submit_privileged_script',submit,async value=>{audited=value;gate.assertAuthorizedContext(value,'hostdeck_submit_privileged_script',submit);return true;});
  assert.ok(audited.auditId);assert.throws(()=>gate.assertAuthorizedContext({...audited},'hostdeck_submit_privileged_script',submit),/DENIED/);
  await assert.rejects(gate.authorize(principal,'hostdeck_submit_privileged_script',{...submit,session_id:5}),/DENIED/);
  grants[0]!.scopes=['files:write'];
  await assert.rejects(gate.authorize(principal,'hostdeck_submit_privileged_script',submit),/DENIED/);
  audit.close();
});

test('signed broker adapter stages a bounded script, persists owner binding, and requires owner receipt for status/verification',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hostdeck-privilege-adapter-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const scripts={submit:path.join(directory,'Submit-AdminRequest.ps1'),receipt:path.join(directory,'Read-ClientReceipts.ps1'),verify:path.join(directory,'Submit-Verification.ps1')};
  await Promise.all(Object.values(scripts).map(file=>fs.writeFile(file,'# trusted test fixture\n')));
  const powershell=path.join(directory,'powershell.exe');await fs.writeFile(powershell,'fixture executable path');
  const goalId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',verificationId='33333333-3333-4333-8333-333333333333';
  const audit=await AuditLog.open(path.join(directory,'audit'));
  const authority=new TokenAuthority({issuer:'unused',audience:'unused',jwks:async()=>{throw new Error('unused')}});
  const principal=authority.local(identity,identity.sid,['host:manage']);
  const grant:Grant={issuer:'hostdeck:local',subject:identity.sid,clientId:'stdio',deviceId:'device',executorId:'executor',scopes:['host:manage'],expiresAt:now()+300,revision:'rev1',broadUserAuthority:true,sessionIds:[4]};
  const grants:Grant[]=[grant];const gate=new PolicyGate(authority,audit,async()=>grants);
  const calls:string[][]=[];let reauthorizations=0;
  const adapter=await PrivilegeAdapter.create({powershellExecutable:powershell,submitScript:scripts.submit,submitSha256:hash(await fs.readFile(scripts.submit)),
    receiptScript:scripts.receipt,receiptSha256:hash(await fs.readFile(scripts.receipt)),verificationScript:scripts.verify,verificationSha256:hash(await fs.readFile(scripts.verify)),
    signerThumbprint:'A'.repeat(40),clientId:'hostdeck-local',stateDirectory:directory,
    reauthorize:async()=>{reauthorizations++},assertAuthorized:(context,name,args)=>gate.assertAuthorizedContext(context,name,args),artifactBytes:async()=>null,
    runPowerShell:async(args)=>{calls.push(args);if(args.includes('-File')){const at=args.indexOf('-ScriptPath'),temp=args[at+1]!;assert.equal(await fs.readFile(temp,'utf8'),'Get-Service Spooler');assert.match(args[args.indexOf('-MandateEvidence')+1]!,/HostDeck audit=[a-f0-9]{64}$/);return{stdout:`Submitted request ${requestId}; goal ${goalId}. No UAC requested.`,stderr:''};}
      const command=Buffer.from(args.at(-1)!,'base64').toString('utf16le');
      if(command.includes(scripts.receipt))return{stdout:JSON.stringify([{request_id:requestId,goal_id:goalId,status:'completed-unverified-effect',exit_code:0,script_sha256:'a'.repeat(64),output:'never expose command output'}]),stderr:''};
      assert.match(command,/Submit-Verification/);return{stdout:`SUBMITTED VERIFICATION ${verificationId} for request ${requestId}`,stderr:''};
    }});
  t.after(()=>adapter.dispose());
  const submit=parseToolArguments('hostdeck_submit_privileged_script',{device_id:'device',session_id:4,goal_id:goalId,goal:'Routine host maintenance',mandate_evidence:'Owner requested maintenance',action_summary:'Check one service state',expected_change:'Service is reported without changes',script:'Get-Service Spooler',risk:'standard'});
  const submitted=await gate.execute(principal,'hostdeck_submit_privileged_script',submit,context=>adapter.handle('hostdeck_submit_privileged_script',submit,context)) as Record<string,unknown>;
  assert.equal(submitted.request_id,requestId);assert.equal(submitted.goal_id,goalId);assert.equal(submitted.status,'pending');assert.match(String(submitted.hostdeck_audit_id),/^[a-f0-9]{64}$/);
  assert.equal(await fs.stat(path.join(directory,'privilege-staging')).then(s=>s.isDirectory()),true);
  assert.deepEqual(await fs.readdir(path.join(directory,'privilege-staging')),[]);
  const listing=parseToolArguments('hostdeck_privileged_requests',{device_id:'device',session_id:4});
  const listed=await gate.execute(principal,'hostdeck_privileged_requests',listing,context=>adapter.handle('hostdeck_privileged_requests',listing,context)) as {requests:Array<{request_id:string}>};
  assert.deepEqual(listed.requests.map(row=>row.request_id),[requestId]);
  const status=parseToolArguments('hostdeck_privileged_status',{device_id:'device',session_id:4,request_id:requestId});
  const receipt=await gate.execute(principal,'hostdeck_privileged_status',status,context=>adapter.handle('hostdeck_privileged_status',status,context)) as Record<string,unknown>;
  assert.equal(receipt.status,'completed-unverified-effect');assert.equal('output' in receipt,false);
  const other=authority.local({sid:'S-1-5-21-1-2-3-1002',sessionId:4,elevated:false,eligible:true},'S-1-5-21-1-2-3-1002',['host:manage']);
  const otherGrant={...grant,subject:'S-1-5-21-1-2-3-1002'};grants.push(otherGrant);
  await assert.rejects(gate.execute(other,'hostdeck_privileged_status',status,context=>adapter.handle('hostdeck_privileged_status',status,context)),/DENIED/);
  const otherListing=parseToolArguments('hostdeck_privileged_requests',{device_id:'device',session_id:4});
  const hidden=await gate.execute(other,'hostdeck_privileged_requests',otherListing,context=>adapter.handle('hostdeck_privileged_requests',otherListing,context)) as {requests:unknown[]};
  assert.deepEqual(hidden.requests,[]);
  const verify=parseToolArguments('hostdeck_submit_privileged_verification',{device_id:'device',session_id:4,request_id:requestId,goal_id:goalId,observed_change:'Service state was inspected',verification_method:'Read service status through Windows API',effect_verified:true});
  const result=await gate.execute(principal,'hostdeck_submit_privileged_verification',verify,context=>adapter.handle('hostdeck_submit_privileged_verification',verify,context)) as Record<string,unknown>;
  assert.equal(result.verification_id,verificationId);assert.equal(result.attestation,'signed-client-assertion-not-independent-os-proof');
  assert.equal(reauthorizations,5);assert.equal(calls.length,4);
  adapter.dispose();audit.close();
});
