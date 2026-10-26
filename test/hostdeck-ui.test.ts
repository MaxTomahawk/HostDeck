import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import puppeteer, { type Browser } from 'puppeteer-core';

const executable = process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE;

// Both the UI flow and cleanup are bounded independently. Node's test timeout
// is an outer safety net, not the mechanism used to release Edge/server handles.
const UI_FLOW_LIMIT_MS = 80_000;
const UI_STEP_LIMIT_MS = 9_000;
const UI_TEST_LIMIT_MS = 95_000;
const UI_CLOSE_LIMIT_MS = 4_000;

async function bounded<T>(label: string, task: Promise<T>, limitMs: number): Promise<T> {
  let alarm: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        alarm = setTimeout(() => reject(new Error('UI_FIXTURE_TIMEOUT ' + label +
          ' (' + limitMs + 'ms)')), limitMs);
      }),
    ]);
  } finally { if (alarm) clearTimeout(alarm); }
}

test('standalone panel keeps inputs during result updates and treats hostile tool output as text', {
  skip: !executable ? 'Set HOSTDECK_TEST_BROWSER_EXECUTABLE to run the local UI browser fixture.' : false,
  timeout: UI_TEST_LIMIT_MS,
}, async (t) => {
  const root = process.cwd(); let authorization = '';
  let savedProvider: string | null = 'everything'; let preferenceWrites = 0;
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
            : name === 'hostdeck_list_providers' ? {providers:[
                {id:'direct',installed:true,enabled:true,running:'on_demand',compatible:true,healthy:true,
                  capabilities:['files.name','files.content']},
                {id:'everything',installed:true,enabled:true,running:true,compatible:true,healthy:false,
                  reason:'loading <img src=x onerror=window.pwned=3>',qualified:'not_independently_accepted',
                  capabilities:['files.name'],version:'1.5.0-fixture'}
              ],functions:[{capability:'files.name',preference:savedProvider,default:'direct',selected:savedProvider??'direct'},
                {capability:'files.content',preference:null,default:'direct',selected:'direct'}]}
            : name === 'hostdeck_set_provider_preference' ? (() => {
                const args = message.params.arguments;
                if (args.capability !== 'files.name' || ![null,'direct','everything'].includes(args.provider)) {
                  return {updated:false,capability:args.capability,preference:savedProvider};
                }
                preferenceWrites++; savedProvider = args.provider;
                return {updated:true,capability:args.capability,preference:savedProvider,scope:'owner_device_function'};
              })()
            : name === 'hostdeck_read_file' ? { content: '<script>window.pwned=2</script>' }
              : name === 'hostdeck_list_directory' ? { entries: [{ path: 'safe.txt', type: 'file' }] } : {};
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value } };
      } else result = {};
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); return;
    }
    response.writeHead(404).end();
  });
  // Track ONLY this fixture server's sockets; ordinary applications and the
  // installed HostDeck agent are never touched, even during forced teardown.
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const flowStarted = Date.now();
  let sequence = 0;
  let firstFailedStep: string | undefined;
  async function step<T>(label: string, action: () => Promise<T>, maximumMs = UI_STEP_LIMIT_MS): Promise<T> {
    const current = ++sequence;
    t.diagnostic('UI step ' + current + ' START: ' + label);
    try {
      const remaining = UI_FLOW_LIMIT_MS - (Date.now() - flowStarted);
      if (remaining <= 0) throw new Error('UI_FIXTURE_FLOW_DEADLINE');
      const result = await bounded(label, Promise.resolve().then(action), Math.min(remaining, maximumMs));
      t.diagnostic('UI step ' + current + ' PASS: ' + label);
      return result;
    } catch (error) {
      firstFailedStep ??= label;
      t.diagnostic('UI step ' + current + ' FAIL: ' + label +
        ' (' + (error instanceof Error ? error.name : 'unknown error') + ')');
      throw error;
    }
  }

  let browser: Browser | undefined;
  let launchPending: Promise<Browser> | undefined;
  let flowFailure: unknown;
  try {
    await step('start isolated MCP fixture server', () => new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', fail); resolve(); };
      server.once('error', fail);
      server.once('listening', ready);
      server.listen(0, '127.0.0.1');
    }), 5_000);
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    browser = await step('launch test-owned Edge', () => {
      launchPending = puppeteer.launch({
        executablePath: path.resolve(executable!),
        headless: true, args: ['--no-sandbox'], timeout: 15_000,
      });
      return launchPending;
    }, 18_000);

    const page = await step('navigate same-origin management panel', async () => {
      const opened = await browser!.newPage();
      opened.setDefaultTimeout(6_000);
      opened.setDefaultNavigationTimeout(8_000);
      await opened.goto('http://127.0.0.1:' + address.port + '/ui/', {
        waitUntil: 'domcontentloaded', timeout: 8_000,
      });
      return opened;
    }, 12_000);

    await step('connect MCP with fixture token', async () => {
      await page.locator('#token').fill('short-lived-fixture-token');
      await page.locator('#connect').click();
      try {
        await page.waitForFunction(() => document.querySelector('#status')?.textContent
          ?.includes('Enter the authorized device ID'));
      } catch {
        const message = await page.$eval('#status', element => element.textContent ?? 'Connection failed')
          .catch(() => 'Connection failed: status unavailable');
        assert.fail(message);
      }
      assert.equal(authorization, 'Bearer short-lived-fixture-token');
      assert.equal(await page.$eval('#token', element => (element as HTMLInputElement).value), '');
    });

    await step('authorized device and overview', async () => {
      await page.locator('#device').fill('fixture-device');
      await page.locator('#refresh').click();
      await page.waitForFunction(() => document.querySelector('#recent-jobs')?.textContent?.includes('Recent jobs'));
      assert.equal(await page.$eval('#device', element => (element as HTMLInputElement).value), 'fixture-device');
    });

    await step('jobs page preserves escaped hostile tool text', async () => {
      await page.locator('nav button[data-view="jobs"]').click();
      await page.waitForFunction(() => document.querySelector('#content')?.textContent
        ?.includes('<img src=x onerror=window.pwned=1>'));
      assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
    });

    await step('extension catalog loads with honest candidate count', async () => {
      await page.locator('nav button[data-view="providers"]').click();
      await page.waitForFunction(() => document.querySelector('#provider-status')?.textContent
        ?.includes('Live status read'));
      assert.match(await page.$eval('#extension-count', element => element.textContent ?? ''),
        /80 entries.*79 research/);
    });

    await step('search and inspect Everything detail without script execution', async () => {
      await page.locator('#extension-search').fill('Everything');
      await page.waitForFunction(() => document.querySelector('#extension-count')?.textContent
        ?.startsWith('1 matching'));
      await page.locator('#extension-results button[aria-label="Details for Everything"]').click();
      const detail = await page.$eval('#extension-detail', element => element.textContent ?? '');
      assert.match(detail, /Owner delivery priority/);
      assert.match(detail, /Installed.*Yes/s);
      assert.match(detail, /Qualification.*Not independently accepted/s);
      assert.match(detail, /loading <img src=x onerror=window.pwned=3>/);
      assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
    });

    await step('unsupported lifecycle buttons are not available', async () => {
      // $$eval evaluates an array of matching elements; $eval only gets one.
      const lifecycleButtons = await page.$$eval('#content button', buttons => buttons.filter(
        button => /^(Install|Start|Stop|Update|Uninstall|Rollback)$/i.test(button.textContent ?? ''),
      ).length);
      assert.equal(lifecycleButtons, 0, 'unsupported lifecycle actions are not clickable');
    });

    await step('clear extension filters and restore all candidates', async () => {
      await page.locator('#content .manager-filters button.manager-secondary').click();
      await page.waitForFunction(() => document.querySelector('#extension-count')?.textContent
        ?.startsWith('80 matching'));
    });

    await step('function preference reflects saved Everything choice', async () => {
      await page.locator('.manager-tabs button:nth-of-type(2)').click();
      assert.equal(await page.$eval('#provider-preference', element => (element as HTMLSelectElement).value),
        'everything');
    });

    await step('concurrent preflight conflict prevents any preference write', async () => {
      // Simulates another authorized client updating the server-side preference.
      savedProvider = 'direct';
      await page.select('#provider-preference', 'direct');
      await page.locator('#provider-apply').click();
      await page.waitForFunction(() => document.querySelector('#preference-feedback')?.textContent
        ?.includes('changed externally'));
      assert.equal(preferenceWrites, 0, 'preflight conflict prevents a write');
      assert.equal(await page.$eval('#provider-preference', element => (element as HTMLSelectElement).value),
        'direct');
    });

    await step('one scoped preference write is confirmed by readback', async () => {
      await page.select('#provider-preference', 'everything');
      await page.locator('#provider-apply').click();
      await page.waitForFunction(() => document.querySelector('#preference-feedback')?.textContent
        ?.includes('Preference verified on readback'));
      assert.equal(preferenceWrites, 1, 'exactly one scoped preference write');
      assert.equal(savedProvider, 'everything');
    });

    await step('session changes panel reports confirmed receipt', async () => {
      await page.locator('.manager-tabs button:nth-of-type(3)').click();
      assert.match(await page.$eval(
        '.manager-section[aria-label="Change evidence in this page session"]',
        element => element.textContent ?? '',
      ), /Readback confirmed/);
    });

    await step('existing files view keeps input and escapes content', async () => {
      await page.locator('nav button[data-view="files"]').click();
      await page.locator('#file-path').fill('notes.txt');
      await page.evaluate(() => [...document.querySelectorAll('button')]
        .find(button => button.textContent === 'Read text file')?.click());
      await page.waitForFunction(() => (document.querySelector('#file-editor') as HTMLTextAreaElement | null)
        ?.value.includes('<script>'));
      assert.equal(await page.$eval('#file-path', element => (element as HTMLInputElement).value), 'notes.txt');
      assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
    });
  } catch (error) {
    flowFailure = error;
    throw error;
  } finally {
    t.diagnostic('UI fixture teardown START' +
      (firstFailedStep ? '; first failed step: ' + firstFailedStep : ''));
    const teardownProblems: string[] = [];

    if (!browser && launchPending) {
      // If a timed-out launch resolves late, close that *test-owned* instance.
      void launchPending.then(async lateBrowser => {
        try { await bounded('late Edge close', lateBrowser.close(), UI_CLOSE_LIMIT_MS); }
        catch { lateBrowser.process()?.kill('SIGKILL'); }
      }).catch(() => {});
    }
    if (browser) {
      try {
        await bounded('Edge close', browser.close(), UI_CLOSE_LIMIT_MS);
      } catch {
        // Restrict forced termination to the child created by this test.
        browser.process()?.kill('SIGKILL');
        teardownProblems.push('test-owned Edge required forced termination');
      }
    }

    // Close the listener and forcibly release ONLY its accepted sockets.
    // server.closeAllConnections does not close upgraded sockets; the tracked
    // sockets handle those as well. This runs after a failed launch or step.
    const closeServer = new Promise<void>(resolve => {
      try {
        server.close(() => resolve());
        server.closeAllConnections();
      } catch { resolve(); }
    });
    for (const socket of sockets) socket.destroy();
    try {
      await bounded('fixture server close', closeServer, UI_CLOSE_LIMIT_MS);
    } catch {
      teardownProblems.push('fixture listener did not acknowledge closure');
    }
    t.diagnostic('UI fixture teardown DONE' +
      (teardownProblems.length ? ': ' + teardownProblems.join('; ') : ''));
    // Keep the first functional failure visible rather than masking it with
    // cleanup errors; a cleanup defect after a green flow is itself a failure.
    if (!flowFailure && teardownProblems.length) {
      throw new Error('UI_FIXTURE_TEARDOWN_INCOMPLETE ' + teardownProblems.join('; '));
    }
  }
});
