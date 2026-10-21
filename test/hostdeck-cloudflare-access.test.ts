import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {AuditLog,TokenAuthority,PolicyGate,type Grant} from '../src/hostdeck/security.js';
import {HostDeckFacade,createHttpBoundary} from '../src/hostdeck/gateway.js';
import {UserRuntime} from '../src/hostdeck/user-runtime.js';

test('Cloudflare Access assertion is app/audience bound and still requires explicit HostDeck grant',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hostdeck-cf-access-'));
  const audit=await AuditLog.open(path.join(directory,'audit'));
  let runtime:UserRuntime;
  t.after(async()=>{await runtime?.dispose();audit.close();await fs.rm(directory,{recursive:true,force:true});});
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const issuer='https://fixture.cloudflareaccess.com',audience='app-aud-fixture',clientId=`cloudflare-access:${audience}`;
  const authority=new TokenAuthority({issuer,audience:'unused-native-resource',jwks:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'cf-fixture'}]})});
  const now=Math.floor(Date.now()/1000);
  const assertion=async(aud:string,exp=now+120,iat=now,type='app',headerType:string|null='JWT')=>new SignJWT({sub:'owner-subject',type})
    .setProtectedHeader({alg:'RS256',...(headerType===null?{}:{typ:headerType}),kid:'cf-fixture'}).setIssuer(issuer).setAudience(aud).setIssuedAt(iat).setExpirationTime(exp).sign(privateKey);
  let grants:Grant[]=[{issuer,subject:'owner-subject',clientId,deviceId:'device',executorId:'executor',scopes:['files:read','files:write'],expiresAt:now+300,revision:'1',broadUserAuthority:true,sessionIds:[]}];
  const gate=new PolicyGate(authority,audit,async()=>grants);
  let facade:HostDeckFacade;
  runtime=await UserRuntime.create({workspace:directory,deviceId:'device',environment:{},shells:{},authorize:async(name,args)=>{await facade.reauthorize(name,args);return true;}});
  facade=new HostDeckFacade({deviceId:'device',executorId:'executor',gate,adapters:[{implementedTools:runtime.implementedTools,handle:(name,args)=>runtime.invoke(name,args)}]});
  const allowedHosts:string[]=[];
  const boundary=createHttpBoundary(facade,authority,{issuer,resource:'https://hostdeck.example/mcp',allowedHosts,allowedOrigins:[],
    cloudflareAccess:{audience,scopes:['files:read','files:write'],clientId}});
  const nodeHandler=toNodeHandler(boundary),server=http.createServer((req,res)=>void nodeHandler(req,res));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await boundary.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const port=(server.address() as {port:number}).port;allowedHosts.push(`127.0.0.1:${port}`);
  let id=0;
  const call=async(token:string,authorization?:string)=>{
    const response=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{...(token?{'cf-access-jwt-assertion':token}:{}),...(authorization?{authorization}:{}),'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'hostdeck_write_file',arguments:{device_id:'device',path:'cf-write.txt',content:'authorized'}}})});
    const text=await response.text();return{status:response.status,data:response.status===200?(text.startsWith('event:')||text.startsWith('data:')?JSON.parse(text.split('\n').find(line=>line.startsWith('data:'))!.slice(5)):JSON.parse(text)):text};
  };
  assert.equal((await call('')).status,403);
  assert.equal((await call(await assertion('wrong-audience'))).status,403);
  assert.equal((await call(await assertion(audience,now-1))).status,403);
  // Managed OAuth assertions can exceed a locally guessed session-duration ceiling.
  const longLived=await assertion(audience,now+7*86_400);
  assert.equal((await call(longLived)).status,200);
  assert.equal((await call(await assertion(audience,now+1000))).status,200);
  assert.equal((await call(await assertion(audience,now+180,now+60))).status,403);
  const tampered=longLived.split('.');tampered[2]=(tampered[2][0]==='A'?'B':'A')+tampered[2].slice(1);
  assert.equal((await call(tampered.join('.'))).status,403);
  assert.equal((await call(await assertion(audience,now+120,now,'user'))).status,403);
  assert.equal((await call(await assertion(audience,now+120,now,'app','at+jwt'))).status,403);
  assert.equal((await call('', 'Bearer opaque-oauth-token')).status,403);
  // Real Cloudflare Access application assertions omit the optional JOSE typ header.
  assert.equal((await call(await assertion(audience,now+120,now,'app',null))).status,200);
  const valid=await call(await assertion(audience));assert.equal(valid.status,200);assert.equal(valid.data.result.isError,undefined);
  assert.equal(await fs.readFile(path.join(directory,'cf-write.txt'),'utf8'),'authorized');
  const forwardedOpaque=await call(await assertion(audience),'Bearer opaque-oauth-token');assert.equal(forwardedOpaque.status,200);
  assert.equal(forwardedOpaque.data.result.isError,undefined);
  // A longer provider assertion never extends a HostDeck grant or its device binding.
  await fs.writeFile(path.join(directory,'cf-write.txt'),'grant-expired');
  grants=grants.map(grant=>({...grant,expiresAt:now-1}));
  const expiredGrant=await call(longLived);assert.equal(expiredGrant.status,200);assert.equal(expiredGrant.data.result.isError,true);
  assert.equal(await fs.readFile(path.join(directory,'cf-write.txt'),'utf8'),'grant-expired');
  grants=[];
  const denied=await call(await assertion(audience));assert.equal(denied.status,200);assert.equal(denied.data.result.isError,true);
  assert.equal(await fs.readFile(path.join(directory,'cf-write.txt'),'utf8'),'grant-expired');
});
