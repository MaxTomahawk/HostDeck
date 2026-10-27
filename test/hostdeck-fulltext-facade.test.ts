import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {AuditLog,TokenAuthority,PolicyGate,type Grant} from '../src/hostdeck/security.js';
import {HostDeckFacade,createHttpBoundary} from '../src/hostdeck/gateway.js';
import {FullTextAdapter} from '../src/hostdeck/fulltext/adapter.js';
import {FullTextNativeBridge} from '../src/hostdeck/fulltext-native-bridge.js';
import {inspectDesktopIdentity} from '../src/hostdeck/desktop.js';
import {FullTextSelectionStore} from '../src/hostdeck/fulltext/selection-store.js';
import {normalizeConfig} from '../src/hostdeck/fulltext/policy.js';
import {FULLTEXT_PROVIDER_ID,FULLTEXT_ENGINE_ID} from '../src/hostdeck/fulltext/wiring.js';

test('real HTTP MCP fulltext: dormant discovery, owner-approved index, actual result and revocations',async t=>{
  // All documents/config/grants are synthetic and remain within this one
  // disposable fixture. This is not a Windows install or personal drive scan.
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hd-fulltext-facade-')));
  const workspace=path.join(root,'workspace'),state=path.join(root,'writable-index-state'),protectedDir=path.join(root,'synthetic-protected-approvals');
  const corpus=path.join(root,'owner-selected-corpus'),other=path.join(root,'unselected');
  await Promise.all([workspace,state,protectedDir,corpus,other].map(dir=>fs.mkdir(dir)));
  const marker=path.join(corpus,'België_日本語_中文.txt'),forbidden=path.join(corpus,'restricted.txt');
  await fs.writeFile(marker,'Sunflower Café België 中文文件 السلام');
  await fs.writeFile(forbidden,'Hiddensecret document contents');
  const audit=await AuditLog.open(path.join(root,'audit'));
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const issuer='https://issuer.example',resource='https://hostdeck.example/mcp';
  const authority=new TokenAuthority({issuer,audience:resource,
    jwks:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'test-key'}]})});
  const expires=Math.floor(Date.now()/1000)+300;
  const token=await new SignJWT({sub:'owner',client_id:'client',scope:'fulltext:read fulltext:index'})
    .setProtectedHeader({alg:'RS256',kid:'test-key',typ:'at+jwt'}).setIssuer(issuer)
    .setAudience(resource).setIssuedAt().setExpirationTime(expires).sign(privateKey);
  const principal=await authority.verify(token);
  const ownerId=audit.identity([issuer,'owner','client']);
  let scopes=['fulltext:read','fulltext:index'],revision='r1',extraDenied=new Set<string>();
  let grants:Grant[]=[{issuer,subject:'owner',clientId:'client',deviceId:'device_ft',
    executorId:'exec_ft',scopes,expiresAt:expires,revision,broadUserAuthority:true,sessionIds:[1]}];
  const gate=new PolicyGate(authority,audit,async()=>grants.map(g=>({...g,scopes:[...scopes],revision})));
  let facade:HostDeckFacade;
  // Synthetic fixture qualifier is NOT an actual native Windows ACL proof.
  // Production FullTextAdapter supplies no verifier and remains dormant.
  let testOnlyBoundaryVerified=true;
  const syntheticBoundary=async()=>{
    if(!testOnlyBoundaryVerified)throw new Error('FULLTEXT_OWNER_ACL_UNQUALIFIED');
  };
  // With HOSTDECK_TEST_FULLTEXT_NATIVE_WORKER on Windows, this HTTP fixture
  // uses the real PR22 worker and Unicode filename. Protected owner approval
  // remains a clearly synthetic fixture only; do not claim ACL-positive PASS.
  const testNativeExecutable=process.env.HOSTDECK_TEST_FULLTEXT_NATIVE_WORKER;
  let nativeBridge:FullTextNativeBridge|undefined;
  if(testNativeExecutable){
    assert.equal(process.platform,'win32','native HTTP test requires Windows');
    const executable=path.resolve(testNativeExecutable);
    const actual=await inspectDesktopIdentity(executable);
    const hash=createHash('sha256');
    for await(const piece of createReadStream(executable))hash.update(piece);
    // Test-only observed hash. Production requires independently installer-pinned
    // workerSha256, never the hash of the current file as its own trust anchor.
    nativeBridge=new FullTextNativeBridge({
      workerExecutable:executable,workerSha256:hash.digest('hex'),
      expectedExecutor:{sid:actual.sid,logonId:actual.logon_id,sessionId:actual.session_id},
    });
    t.diagnostic('Real native Unicode attribute path enabled; protected owner ACL proof remains synthetic.');
  }
  const metadata=nativeBridge??{attributes:async(paths:readonly string[],authorize:(file:string)=>Promise<boolean>)=>{
    for(const item of paths)if(await authorize(item)!==true)throw new Error('FULLTEXT_DENIED');
    return paths.map((_,index)=>({index,status:'ok' as const,hidden:false,system:false,
      reparse:false,hidden_component:false,system_component:false,directory:false}));
  }};
  const adapter=new FullTextAdapter({
    stateDirectory:state,workspace,
    protectedOwnerDirectory:protectedDir,
    verifyProtectedOwnerAcl:syntheticBoundary,
    nativeAttributes:metadata,
    reauthorize:(name,args)=>facade.reauthorize(name,args),
    additionalReadDeny:async r=>extraDenied.has(r.path),
  });
  facade=new HostDeckFacade({deviceId:'device_ft',executorId:'exec_ft',gate,adapters:[adapter]});
  const store=new FullTextSelectionStore(protectedDir,workspace,state,syntheticBoundary);
  const owner={ownerId,deviceId:'device_ft',executorId:'exec_ft'};
  const allowedHosts:string[]=[];
  const boundary=createHttpBoundary(facade,authority,{issuer,resource,allowedHosts,allowedOrigins:[]});
  const handler=toNodeHandler(boundary);
  const server=http.createServer((req,res)=>void handler(req,res));
  await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  allowedHosts.push('127.0.0.1:'+port);
  t.after(async()=>{
    adapter.close();await nativeBridge?.close();await boundary.close();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    audit.close();await fs.rm(root,{recursive:true,force:true});
  });
  let id=0;
  const rpc=async(method:string,params:unknown={})=>{
    const response=await fetch('http://127.0.0.1:'+port+'/mcp',{
      method:'POST',
      headers:{authorization:'Bearer '+token,'content-type':'application/json',
        accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'},
      body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),
    });
    const raw=await response.text();
    const data=(raw.startsWith('event:')||raw.startsWith('data:'))?
      JSON.parse(raw.split('\n').find(line=>line.startsWith('data:'))!.slice(5)):JSON.parse(raw);
    return {http:response.status,payload:data};
  };
  const call=async(name:string,fields:Record<string,unknown>={})=>{
    const response=await rpc('tools/call',{name:'hostdeck_fulltext_'+name,arguments:{device_id:'device_ft',...fields}});
    return response.payload.result as {isError?:boolean;structuredContent?:{result:unknown};content?:Array<{text:string}>};
  };

  // Without an actual new local grant, an installed-but-dormant contract is
  // hidden. No default roots, no database and no index side effects.
  scopes=[];revision='r2';
  assert.deepEqual((await rpc('tools/list')).payload.result.tools,[]);
  const noGrant=await call('preview');
  assert.equal(noGrant.isError,true);
  scopes=['fulltext:read','fulltext:index'];revision='r3';
  assert.equal((await rpc('tools/list')).payload.result.tools.length,9);
  assert.deepEqual((await call('status')).structuredContent?.result, {
    state:'unconfigured',provider:'fulltext_sqlite',engine:FULLTEXT_ENGINE_ID,
    configured:false,actualFreshness:'not_monitored',
  });
  const empty=await call('preview');
  assert.equal((empty.structuredContent?.result as {configured?:boolean}).configured,false);
  await assert.rejects(fs.stat(store.expectedIndexFile({...owner,sessionId:1})),{code:'ENOENT'});

  // A selected-root record is protected input, never an MCP parameter or a
  // caller boolean. It is not approval: no DB is created by preview.
  const selected={version:1,owner,selection:{roots:[corpus],formats:['.txt'],
    budgets:{maxOperationsPerStep:4,maxStepMilliseconds:6_000}}};
  await fs.writeFile(store.selectionFile,JSON.stringify(selected));
  const unqualifiedStore=new FullTextSelectionStore(protectedDir,workspace,state);
  assert.equal(await unqualifiedStore.selected({...owner,sessionId:1}),null,
    'no native effective ACL verifier means no approved selection');
  const config=await store.selected({...owner,sessionId:1});
  assert.ok(config);
  const digest=normalizeConfig(config!).digest;
  const preview=await call('preview');
  assert.equal((preview.structuredContent?.result as {digest?:string}).digest,digest);
  assert.equal((await call('confirm',{digest})).isError,true);
  await assert.rejects(fs.stat(config!.indexFile),{code:'ENOENT'});

  await fs.writeFile(store.approvalFile,JSON.stringify({
    version:1,owner,configDigest:digest,approvalId:randomUUID(),
    approvedAt:new Date().toISOString(),source:'protected-local-owner-approval',
  }));
  const admitted=await call('confirm',{digest});
  assert.equal(admitted.isError,undefined,JSON.stringify(admitted.content));
  const confirmed=admitted.structuredContent?.result as {ready:boolean;provider:string;engine:string};
  assert.equal(confirmed.ready,true);
  assert.match(FULLTEXT_PROVIDER_ID,/^[a-z][a-z0-9_-]*$/);
  assert.equal(confirmed.provider,FULLTEXT_PROVIDER_ID);
  assert.equal(confirmed.engine,FULLTEXT_ENGINE_ID);
  const started=await call('start');
  assert.equal(started.isError,undefined,JSON.stringify(started.content));
  const run=(started.structuredContent?.result as {runId:string}).runId;
  let completed=false;
  for(let n=0;n<40;n++){
    const step=await call('step',{run_id:run,max_operations:4});
    assert.equal(step.isError,undefined,JSON.stringify(step.content));
    if((step.structuredContent?.result as {state:string}).state==='complete'){completed=true;break;}
  }
  assert.equal(completed,true);
  const matches=await call('query',{query:'Sunflower'});
  assert.equal(matches.isError,undefined,JSON.stringify(matches.content));
  const visible=(matches.structuredContent?.result as {results:Array<{path:string;snippet:string}>}).results;
  assert.deepEqual(visible.map(item=>item.path),[marker]);
  assert.match(visible[0].snippet,/Sunflower/);

  // Revoked file policy cannot expose filename, snippet or visible counter;
  // the SQLite bytes remain until authorized index maintenance/rescan.
  extraDenied.add(marker);extraDenied.add(forbidden);
  const deniedResult=await call('query',{query:'Sunflower'});
  assert.deepEqual((deniedResult.structuredContent?.result as {results:unknown[]}).results,[]);
  const filtered=await call('status');
  const status=filtered.structuredContent?.result as {visibleDocuments:number;coverage:string};
  assert.equal(status.visibleDocuments,0);
  assert.equal(status.coverage,'partial_or_unverified');
  extraDenied.clear();

  // New index grant revocation leaves read-only results available but prevents
  // further scanning. Full read-grant revocation denies all previews/results.
  scopes=['fulltext:read'];revision='r4';
  assert.equal((await call('start')).isError,true);
  assert.equal((await call('query',{query:'Sunflower'})).isError,undefined);
  scopes=[];revision='r5';
  assert.equal((await call('query',{query:'Sunflower'})).isError,true);
  assert.deepEqual((await rpc('tools/list')).payload.result.tools,[]);
  scopes=['fulltext:read','fulltext:index'];revision='r6';

  // Owner approval provenance can be revoked independently of current MCP
  // grants: the protected boundary itself must remain verified.
  testOnlyBoundaryVerified=false;
  assert.equal((await call('query',{query:'Sunflower'})).isError,true);
  assert.equal((await call('confirm',{digest})).isError,true);
  testOnlyBoundaryVerified=true;

  extraDenied.add(corpus);
  const rootRevoked=await call('query',{query:'Sunflower'});
  assert.equal(rootRevoked.isError,true);
  assert.equal((await call('status')).isError,true);
  extraDenied.clear();

  // Protected root selection changes invalidate the previously approved
  // digest before any cached file results can be returned.
  await fs.mkdir(path.join(other,'new'));
  await fs.writeFile(store.selectionFile,JSON.stringify({...selected,selection:{...selected.selection,roots:[other]}}));
  const changed=await call('query',{query:'Sunflower'});
  assert.equal(changed.isError,true);
  assert.match(changed.content?.[0]?.text??'',/FULLTEXT_OWNER_SELECTION_REVOKED/);
  assert.equal((await call('status')).isError,true);
});
