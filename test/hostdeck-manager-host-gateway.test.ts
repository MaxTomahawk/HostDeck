import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {Socket} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {AuditLog,TokenAuthority,PolicyGate,type Grant} from '../src/hostdeck/security.js';
import {HostDeckFacade,createHttpBoundary,MANAGER_APP_URI} from '../src/hostdeck/gateway.js';

const mime='text/html;profile=mcp-app';
const legacy='ui://hostdeck/management';

async function fixture(html?:string) {
  const root=await mkdtemp(path.join(os.tmpdir(),'hostdeck-manager-discovery-'));
  const audit=await AuditLog.open(path.join(root,'audit'));
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const issuer='https://issuer.example',resource='https://hostdeck.example/mcp';
  const authority=new TokenAuthority({issuer,audience:resource,jwks:createLocalJWKSet({
    keys:[{...await exportJWK(publicKey),kid:'fixture'}],
  })});
  const now=Math.floor(Date.now()/1000);
  async function token(scopes:string) {
    return new SignJWT({sub:'fixture',client_id:'fixture-client',scope:scopes})
      .setProtectedHeader({alg:'RS256',typ:'at+jwt',kid:'fixture'})
      .setIssuer(issuer).setAudience(resource).setIssuedAt(now)
      .setExpirationTime(now+120).sign(privateKey);
  }
  const ownerToken=await token('devices:read files:read');
  const filesOnlyToken=await token('files:read');
  let grants:Grant[]=[{issuer,subject:'fixture',clientId:'fixture-client',
    deviceId:'device_fixture',executorId:'executor_fixture',
    scopes:['devices:read','files:read'],expiresAt:now+120,revision:'fixture',
    broadUserAuthority:true,sessionIds:[1]}];
  const gate=new PolicyGate(authority,audit,async()=>grants);
  let effects=0;
  const facade=new HostDeckFacade({deviceId:'device_fixture',executorId:'executor_fixture',
    gate,appHtml:html,adapters:[
      {implementedTools:new Set(['hostdeck_device_status']),handle:async()=>{effects++;return {status:'ready'};}},
      {implementedTools:new Set(['hostdeck_list_providers']),handle:async()=>{effects++;return {providers:[],functions:[]};}},
    ]});
  const allowedHosts:string[]=[];
  const boundary=createHttpBoundary(facade,authority,{
    issuer,resource,allowedHosts,allowedOrigins:[],
  });
  const nodeHandler=toNodeHandler(boundary);
  const server=createServer((request,response)=>void nodeHandler(request,response));
  const sockets=new Set<Socket>();
  server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  const address=server.address();
  assert.ok(address&&typeof address==='object');
  const host='127.0.0.1:'+address.port;
  allowedHosts.push(host);
  return {
    root,audit,boundary,server,sockets,host,facade,
    ownerToken,filesOnlyToken,
    effects:()=>effects,
    revokeDevices:()=>{grants=grants.map(g=>({...g,scopes:['files:read']}));},
    async close(){
      await boundary.close();
      server.closeAllConnections();
      for(const socket of sockets)socket.destroy();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      audit.close();
      await rm(root,{recursive:true,force:true});
    },
  };
}

async function request(f:Awaited<ReturnType<typeof fixture>>,method:string,params:unknown={},
  token:string=f.ownerToken) {
  const response=await fetch('http://'+f.host+'/mcp',{
    method:'POST',
    headers:{authorization:'Bearer '+token,
      'content-type':'application/json',accept:'application/json, text/event-stream',
      'mcp-protocol-version':'2025-11-25'},
    body:JSON.stringify({jsonrpc:'2.0',id:Math.floor(Math.random()*100000)+1,method,params}),
  });
  const body=await response.text();
  const payload=body.split('\n').find(line=>line.startsWith('data:'));
  const data=JSON.parse(payload?payload.slice(5):body);
  return {httpStatus:response.status,data};
}

test('actual discovery exposes a single UI-render manager tool and preserves all data tools',async()=>{
  const f=await fixture('<main>Fixture manager app</main>');
  try {
    const listed=await request(f,'tools/list');
    assert.equal(listed.httpStatus,200);
    const tools=listed.data.result.tools as Array<{name:string;_meta?:Record<string,any>}>;
    assert.ok(tools.some(t=>t.name==='hostdeck_device_status'));
    assert.ok(tools.some(t=>t.name==='hostdeck_list_providers'));
    const renderers=tools.filter(t=>t._meta?.ui?.resourceUri);
    assert.deepEqual(renderers.map(t=>t.name),['hostdeck_open_manager']);
    assert.equal(renderers[0]._meta?.ui?.resourceUri,MANAGER_APP_URI);
    assert.equal(renderers[0]._meta?.['openai/outputTemplate'],MANAGER_APP_URI);
    assert.ok(tools.filter(t=>t.name!=='hostdeck_open_manager').every(t=>!t._meta),
      'all ordinary tools remain data-first even with an HTML app');
    const resources=await request(f,'resources/list');
    assert.deepEqual(resources.data.result.resources.map((r:{uri:string})=>r.uri),[MANAGER_APP_URI]);
    const html=await request(f,'resources/read',{uri:MANAGER_APP_URI});
    assert.equal(html.data.result.contents[0].mimeType,mime);
    assert.equal(html.data.result.contents[0].text,'<main>Fixture manager app</main>');
    const compat=await request(f,'resources/read',{uri:legacy});
    assert.equal(compat.data.result.contents[0].uri,legacy);
    assert.equal(compat.data.result.contents[0].mimeType,mime);
    assert.equal(f.effects(),0,'discovery and render-resource reads execute no device action');
  } finally {await f.close();}
});

test('open_manager read-only goes through real facade/PolicyGate with device binding',async()=>{
  const f=await fixture('<main>Manager</main>');
  try {
    const opened=await request(f,'tools/call',{name:'hostdeck_open_manager',
      arguments:{device_id:'device_fixture'}});
    assert.equal(opened.data.result.isError,undefined);
    const result=opened.data.result.structuredContent.result;
    assert.deepEqual(result,{device_id:'device_fixture',view:'providers'});
    assert.deepEqual(Object.keys(result).sort(),['device_id','view']);
    assert.equal(f.effects(),0,'no device command, preference write or lifecycle effect');
    const wrong=await request(f,'tools/call',{name:'hostdeck_open_manager',
      arguments:{device_id:'some_other_device'}});
    assert.equal(wrong.data.result.isError,true);
    assert.equal(wrong.data.result.content[0].text,'DENIED');
    const extra=await request(f,'tools/call',{name:'hostdeck_open_manager',
      arguments:{device_id:'device_fixture',view:'jobs'}});
    assert.equal(extra.data.result.isError,true);
    assert.equal(extra.data.result.content[0].text,'INVALID_ARGUMENTS');
    const limited=await request(f,'tools/list',{},f.filesOnlyToken);
    assert.ok(!limited.data.result.tools.some((t:{name:string})=>t.name==='hostdeck_open_manager'));
    const denied=await request(f,'tools/call',{name:'hostdeck_open_manager',
      arguments:{device_id:'device_fixture'}},f.filesOnlyToken);
    assert.equal(denied.data.result.isError,true);
    assert.equal(denied.data.result.content[0].text,'DENIED');
    const hidden=await request(f,'resources/list',{},f.filesOnlyToken);
    assert.deepEqual(hidden.data.result.resources,[]);
    f.revokeDevices();
    const revoked=await request(f,'tools/list');
    assert.ok(!revoked.data.result.tools.some((t:{name:string})=>t.name==='hostdeck_open_manager'));
    const deniedAfterRevocation=await request(f,'tools/call',{name:'hostdeck_open_manager',
      arguments:{device_id:'device_fixture'}});
    assert.equal(deniedAfterRevocation.data.result.isError,true);
    assert.equal(deniedAfterRevocation.data.result.content[0].text,'DENIED');
    assert.equal(f.effects(),0);
  }finally{await f.close();}
});

test('without bundled appHtml manager and UI resources are not discovered or callable',async()=>{
  const f=await fixture(undefined);
  try{
    const listed=await request(f,'tools/list');
    assert.ok(!listed.data.result.tools.some((t:{name:string})=>t.name==='hostdeck_open_manager'));
    assert.ok(listed.data.result.tools.every((t:{_meta?:unknown})=>!t._meta));
    const resources=await request(f,'resources/list');
    assert.deepEqual(resources.data.result.resources,[]);
    const opened=await request(f,'tools/call',{name:'hostdeck_open_manager',
      arguments:{device_id:'device_fixture'}});
    assert.equal(opened.data.result.isError,true);
    assert.equal(opened.data.result.content[0].text,'UNAVAILABLE');
    assert.equal(f.effects(),0);
  }finally{await f.close();}
});
