import {syntheticFullTextAttributes} from './fixtures/fulltext-test-native-attributes.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,access, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FullTextPort} from '../src/hostdeck/fulltext/wiring.js';
import type {FullTextConfig,FullTextAuthorizer,FullTextPrincipal} from '../src/hostdeck/fulltext/types.js';

test('fulltext provider stays dormant and fails closed on unapproved/revoked selected roots',async()=>{
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'hd-fulltext-port-')));
  const data=path.join(base,'chosen'),state=path.join(base,'state');
  await mkdir(data);await mkdir(state);
  const dbPath=path.join(state,'private.sqlite');
  const doc=path.join(data,'owner-marker.txt');
  const caller:FullTextPrincipal={ownerId:'fixture-owner',deviceId:'fixture-device',executorId:'fixture-executor'};
  let approved=false;
  let selected:FullTextConfig|null=null;
  const authorizer:FullTextAuthorizer=async req=>req.principal.ownerId==='fixture-owner'
    && req.principal.deviceId==='fixture-device' && req.principal.executorId==='fixture-executor';
  const port=new FullTextPort({
    loadSelectedConfig:async()=>selected,
    isOwnerConfirmed:async c=>approved&&c.ownerId===caller.ownerId,
    authorize:authorizer,
    nativeAttributes:syntheticFullTextAttributes,
  });
  try{
    await writeFile(doc,'owner fixture sunflower');
    assert.deepEqual(await port.preview(caller),{configured:false,reason:'ROOTS_NOT_SELECTED'});
    assert.equal(await access(dbPath).then(()=>true,()=>false),false);
    selected={indexFile:dbPath,roots:[data],formats:['.txt']};
    const p=await port.preview(caller);
    assert.ok('digest' in p);
    if(!('digest' in p))throw new Error('missing digest');
    assert.equal(await access(dbPath).then(()=>true,()=>false),false,'preview must remain read-only');
    await assert.rejects(port.confirm(caller,p.digest),/FULLTEXT_OWNER_CONFIRMATION_REQUIRED/);
    approved=true;
    await port.confirm(caller,p.digest);
    assert.equal((await port.status(caller)).state,'unstarted','confirmation is not automatic indexing');
    const id=(await port.start(caller)).runId;
    for(let i=0;i<10;i++){
      const receipt=await port.step(caller,id,4);
      if(receipt.state==='complete')break;
      assert.equal(receipt.state,'running');
    }
    assert.deepEqual((await port.query(caller,'sunflower')).results.map(r=>r.path),[doc]);
    selected=null;
    await assert.rejects(port.query(caller,'sunflower'),/FULLTEXT_OWNER_SELECTION_REVOKED/);
    selected={indexFile:dbPath,roots:[data],formats:['.txt']};
    approved=false;
    await assert.rejects(port.status(caller),/FULLTEXT_OWNER_SELECTION_REVOKED/);
  }finally{port.close();await rm(base,{recursive:true,force:true});}
});
