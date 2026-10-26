/**
 * Real bundled MCP Apps iframe with SDK AppBridge.sendToolInput/sendToolResult.
 * The fixture owns its HTTP listener/browser only and never opens installed
 * HostDeck or any actual ordinary-chat manager panel.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';
import puppeteer, { type Browser } from 'puppeteer-core';

const executable=process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE;
const TEST_LIMIT_MS=70_000;
const STEP_LIMIT_MS=12_000;
const CLOSE_MS=4_000;

async function bounded<T>(label:string,promise:Promise<T>,ms:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([
    promise,
    new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('HOSTED_UI_FIXTURE_TIMEOUT '+label)),ms);
    }),
  ]);}finally{if(timer)clearTimeout(timer);}
}

test('100 supported SDK notifications do not remount iframe or steal user navigation',{
  skip:executable?false:'HOSTDECK_TEST_BROWSER_EXECUTABLE must target an existing test browser',
  timeout:TEST_LIMIT_MS,
},async t=>{
  const root=process.cwd();
  let number=0,firstFailure:string|undefined;
  async function step<T>(name:string,run:()=>Promise<T>,ms=STEP_LIMIT_MS):Promise<T>{
    const sequence=++number;
    t.diagnostic('Hosted UI step '+sequence+' START '+name);
    try{
      const result=await bounded(name,Promise.resolve().then(run),ms);
      t.diagnostic('Hosted UI step '+sequence+' PASS '+name);
      return result;
    }catch(error){
      firstFailure??=name;
      t.diagnostic('Hosted UI step '+sequence+' FAIL '+name+' '+
        (error instanceof Error?error.message:'unknown'));
      throw error;
    }
  }

  // Build from current TypeScript directly into memory; stale generated app.js
  // on the source branch is neither executed nor mistaken for a fresh bundle.
  const [view,host]=await step('esbuild guest and AppBridge fixture, memory only',
    ()=>Promise.all([
      build({entryPoints:['ui/newtree/app.ts'],bundle:true,format:'esm',platform:'browser',
        minify:true,legalComments:'eof',write:false}),
      build({entryPoints:['test/fixtures/hostdeck-manager-host-bridge.ts'],bundle:true,
        format:'esm',platform:'browser',minify:true,legalComments:'eof',write:false}),
    ]),18_000);
  const guestCode=view.outputFiles[0].text,hostCode=host.outputFiles[0].text;
  const server=createServer(async(request,response)=>{
    try{
      const route=(request.url??'').split('?')[0];
      if(route==='/host.html'){
        response.writeHead(200,{'content-type':'text/html','cache-control':'no-store'}).end(
          '<!doctype html><html><head><meta charset="utf-8"></head><body>'+
          '<iframe id="hosted-app" title="Isolated HostDeck manager" '+
          'style="width:900px;height:680px"></iframe>'+
          '<script type="module" src="/host-fixture.js"></script></body></html>');
        return;
      }
      if(route==='/host-fixture.js'||route==='/ui/app.js'){
        response.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'})
          .end(route==='/host-fixture.js'?hostCode:guestCode);
        return;
      }
      if(route==='/ui/index.html'||route==='/ui/styles.css'){
        const name=path.basename(route);
        const bytes=await readFile(path.join(root,'ui','newtree',name));
        response.writeHead(200,{'content-type':name.endsWith('.html')?'text/html':'text/css',
          'cache-control':'no-store'}).end(bytes);
        return;
      }
      response.writeHead(404).end('Isolated fixture: unknown route');
    }catch{response.writeHead(500).end('Isolated fixture server error');}
  });
  const sockets=new Set<Socket>();
  server.on('connection',socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  });
  let browser:Browser|undefined,launchPending:Promise<Browser>|undefined;
  let failure:unknown;
  try{
    await step('start private loopback HTTP listener',()=>new Promise<void>((resolve,reject)=>{
      const fail=(error:Error)=>{server.off('listening',ready);reject(error)};
      const ready=()=>{server.off('error',fail);resolve()};
      server.once('error',fail);server.once('listening',ready);
      server.listen(0,'127.0.0.1');
    }),5_000);
    const addr=server.address();
    assert.ok(addr&&typeof addr==='object');
    browser=await step('launch only this fixture browser',()=>{
      launchPending=puppeteer.launch({executablePath:path.resolve(executable!),
        headless:true,args:['--no-sandbox'],timeout:15_000});
      return launchPending;
    },18_000);
    const page=await step('load official SDK-hosted iframe',async()=>{
      const page=await browser!.newPage();
      page.setDefaultTimeout(6_000);
      page.setDefaultNavigationTimeout(8_000);
      await page.goto('http://127.0.0.1:'+addr.port+'/host.html',{
        waitUntil:'domcontentloaded',timeout:8_000});
      await page.waitForFunction(()=>(window as any).__hostdeckFixture?.ready===true);
      return page;
    },15_000);
    await step('set DOM mount observer before first result',()=>page.evaluate(()=>{
      (window as any).__hostdeckFixture.monitor();
    }));
    await step('apply first matching tool input/result through SDK',async()=>{
      await page.evaluate(async()=>{await (window as any).__hostdeckFixture.sendInitial()});
      await page.waitForFunction(()=>document.querySelector<HTMLIFrameElement>('#hosted-app')
        ?.contentDocument?.querySelector('#provider-status')?.textContent?.includes('Live status read'));
      const stats=await page.evaluate(()=>(window as any).__hostdeckFixture.snapshot());
      assert.equal(stats.managerMounts,1);
      assert.equal(stats.providerRequests,1);
      assert.equal(stats.managerCount,1);
      assert.equal(stats.device,'fixture-device');
      assert.deepEqual(stats.unexpectedRequests,[]);
    });
    await step('user navigates to Files with a retained input',async()=>{
      await page.evaluate(()=>{
        const iframe=document.querySelector<HTMLIFrameElement>('#hosted-app')!;
        const doc=iframe.contentDocument!;
        (doc.querySelector('nav button[data-view="files"]') as HTMLButtonElement).click();
        (doc.querySelector('#file-path') as HTMLInputElement).value='keep-user-navigation.txt';
      });
      const stats=await page.evaluate(()=>(window as any).__hostdeckFixture.snapshot());
      assert.equal(stats.fileInput,'keep-user-navigation.txt');
      assert.equal(stats.managerCount,0);
    });
    const prior=await page.evaluate(()=>(window as any).__hostdeckFixture.snapshot());
    await step('replay 100 identical real SDK input/result notifications',async()=>{
      await page.evaluate(async()=>{await (window as any).__hostdeckFixture.sendRepeated(100)});
      const after=await page.evaluate(()=>(window as any).__hostdeckFixture.snapshot());
      assert.equal(after.managerMounts,1,'duplicate cannot remount manager');
      assert.equal(after.providerRequests,1,'duplicate cannot fetch providers');
      assert.equal(after.managerCount,0,'Files remains active');
      assert.equal(after.fileInput,'keep-user-navigation.txt','navigation input preserved');
      assert.equal(after.device,'fixture-device');
      assert.equal(after.visibleStatus,prior.visibleStatus,'duplicate leaves status untouched');
      assert.equal(after.totalDomNodes,prior.totalDomNodes,'no DOM accumulation');
      assert.deepEqual(after.unexpectedRequests,[]);
      t.diagnostic('Hosted fixture counts '+JSON.stringify({
        beforeDom:prior.totalDomNodes,afterDom:after.totalDomNodes,
        mounts:after.managerMounts,providerRequests:after.providerRequests,
        heapBeforeBytes:prior.heapBytes,heapAfterBytes:after.heapBytes,
      }));
    },18_000);
    await step('reject malformed, mismatched, extra-authority and error SDK messages',async()=>{
      await page.evaluate(async()=>{await (window as any).__hostdeckFixture.sendInvalid()});
      const stats=await page.evaluate(()=>(window as any).__hostdeckFixture.snapshot());
      assert.equal(stats.managerMounts,1);
      assert.equal(stats.providerRequests,1);
      assert.equal(stats.managerCount,0);
      assert.equal(stats.fileInput,'keep-user-navigation.txt');
      assert.equal(stats.device,'fixture-device');
      assert.equal(stats.visibleStatus,prior.visibleStatus,'invalid input/result must not affect UI status');
      assert.equal(stats.totalDomNodes,prior.totalDomNodes);
      assert.deepEqual(stats.unexpectedRequests,[]);
    });
    await step('close test-only SDK bridge',async()=>{
      await page.evaluate(async()=>{await (window as any).__hostdeckFixture.close()});
    });
  }catch(error){failure=error;throw error;}
  finally{
    t.diagnostic('Hosted fixture teardown START'+(firstFailure?'; first failure: '+firstFailure:''));
    const problems:string[]=[];
    if(!browser&&launchPending){
      void launchPending.then(async owned=>{
        try{await bounded('late test browser close',owned.close(),CLOSE_MS)}
        catch{owned.process()?.kill('SIGKILL')}
      }).catch(()=>{});
    }
    if(browser){
      try{await bounded('test browser close',browser.close(),CLOSE_MS)}
      catch{browser.process()?.kill('SIGKILL');problems.push('test-owned browser force-closed')}
    }
    const closed=new Promise<void>(resolve=>{
      try{server.close(()=>resolve());server.closeAllConnections()}
      catch{resolve()}
    });
    for(const socket of sockets)socket.destroy();
    try{await bounded('isolated HTTP listener close',closed,CLOSE_MS)}
    catch{problems.push('fixture listener close unconfirmed')}
    t.diagnostic('Hosted fixture teardown DONE'+(problems.length?': '+problems.join('; '):''));
    if(!failure&&problems.length){
      throw new Error('HOSTED_UI_FIXTURE_TEARDOWN_INCOMPLETE '+problems.join('; '));
    }
  }
});
