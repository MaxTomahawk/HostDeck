import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DesktopAdapter, inspectDesktopIdentity, type DesktopContext } from '../src/hostdeck/desktop.js';

const executable=path.resolve('windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe');
test('native identity and owner/session-bound desktop worker bridge',async t=>{
 if(!process.env.SystemRoot||!existsSync(executable)){t.skip('Windows native desktop worker build is unavailable');return}
 const identity=await inspectDesktopIdentity(executable);assert.ok(identity.sid);assert.ok(identity.session_id>0);
 if(!identity.eligible){t.skip(`Current Windows desktop is not eligible (elevated=${identity.elevated}, session=${identity.session_id}, desktop=${identity.input_desktop}, station=${identity.window_station})`);return}
 const ctx:DesktopContext={ownerId:'desktop_owner_a',deviceId:'device_test',executorId:'executor_test',sessionId:identity.session_id,sessionIds:[identity.session_id]};
 const adapter=await DesktopAdapter.create({executable,expectedSid:identity.sid!,identity,storeArtifact:async()=>{throw new Error('UNEXPECTED_ARTIFACT_WRITE')},artifactBytes:async()=>null,reauthorize:async()=>{}});
 try{
  const result=await adapter.handle('hostdeck_list_windows',{session_id:identity.session_id},ctx) as {windows:Array<{window_id:string}>};assert.ok(Array.isArray(result.windows));
  await assert.rejects(adapter.handle('hostdeck_list_windows',{session_id:identity.session_id+1000},{...ctx,sessionId:identity.session_id+1000,sessionIds:[identity.session_id+1000]}),/WRONG_SESSION/);
  const noAuth=await DesktopAdapter.create({executable,expectedSid:identity.sid!,identity,storeArtifact:async()=>'',artifactBytes:async()=>null});
  try{await assert.rejects(noAuth.handle('hostdeck_send_keys',{session_id:identity.session_id,key:'A'},ctx),/FORBIDDEN/)}finally{await noAuth.dispose()}
  if(result.windows.length){const windowId=result.windows[0]!.window_id;await assert.rejects(adapter.handle('hostdeck_read_ui_tree',{session_id:identity.session_id,window_id:windowId},{...ctx,ownerId:'desktop_owner_b'}),/STALE_WINDOW|WRONG_SESSION/)}
 }finally{await adapter.dispose()}
});

test('desktop adapter rejects a mismatched SID or ineligible identity before worker startup',async()=>{
 const identity={sid:'S-1-5-21-1',account:'user',logon_id:'1',session_id:1,elevated:false,integrity:'medium',input_desktop:'Default',window_station:'WinSta0',eligible:true};
 await assert.rejects(DesktopAdapter.create({executable,expectedSid:'S-1-5-21-2',identity,storeArtifact:async()=>'',artifactBytes:async()=>null}),/DESKTOP_IDENTITY_DENIED/);
 await assert.rejects(DesktopAdapter.create({executable,expectedSid:identity.sid,identity:{...identity,elevated:true},storeArtifact:async()=>'',artifactBytes:async()=>null}),/DESKTOP_IDENTITY_DENIED/);
 await assert.rejects(DesktopAdapter.create({executable,expectedSid:identity.sid,identity:{...identity,integrity:'high'},storeArtifact:async()=>'',artifactBytes:async()=>null}),/DESKTOP_IDENTITY_DENIED/);
});
