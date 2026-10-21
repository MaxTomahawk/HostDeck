import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectDesktopIdentity} from '../src/hostdeck/desktop.js';

test('actual HostDeck stdio entry integrates native session, files, PDF, resources, prompts and durable jobs',async t=>{
  const executable=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
  if(process.platform!=='win32'||!existsSync(executable)){t.skip('Built native Windows worker required');return;}
  const identity=await inspectDesktopIdentity(executable);
  if(!identity.eligible){t.skip('Current interactive Windows token is not eligible');return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hostdeck-integration-'));
  const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
  const scopes=['files:read','files:write','process:execute','desktop:observe','desktop:control','jobs:read','jobs:control','artifacts:read','devices:read'];
  const configPath=path.join(root,'config.json'),grantsPath=path.join(root,'grants.json');
  await fs.writeFile(configPath,JSON.stringify({version:1,device_id:'device',executor_id:'executor',expected_user_sid:identity.sid,workspace,
    state_directory:path.join(root,'state'),desktop_worker:executable,grants_file:grantsPath}));
  await fs.writeFile(grantsPath,JSON.stringify([{issuer:'hostdeck:local',subject:identity.sid,clientId:'stdio',deviceId:'device',executorId:'executor',
    scopes,expiresAt:Math.floor(Date.now()/1000)+300,revision:'fixture',broadUserAuthority:true,sessionIds:[identity.session_id]}]));
  const environment=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/hostdeck/main.ts','--stdio','--config',configPath],env:environment,stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  const client=new Client({name:'hostdeck-real-integration',version:'1'},{capabilities:{}});
  t.after(async()=>{await client.close();await transport.close();await fs.rm(root,{recursive:true,force:true});});
  try{await client.connect(transport);}catch(error){assert.fail(`HostDeck failed to connect: ${stderr.replaceAll(root,'[private-root]')}`);}
  const tools=await client.listTools();
  assert.ok(tools.tools.length>=40);
  const call=async(name:string,args:Record<string,unknown>)=>{
    const result=await client.callTool({name:`hostdeck_${name}`,arguments:{device_id:'device',...args}});
    assert.notEqual(result.isError,true,JSON.stringify(result.content));
    return (result.structuredContent as {result:Record<string,any>}).result;
  };
  await call('write_file',{path:'actual.txt',content:'integrated'});
  assert.equal((await call('read_file',{path:'actual.txt'})).content,'integrated');
  await call('write_pdf',{path:'actual.pdf',markdown:'# Integrated PDF\nActual native HostDeck entry.'});
  const pdf=await call('read_document',{path:'actual.pdf',page_indexes:[0]});
  assert.match(JSON.stringify(pdf),/Integrated PDF/);
  const windows=await call('list_windows',{session_id:identity.session_id});assert.ok(Array.isArray(windows.windows));
  const resources=await client.listResourceTemplates();assert.equal(resources.resourceTemplates.length,4);
  assert.equal((await client.listPrompts()).prompts.length,3);
  const status=await client.readResource({uri:'hostdeck://devices/device/status'});assert.ok(status.contents.length);
  const app=await client.readResource({uri:'ui://hostdeck/management'});assert.match((app.contents[0] as {text:string}).text,/HostDeck/);
  const job=await call('submit_job',{command:"[Console]::Write('integrated-job')",working_directory:workspace,idempotency_key:'fixture',timeout_seconds:10});
  let receipt=job;
  for(let i=0;i<100&&!['succeeded','failed','timed_out','interrupted'].includes(receipt.status);i++){
    await new Promise(resolve=>setTimeout(resolve,100));receipt=await call('read_job',{job_id:job.job_id});
  }
  assert.equal(receipt.status,'succeeded');
  const artifact=await call('read_artifact',{artifact_id:receipt.stdout_artifact_id});assert.match(Buffer.from(artifact.data_base64,'base64').toString(),/integrated-job/);
  await fs.writeFile(grantsPath,'[]');
  const revoked=await client.callTool({name:'hostdeck_write_file',arguments:{device_id:'device',path:'actual.txt',content:'denied'}});
  assert.equal(revoked.isError,true);assert.equal(await fs.readFile(path.join(workspace,'actual.txt'),'utf8'),'integrated');
});
