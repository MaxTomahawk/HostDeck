import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readDeviceReadiness} from '../ui/newtree/extension-device-readiness.js';

const id = 'authorized-device';

test('uses the existing read-only device_status operation and accepts only matching ready evidence', async () => {
  const calls: string[] = [];
  const readiness = await readDeviceReadiness(async name => {
    calls.push(name);
    return {device_id:id, status:'ready', jobs:3, storage:'local'};
  }, id);
  assert.equal(readiness, 'ready');
  assert.deepEqual(calls, ['hostdeck_device_status']);
});

test('never treats device readiness as provider installation or qualification', async () => {
  assert.equal(await readDeviceReadiness(async () => ({device_id:id,status:'offline'}), id), 'unknown');
  assert.equal(await readDeviceReadiness(async () => ({device_id:id,status:'ready',providers:[{installed:true}]}), id), 'ready');
});

test('fail-closed readback on mismatched devices, malformed responses and denied reads', async () => {
  for(const value of [null, 'ready', {status:'ready'}, {device_id:'other-device',status:'ready'},
    {device_id:id,status:true}, {device_id:id,status:'READY'}, {device_id:id,status:'unknown'}]) {
    assert.equal(await readDeviceReadiness(async () => value, id), 'unknown');
  }
  assert.equal(await readDeviceReadiness(async () => {throw new Error('DENIED')}, id), 'unknown');
});

test('invalid device id never dispatches even a read', async () => {
  let calls=0;
  assert.equal(await readDeviceReadiness(async () => {calls++;return {device_id:'invalid',status:'ready'}}, '../outside'), 'unknown');
  assert.equal(calls, 0);
});
