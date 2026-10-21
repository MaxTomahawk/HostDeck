import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopAdapter,inspectDesktopIdentity} from '../src/hostdeck/desktop.js';

test('native UTF-8 UI values, absolute pointer coordinates and focused hotkeys have real fixture effects',
 {skip:process.platform!=='win32'||process.env.HOSTDECK_TEST_UI!=='1'},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-input-fixture-'));
 const statePath=path.join(root,'state.json'),title='HostDeck fixture '+path.basename(root);
 const executable=process.env.HOSTDECK_TEST_WORKER??path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
 const identity=await inspectDesktopIdentity(executable);assert.ok(identity.eligible);
 const fixture=spawn(path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile','-STA','-File',path.resolve('test/fixtures/hostdeck-ui.ps1'),'-StatePath',statePath,'-Title',title],{windowsHide:false,stdio:'ignore'});
 const adapter=await DesktopAdapter.create({executable,expectedSid:identity.sid!,identity,storeArtifact:async()=>{throw new Error('UNEXPECTED_CAPTURE')},artifactBytes:async()=>null,reauthorize:async()=>{}});
 const context={ownerId:'input-fixture',deviceId:'fixture',executorId:'fixture',sessionId:identity.session_id,sessionIds:[identity.session_id]};
 const readState=async()=>JSON.parse(await readFile(statePath,'utf8')) as {text:string;clicks:number};
 async function until(check:()=>Promise<boolean>){const end=Date.now()+5000;while(Date.now()<end){try{if(await check())return;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.fail('fixture did not reach expected state');}
 try{
  await until(async()=>{await readState();return true;});
  let window:any;
  await until(async()=>{const list=await adapter.handle('hostdeck_list_windows',{session_id:identity.session_id},context) as any;window=list.windows.find((w:any)=>w.title===title);return !!window;});
  const args={session_id:identity.session_id,window_id:window.window_id};
  const tree=await adapter.handle('hostdeck_read_ui_tree',{...args,max_depth:5},context) as any;
  const text=tree.elements.find((e:any)=>e.automation_id==='HostDeckFixtureText');
  const button=tree.elements.find((e:any)=>e.automation_id==='HostDeckFixtureButton');assert.ok(text);assert.ok(button);
  await adapter.handle('hostdeck_set_ui_value',{...args,element_ref:text.element_ref,value:'é 中文'},context);
  await until(async()=>(await readState()).text==='é 中文');
  const bounds=button.bounds;
  try{await adapter.handle('hostdeck_mouse_action',{...args,action:{kind:'click',position:{x:Math.floor(bounds.x+bounds.width/2),y:Math.floor(bounds.y+bounds.height/2)}}},context);}
  catch(error){if(error instanceof Error&&error.message==='WINDOW_NOT_FOREGROUND'){t.skip('Unicode UIA readback passed; live pointer/hotkey effect blocked by foreground guard in this executor');return;}throw error;}
  await until(async()=>(await readState()).clicks===1);
  await adapter.handle('hostdeck_invoke_ui_element',{...args,element_ref:text.element_ref,action:'focus'},context);
  await adapter.handle('hostdeck_send_keys',{...args,key:'a',modifiers:['ctrl']},context);
  await adapter.handle('hostdeck_send_keys',{...args,key:'backspace'},context);
  await until(async()=>(await readState()).text==='');
 }finally{await adapter.dispose();fixture.kill();await new Promise(resolve=>fixture.once('close',resolve));await rm(root,{recursive:true,force:true});}
});
