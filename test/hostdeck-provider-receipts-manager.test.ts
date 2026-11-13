import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm,realpath,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import puppeteer from 'puppeteer';
import {ProviderRegistry} from '../src/hostdeck/providers.js';
import {FileAdapter} from '../src/hostdeck/files.js';
import {assertProviderSnapshot,assertProviderChange,currentProviderChange} from '../ui/newtree/extension-catalog.js';

test('receipt presentation rejects malformed or foreign history and blocks ABA restoration',()=>{
 const change={id:'11111111-1111-4111-8111-111111111111',kind:'preference',target:'files.name',before:null,after:'everything',revision:1,changed:true,createdAt:'2026-11-13T00:00:00.000Z'};
 const raw={providers:[],functions:[{capability:'files.name',preference:'everything',selected:'everything',default:'direct',revision:1}],changes:[change],changeRetention:200};
 const view=assertProviderSnapshot(raw),receipt=assertProviderChange(change);
 assert.equal(currentProviderChange(view,receipt),true);
 assert.equal(currentProviderChange({...view,changes:[]},receipt),false,'equal value/revision in another history is not receipt ownership');
 assert.equal(currentProviderChange({...view,functions:[{...view.functions[0],revision:3}]},receipt),false);
 for(const patch of [{before:true},{changed:false},{revision:-1},{createdAt:'<img onerror=bad>'},{kind:'enablement'},{target:'outside'}])
  assert.throws(()=>assertProviderChange({...change,...patch}),/PROVIDER_SNAPSHOT_INVALID/);
 assert.throws(()=>assertProviderSnapshot({...raw,changes:[change,change]}),/PROVIDER_SNAPSHOT_INVALID/);
 assert.throws(()=>assertProviderSnapshot({...raw,changeRetention:Infinity}),/PROVIDER_SNAPSHOT_INVALID/);
});

test('real browser and SQLite: durable restoration, concurrent ABA, lost acknowledgement and context isolation',
 {skip:!process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE,timeout:90_000},async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'hostdeck-provider-browser-')));
 const context={ownerId:'owned',deviceId:'owned-device',executorId:'owned-executor'};
 let browser:Awaited<ReturnType<typeof puppeteer.launch>>|undefined;
 let race=false;const calls:{name:string;args:any}[]=[];
 const workspace=path.join(root,'workspace');await mkdir(workspace);
 const registry=await ProviderRegistry.open(path.join(root,'providers.sqlite'));
 const adapter=await FileAdapter.create({workspace,providers:registry,reauthorize:async()=>{}});
 const bundle=await build({stdin:{contents:`
  import{mountExtensionManager}from'./ui/newtree/extension-manager.ts';
  const f=window.fixture={device:'owned-device',calls:[],loseAck:false,changeDevice:false};
  mountExtensionManager(document.querySelector('main'),{deviceId:()=>f.device,isCurrent:()=>true,
   call:async(name,args={})=>{
    f.calls.push({name,args});const response=await fetch('/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args:{device_id:f.device,...args}})});
    const value=await response.json();if(!response.ok)throw Error('FIXTURE_REFUSAL');
    if(name.startsWith('hostdeck_set_')){if(f.changeDevice){f.changeDevice=false;f.device='other-device';}if(f.loseAck){f.loseAck=false;throw Error('FIXTURE_ACK_LOST');}}
    return value;
   }});`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
 const css=await readFile('ui/newtree/styles.css','utf8');
 const server=createServer(async(req,res)=>{
  try{
   if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
   if(req.url==='/tool'){
    const parts:Buffer[]=[];for await(const part of req)parts.push(part);const {name,args}=JSON.parse(Buffer.concat(parts).toString());calls.push({name,args});
    if(name==='hostdeck_device_status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ready'}));return;}
    if(race&&name==='hostdeck_set_provider_preference'){
     race=false;await registry.set(context,'files.name','direct');await registry.set(context,'files.name',null);
    }
    const value=await adapter.handle(name,args,context);res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return;
   }
   res.setHeader('content-type','text/html');res.end('<!doctype html><style>'+css+'</style><main></main><script type="module" src="/app.js"></script>');
  }catch{res.statusCode=409;res.setHeader('content-type','application/json');res.end('{"error":"FIXTURE_REFUSAL"}');}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  browser=await puppeteer.launch({executablePath:process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE,headless:true,args:['--no-first-run','--disable-background-networking']});
  const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  const url='http://127.0.0.1:'+(server.address() as any).port;
  const click=async(text:string)=>{
   await page.evaluate(label=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===label);if(!b||b.disabled)throw Error('BUTTON_UNAVAILABLE');b.click();},text);
  };
  const settled=()=>page.waitForFunction(()=>!document.querySelector('#extension-live-status')?.getAttribute('aria-busy')||document.querySelector('#extension-live-status')?.getAttribute('aria-busy')==='false');
  const ready=()=>page.waitForFunction(()=>document.body.textContent?.includes('Live status read from HostDeck'));
  const restores=()=>page.$$eval('article[data-change-id] button',buttons=>buttons.filter(b=>!(b as HTMLButtonElement).disabled).length);
  await page.goto(url);await ready();
  await click('Functions and preferences');
  await page.select('#provider-preference','everything');await page.click('#provider-apply');
  await page.waitForFunction(()=>document.body.textContent?.includes('Preference verified on readback'));
  assert.equal((await registry.snapshot(context)).preferences[0].revision,1);
  await page.reload();await ready();await click('Changes');
  assert.equal(await page.$$eval('article[data-change-id]',items=>items.length),1,'history survives closing/reopening the view');
  assert.equal(await restores(),1);
  await page.click('article[data-change-id] button');
  await page.waitForFunction(()=>document.body.textContent?.includes('Restoration verified'));
  assert.equal((await registry.snapshot(context)).preferences[0].provider,null);
  assert.equal((await registry.snapshot(context)).preferences[0].revision,2);
  assert.equal(await restores(),1,'superseded receipts cannot restore');

  // Another writer changes away and back after UI preflight, before SQL commit.
  race=true;const writesBefore=calls.filter(c=>c.name==='hostdeck_set_provider_preference').length;
  await page.click('article[data-change-id] button:not([disabled])');
  await page.waitForFunction(()=>document.body.textContent?.includes('Restoration unconfirmed'));
  assert.equal((await registry.snapshot(context)).preferences[0].revision,4);
  assert.equal((await registry.snapshot(context)).preferences[0].provider,null,'the stale restore did not overwrite external ABA');
  assert.equal(calls.filter(c=>c.name==='hostdeck_set_provider_preference').length,writesBefore+1,'one refused request, no replay');
  assert.equal(await restores(),0);
  await click('Refresh live providers');await ready();await settled();

  // A real committed write loses its acknowledgement: all further effects lock.
  await click('Functions and preferences');await page.select('#provider-preference','everything');
  await page.evaluate(()=>{(window as any).fixture.loseAck=true;});await page.click('#provider-apply');
  await page.waitForFunction(()=>document.body.textContent?.includes('Refresh to reconcile'));
  assert.equal((await registry.snapshot(context)).preferences[0].revision,5);
  assert.equal(await page.$eval('#provider-apply',b=>(b as HTMLButtonElement).disabled),true);
  await click('Changes');assert.equal(await restores(),0);
  const countBeforeRefresh=calls.filter(c=>c.name.startsWith('hostdeck_set_')).length;
  await click('Refresh live providers');await ready();await settled();
  await page.waitForFunction(()=>document.querySelectorAll('article[data-change-id]').length===5);
  assert.equal(calls.filter(c=>c.name.startsWith('hostdeck_set_')).length,countBeforeRefresh);

  // Device changes while the actual restoration is in flight: no follow-up read.
  const oldId=(await registry.snapshot(context)).changes[0].id;
  await page.evaluate(()=>{(window as any).fixture.changeDevice=true;});
  await page.click('article[data-change-id] button:not([disabled])');
  await page.waitForFunction(()=>!(window as any).fixture.device.includes('owned'));
  await page.waitForFunction(()=>document.querySelectorAll('article[data-change-id]').length===0);
  assert.equal(calls.at(-1)?.name,'hostdeck_set_provider_preference');
  assert.equal(await page.evaluate(id=>document.body.textContent?.includes(id),oldId),false);
  assert.equal((await registry.snapshot(context)).preferences[0].revision,6);
  assert.deepEqual(errors,[]);
 }finally{
  await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  assert.equal(path.dirname(root),await realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('hostdeck-provider-browser-'));
  await rm(root,{recursive:true,force:true});
 }
});
