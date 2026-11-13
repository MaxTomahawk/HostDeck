import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publicError} from '../src/hostdeck/gateway.js';
import {FileAdapter} from '../src/hostdeck/files.js';
import {mkdtemp,realpath,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('expected stale/conflict errors are distinct while arbitrary backend details stay private',()=>{
 for(const code of ['STALE_WINDOW','STALE_ELEMENT','EDIT_CONFLICT','WINDOW_NOT_FOREGROUND','BROWSER_INVALID_URL','OCR_LANGUAGE_UNAVAILABLE'])assert.equal(publicError(new Error(code)),code);
 assert.equal(publicError(new Error('file failed: PRIVATE_FIXTURE_CONTENT')),'IO_ERROR');
});

test('real search validation exposes finite regex rejection codes without echoing query details',async()=>{
 const parent=await realpath(os.tmpdir());
 const workspace=await realpath(await mkdtemp(path.join(parent,'hostdeck-regex-error-')));
 assert.equal(path.dirname(workspace),parent);
 try{
  const adapter=await FileAdapter.create({workspace});
  const context={ownerId:'regex-owner',deviceId:'regex-device',executorId:'regex-executor'};
  for(const [pattern,expected]of [['hdq27|','SEARCH_REGEX_FEATURE_DENIED'],['[','SEARCH_PATTERN_INVALID']]){
   let caught:unknown;
   try{await adapter.handle('hostdeck_search_files',{
    device_id:context.deviceId,path:'.',pattern,literal:false,mode:'files',
   },context);}catch(error){caught=error;}
   assert.ok(caught instanceof Error,'invalid pattern must be refused');
   assert.equal(publicError(caught),expected);
  }
  assert.equal(publicError(new Error('SEARCH_PATTERN_INVALID: PRIVATE_QUERY')),'IO_ERROR');
 }finally{
  assert.equal(path.dirname(workspace),parent);
  await rmdir(workspace); // own empty directory only
 }
});
