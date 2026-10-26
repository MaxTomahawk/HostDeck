import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';

const executable = process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE;

test('standalone panel keeps inputs during result updates and treats hostile tool output as text', { skip: !executable ? 'Set HOSTDECK_TEST_BROWSER_EXECUTABLE to run the local UI browser fixture.' : false }, async () => {
  const root = process.cwd(); let authorization = '';
  const server = createServer(async (request, response) => {
    if (request.url === '/ui' || request.url === '/ui/') { response.writeHead(302, { location: '/ui/index.html' }).end(); return; }
    if (request.url?.startsWith('/ui/')) {
      const file = path.join(root, 'ui', 'newtree', path.basename(request.url));
      try { const data = await readFile(file); response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(data); }
      catch { response.writeHead(404).end(); }
      return;
    }
    if (request.url === '/mcp' && request.method === 'POST') {
      authorization = String(request.headers.authorization ?? '');
      let body = ''; for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (!('id' in message)) { response.writeHead(202).end(); return; }
      let result: any;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      else if (message.method === 'tools/call') {
        const name = message.params.name;
        const value = name === 'hostdeck_device_status' ? { sessions: [{ session_id: 12, eligible: true }], executor_id: 'fixture-executor' }
          : name === 'hostdeck_list_jobs' ? { jobs: [{ job_id: 'job1', state: 'running', command: '<img src=x onerror=window.pwned=1>' }] }
            : name === 'hostdeck_list_providers' ? {providers:[{id:'direct',installed:true,enabled:true,running:'on_demand',compatible:true,healthy:true},{id:'everything',installed:true,enabled:true,running:true,compatible:true,healthy:false,reason:'loading',qualified:'not_independently_accepted'}],functions:[{capability:'files.name',preference:'everything',default:'direct',selected:'everything'},{capability:'files.content',preference:null,default:'direct',selected:'direct'}]}
            : name === 'hostdeck_read_file' ? { content: '<script>window.pwned=2</script>' }
              : name === 'hostdeck_list_directory' ? { entries: [{ path: 'safe.txt', type: 'file' }] } : {};
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value } };
      } else result = {};
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const browser = await puppeteer.launch({ executablePath: path.resolve(executable!), headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}/ui/`, { waitUntil: 'networkidle0' });
    await page.locator('#token').fill('short-lived-fixture-token'); await page.locator('#connect').click();
    try { await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Enter the authorized device ID'), {timeout:5000}); }
    catch { assert.fail(await page.$eval('#status', element => element.textContent ?? 'Connection failed')); }
    assert.equal(authorization, 'Bearer short-lived-fixture-token');
    assert.equal(await page.$eval('#token', (element: any) => element.value), '');
    await page.locator('#device').fill('fixture-device'); await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#recent-jobs')?.textContent?.includes('Recent jobs'));
    assert.equal(await page.$eval('#device', (element: any) => element.value), 'fixture-device');
    await page.locator('nav button[data-view="jobs"]').click();
    await page.waitForFunction(() => document.querySelector('#content')?.textContent?.includes('<img src=x onerror=window.pwned=1>'));
    assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
    await page.locator('nav button[data-view="providers"]').click();
    await page.waitForFunction(() => document.querySelector('#provider-status')?.textContent?.includes('loading'));
    assert.match(await page.$eval('#provider-status',element=>element.textContent??''),/not_independently_accepted/);
    assert.equal(await page.$eval('#provider-preference',(element:any)=>element.value),'everything');
    await page.locator('nav button[data-view="files"]').click();
    await page.locator('#file-path').fill('notes.txt'); await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Read text file')?.click());
    await page.waitForFunction(() => (document.querySelector('#file-editor') as HTMLTextAreaElement | null)?.value.includes('<script>'));
    assert.equal(await page.$eval('#file-path', (element: any) => element.value), 'notes.txt');
    assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
