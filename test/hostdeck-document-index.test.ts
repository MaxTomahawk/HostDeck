import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import puppeteer from 'puppeteer';
import {readIndexPreview, readIndexStatus} from '../ui/newtree/document-index.js';

const digest='a'.repeat(64);
const preview={digest,activated:false,roots:['C:\\Owned documents'],formats:['.txt','.pdf'],
  excludedRoots:[],budgets:{maxDocuments:100,maxIndexBytes:1048576},
  issues:['NO_AUTOMATIC_WATCHER_OR_SEMANTIC_MODEL','SOURCE_ACL_AND_FRESHNESS_RECHECK_REQUIRED']};

test('index UI distinguishes inactive, partial and complete backend states without inventing progress',()=>{
  assert.deepEqual(readIndexStatus({state:'unconfigured',configured:false}),{state:'unconfigured',run:null});
  assert.equal(readIndexStatus({state:'selected_not_active'}).run,null);
  assert.equal(readIndexStatus({state:'unstarted',run:null,visibleDocuments:0,coverage:'partial_or_unverified'}).state,'unstarted');
  for(const state of ['running','paused','interrupted','resource_paused','cancelled','complete']) {
    const value=readIndexStatus({state,run:{runId:'owned-run',state,processed:4},
      visibleDocuments:2,coverage:'partial_or_unverified'});
    assert.equal(value.coverage,'partial_or_unverified');assert.equal(value.run?.processed,4);
  }
  for(const value of [null,{state:'ready'},{state:'complete',run:null,visibleDocuments:2,coverage:'complete_bounded_scan'},
    {state:'running',run:{runId:'owned',state:'complete',processed:4},visibleDocuments:2,coverage:'partial_or_unverified'},
    {state:'running',run:{runId:'owned',state:'running',processed:-1},visibleDocuments:2,coverage:'partial_or_unverified'}])
    assert.throws(()=>readIndexStatus(value),/INDEX_RESPONSE_INVALID/);
});

test('only a bounded backend preview with an exact inactive digest can enable opening',()=>{
  assert.equal(readIndexPreview({configured:false,reason:'ROOTS_NOT_SELECTED'}),null);
  assert.deepEqual(readIndexPreview(preview),{digest,roots:preview.roots,formats:preview.formats,
    excludedRoots:[],budgets:preview.budgets,issues:preview.issues});
  for(const value of [{...preview,digest:'caller approval'},{...preview,activated:true},
    {...preview,budgets:{maxDocuments:Infinity}},{...preview,roots:[{}]},
    {configured:false,reason:'arbitrary'}, {...preview,issues:['x'.repeat(2049)]}])
    assert.throws(()=>readIndexPreview(value),/INDEX_RESPONSE_INVALID/);
});

const executable=process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE;
test('real browser: explicit index lifecycle, safe snippets, uncertain effects and device changes',
  {skip:!executable,timeout:90_000},async()=>{
    const fixture=await build({stdin:{contents:`
      import {mountDocumentIndex} from './ui/newtree/document-index.ts';
      const f=window.fixture={device:'owned-device',calls:[],state:'selected_not_active',failStart:false,
        deferOpen:false,release:null};
      function status(){return f.state==='selected_not_active'?{state:f.state}:
        {state:f.state,visibleDocuments:1,coverage:'partial_or_unverified',
         run:f.state==='unstarted'?null:{runId:'owned-run',state:f.state,processed:1}};}
      mountDocumentIndex(document.querySelector('main'),{
        deviceId:()=>f.device,isCurrent:()=>true,call:async(name,args={})=>{
          f.calls.push({name,args});
          if(name==='hostdeck_fulltext_preview')return ${JSON.stringify(preview)};
          if(name==='hostdeck_fulltext_status')return status();
          if(name==='hostdeck_fulltext_confirm'){
            if(f.deferOpen)await new Promise(resolve=>{f.release=resolve});
            f.state='unstarted';return {ready:true};
          }
          if(name==='hostdeck_fulltext_start'){
            f.state='running';if(f.failStart)throw new Error('transport lost after effect');return {runId:'owned-run'};
          }
          if(name==='hostdeck_fulltext_pause')f.state='paused';
          else if(name==='hostdeck_fulltext_resume')f.state='running';
          else if(name==='hostdeck_fulltext_cancel')f.state='cancelled';
          else if(name==='hostdeck_fulltext_query')return {results:[{path:'C:\\\\Owned documents\\\\<img>.txt',
            snippet:'<img src=x onerror=alert(1)>',documentCoverage:'partial'}],
            truncated:true,coverage:'partial_or_unverified'};
          else throw new Error('unexpected operation');
          return {state:f.state,run_id:'owned-run'};
        }});
    `,resolveDir:process.cwd(),sourcefile:'document-index-fixture.ts',loader:'ts'},
      bundle:true,write:false,platform:'browser',format:'esm'});
    const javascript=fixture.outputFiles[0].text;
    const server=createServer((req,res)=>{
      if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(javascript);}
      else if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Owned index fixture</title><main></main><script type="module" src="/fixture.js"></script>');}
      else{res.writeHead(404);res.end();}
    });
    let browser:Awaited<ReturnType<typeof puppeteer.launch>>|undefined;
    try {
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
      const address=server.address();assert.ok(address&&typeof address==='object');
      browser=await puppeteer.launch({executablePath:executable,headless:true,timeout:15_000});
      const page=await browser.newPage();page.setDefaultTimeout(5000);
      const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
      const url='http://127.0.0.1:'+address.port;
      const load=async()=>{await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForSelector('form');};
      const click=async(label:string)=>{
        assert.equal(await page.evaluate(label=>{
          const button=[...document.querySelectorAll('button')].find(item=>item.textContent===label);
          if(!button||button.disabled)return false;button.click();return true;
        },label),true,'enabled button: '+label);
        await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')!=='true');
      };
      const calls=()=>page.evaluate(()=>(window as any).fixture.calls as Array<{name:string;args:any}>);
      await load();assert.deepEqual(await calls(),[],'mount makes no request');
      await click('Read index status');await click('Preview locations and limits');
      assert.deepEqual((await calls()).map(c=>c.name),['hostdeck_fulltext_status','hostdeck_fulltext_preview']);
      await click('Open approved index');
      assert.deepEqual((await calls()).find(c=>c.name==='hostdeck_fulltext_confirm')?.args,{digest});
      assert.equal((await calls()).some(c=>c.name==='hostdeck_fulltext_start'),false,'opening never starts');
      await click('Start new scan');await click('Pause scan');await click('Resume scan');
      await page.type('input[type=search]','owned text');await click('Search documents');
      assert.equal(await page.$('article img'),null,'snippet markup is inert text');
      assert.match(await page.$eval('article',e=>e.textContent??''),/<img src=x onerror=alert\(1\)>/);
      await click('Cancel scan');
      for(const name of ['hostdeck_fulltext_start','hostdeck_fulltext_pause','hostdeck_fulltext_resume','hostdeck_fulltext_cancel'])
        assert.equal((await calls()).filter(c=>c.name===name).length,1,name+' dispatched once');
      for(const c of (await calls()).filter(c=>/_(pause|resume|cancel)$/.test(c.name)))
        assert.deepEqual(c.args,{run_id:'owned-run'});

      await load();await click('Read index status');await click('Preview locations and limits');await click('Open approved index');
      await page.evaluate(()=>{(window as any).fixture.failStart=true});
      await click('Start new scan');
      const failed=await calls();assert.equal(failed.at(-1)?.name,'hostdeck_fulltext_start','no implicit retry or read after uncertainty');
      assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Start new scan')!.disabled),true);
      await click('Read index status');await click('Pause scan');
      assert.equal((await calls()).filter(c=>c.name==='hostdeck_fulltext_start').length,1,'reconcile existing run, never replay start');

      await load();await click('Read index status');await click('Preview locations and limits');
      await page.evaluate(()=>{const f=(window as any).fixture;f.deferOpen=true;
        [...document.querySelectorAll('button')].find(b=>b.textContent==='Open approved index')!.click();});
      await page.waitForFunction(()=>typeof (window as any).fixture.release==='function');
      await page.evaluate(()=>{const f=(window as any).fixture;f.device='other-device';f.release()});
      await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')==='false');
      assert.equal((await calls()).at(-1)?.name,'hostdeck_fulltext_confirm','no follow-up read for changed device');
      assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].every(b=>b.disabled)),true);
      assert.equal(await page.$eval('dl',e=>e.textContent),'');
      assert.deepEqual(errors,[]);
      await page.setViewport({width:390,height:844});
    }finally{
      await browser?.close();server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });
