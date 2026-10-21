import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BrowserAdapter } from '../src/hostdeck/browser.js';
import {publicError} from '../src/hostdeck/gateway.js';

const executable = process.env.HOSTDECK_TEST_BROWSER_EXECUTABLE;

test('managed browser uses an owned headless profile, scoped context and current snapshot references', { skip: !executable ? 'Set HOSTDECK_TEST_BROWSER_EXECUTABLE to an installed Chrome or Edge executable.' : false }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hostdeck-browser-test-'));
  const fixture = createServer((_request, response) => response.end('<!doctype html><button id="ok">Local fixture</button>'));
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  const adapter = await BrowserAdapter.create({
    executable: path.resolve(executable!), profileRoot: path.join(temp, 'profiles'),
    networkPolicy: url => url.hostname === '127.0.0.1' && url.port === String(address.port),
  });
  const context = { ownerId: 'owner-a', deviceId: 'device-a', executorId: 'executor-a', sessionIds: [12] };
  try {
    const missing=await BrowserAdapter.create({executable:path.join(temp,'missing-browser.exe'),profileRoot:path.join(temp,'missing-profiles')});
    await assert.rejects(missing.handle('hostdeck_browser_open',{session_id:12},context),error=>{
      assert.equal(publicError(error),'BROWSER_START_FAILED');return true;
    });
    await missing.dispose();
    await assert.rejects(adapter.handle('hostdeck_browser_open',{session_id:12,url:'http://127.0.0.1:1/'},context),error=>{
      assert.equal(publicError(error),'BROWSER_PRIVATE_EGRESS_DENIED');return true;
    });
    const opened = await adapter.handle('hostdeck_browser_open', { session_id: 12, url: `http://127.0.0.1:${address.port}/` }, context) as { browser_id: string; generation: number };
    assert.equal(opened.generation, 1);
    const snap = await adapter.handle('hostdeck_browser_snapshot', { browser_id: opened.browser_id }, context) as { elements: Array<{ element_ref: string; label: string }> };
    const button = snap.elements.find(item => item.label.includes('Local fixture'));
    assert.ok(button);
    await assert.rejects(adapter.handle('hostdeck_browser_snapshot', { browser_id: opened.browser_id }, { ...context, ownerId: 'owner-b' }), /BROWSER_SESSION_NOT_OWNED/);
    await assert.rejects(adapter.handle('hostdeck_browser_snapshot', { browser_id: opened.browser_id }, { ...context, sessionIds: [] }), /BROWSER_SESSION_NOT_OWNED/);
    await adapter.handle('hostdeck_browser_interact', { browser_id: opened.browser_id, element_ref: button.element_ref, action: { kind: 'click' } }, context);
    await assert.rejects(adapter.handle('hostdeck_browser_interact', { browser_id: opened.browser_id, element_ref: button.element_ref, action: { kind: 'click' } }, context), /BROWSER_STALE_ELEMENT/);
    await assert.rejects(adapter.handle('hostdeck_browser_navigate', { browser_id: opened.browser_id, url: 'file:///etc/passwd' }, context), /BROWSER_PROTOCOL_DENIED/);
    await adapter.handle('hostdeck_browser_close', { browser_id: opened.browser_id }, context);
  } finally {
    await adapter.dispose();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});
