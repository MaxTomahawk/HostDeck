import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {FullTextSelectionStore} from '../src/hostdeck/fulltext/selection-store.js';
import {normalizeConfig} from '../src/hostdeck/fulltext/policy.js';

test('selection/approval need separate protected ancestor and qualified ACL, not JSON/caller boolean',async()=>{
  const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hd-owner-boundary-')));
  const workspace=path.join(tmp,'workspace'),protectedDir=path.join(tmp,'synthetic-protected'),
    indexState=path.join(tmp,'ordinary-user-writable-index'),corpus=path.join(tmp,'own-corpus');
  await Promise.all([workspace,protectedDir,indexState,corpus].map(value=>fs.mkdir(value)));
  const owner={ownerId:'fixture-owner',deviceId:'fixture-device',executorId:'fixture-executor'};
  const principal={...owner,sessionId:1};
  let simulatedAclValid=true;
  const testOnlyVerifier=async(input:{protectedDirectory:string;selectionFile:string;approvalFile:string;indexDirectory:string})=>{
    assert.equal(input.protectedDirectory,protectedDir);
    assert.equal(input.indexDirectory,indexState);
    // This is ONLY an authorization oracle, NOT a physical Windows ACL check.
    if(!simulatedAclValid)throw new Error('FULLTEXT_OWNER_ACL_UNQUALIFIED');
  };
  try{
    assert.throws(()=>new FullTextSelectionStore(indexState,workspace,indexState),
      /FULLTEXT_OWNER_CONFIG_INDEX_OVERLAP/);
    assert.throws(()=>new FullTextSelectionStore(path.join(workspace,'config'),workspace,indexState),
      /FULLTEXT_STATE_INSIDE_WORKSPACE/);

    const unqualified=new FullTextSelectionStore(protectedDir,workspace,indexState);
    const testStore=new FullTextSelectionStore(protectedDir,workspace,indexState,testOnlyVerifier);
    const selection={version:1,owner,selection:{roots:[corpus],formats:['.txt']}};
    await fs.writeFile(testStore.selectionFile,JSON.stringify(selection));
    // Ordinary-actor write access to these test records is intentionally
    // unrestricted; absent native verifier, both discovery and approval fail.
    assert.equal(await unqualified.selected(principal),null);
    assert.equal(await unqualified.confirmed(principal,'a'.repeat(64)),false);
    const selected=await testStore.selected(principal);
    assert.ok(selected);
    assert.equal(selected!.indexFile,testStore.expectedIndexFile(principal));
    assert.ok(selected!.indexFile.startsWith(indexState));
    assert.equal(selected!.indexFile.startsWith(protectedDir),false);
    const digest=normalizeConfig(selected!).digest;
    const approval={version:1,owner,configDigest:digest,approvalId:randomUUID(),
      approvedAt:new Date().toISOString(),source:'protected-local-owner-approval'};
    assert.equal(await testStore.confirmed(principal,digest),false,'selection is not approval');
    await fs.writeFile(testStore.approvalFile,JSON.stringify(approval));
    assert.equal(await unqualified.confirmed(principal,digest),false,
      'synthetic JSON approval alone never satisfies owner authorization');
    assert.equal(await testStore.confirmed(principal,digest),true,
      'unit fake qualifier exercises selection digest logic only');

    simulatedAclValid=false; // revoked/failed ancestor ACL proof
    await assert.rejects(testStore.selected(principal),/FULLTEXT_OWNER_ACL_UNQUALIFIED/);
    await assert.rejects(testStore.confirmed(principal,digest),/FULLTEXT_OWNER_ACL_UNQUALIFIED/);
    simulatedAclValid=true;
    await fs.writeFile(testStore.selectionFile,JSON.stringify({...selection,
      selection:{roots:[corpus],formats:['.txt'],includeHidden:true}}));
    assert.equal(await testStore.confirmed(principal,digest),false,
      'changing selected permissions invalidates prior approval');
    await fs.rm(testStore.approvalFile);
    assert.equal(await testStore.confirmed(principal,digest),false,'deleting approved record revokes');
  }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
