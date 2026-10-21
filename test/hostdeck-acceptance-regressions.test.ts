import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DocumentAdapter} from '../src/hostdeck/documents.js';
import {FileAdapter} from '../src/hostdeck/files.js';
import {ProcessAdapter} from '../src/hostdeck/processes.js';
import {inspectDesktopIdentity} from '../src/hostdeck/desktop.js';

test('PDF creation and page insertion preserve accented and CJK text', {skip:!process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE},async()=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'hostdeck-unicode-pdf-'));
 try{
  const adapter=await DocumentAdapter.create({workspace,browserExecutable:process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE} as any);
  const text='België, 中文';
  const staged=await adapter.handle('hostdeck_write_pdf',{path:'unicode.pdf',markdown:text}) as {bytes:Uint8Array};
  await writeFile(path.join(workspace,'unicode.pdf'),staged.bytes);
  const read=await adapter.handle('hostdeck_read_document',{path:'unicode.pdf'}) as {content:Array<{text:string}>};
  assert.equal(read.content[0].text.trim(),text);
  const edited=await adapter.handle('hostdeck_edit_document',{path:'unicode.pdf',change:{kind:'pdf_insert_markdown',page_index:1,markdown:text}}) as {bytes:Uint8Array};
  await writeFile(path.join(workspace,'inserted.pdf'),edited.bytes);
  const inserted=await adapter.handle('hostdeck_read_document',{path:'inserted.pdf'}) as {content:Array<{text:string}>};
  assert.equal(inserted.content[1].text.trim(),text);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('Windows process inventory includes the current owned process',{skip:process.platform!=='win32'},async()=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'hostdeck-process-inventory-'));
 try{
  const adapter=await FileAdapter.create({workspace,reauthorize:async()=>{}});
  const result=await adapter.handle('hostdeck_list_processes',{device_id:'fixture',limit:1000},{ownerId:'fixture',deviceId:'fixture',executorId:'fixture'}) as {processes:Array<{name:string}>};
  assert.ok(result.processes.some(p=>p.name.toLowerCase()===path.basename(process.execPath).toLowerCase()));
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('native worker preserves Unicode commands and suppresses PowerShell progress',{skip:process.platform!=='win32'},async()=>{
 const executable=process.env.HOSTDECK_TEST_WORKER??path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
 const identity=await inspectDesktopIdentity(executable);
 assert.ok(identity.eligible,'test requires the enrolled interactive desktop');
 const workspace=await mkdtemp(path.join(os.tmpdir(),'hostdeck-native-unicode-'));
 const adapter=await ProcessAdapter.create({executable,expectedSid:identity.sid!,identity,workspace,
  shells:{powershell:path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe')},environment:process.env as Record<string,string>,reauthorize:async()=>{}});
 const context={ownerId:'unicode-fixture',deviceId:'fixture',executorId:'fixture',sessionId:identity.session_id,sessionIds:[identity.session_id]};
 try{
  const expected='é 中文 🙂';
  const result=await adapter.handle('hostdeck_start_process',{shell:'powershell',command:`Get-Process -Id $PID | Out-Null; Write-Output '${expected}'`,timeout_ms:5000},context) as {output:string;state:string};
  assert.equal(result.state,'exited');assert.equal(result.output.trim(),expected);assert.ok(!result.output.includes('CLIXML'));
  const long=await adapter.handle('hostdeck_start_process',{shell:'powershell',command:"[Console]::Out.Write(('é中文🙂'*5000))",timeout_ms:5000},context) as {output:string;state:string};
  const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
  assert.equal(long.state,'exited');assert.equal(digest(long.output),digest('é中文🙂'.repeat(5000)));
 }finally{await adapter.dispose();await rm(workspace,{recursive:true,force:true});}
});
