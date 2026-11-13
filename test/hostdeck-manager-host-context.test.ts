import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  parseManagerHostInput, parseManagerHostResult, applyManagerHostContext,
  createManagerHostContextApplier,
} from '../ui/newtree/manager-host-context.js';

test('valid SDK tool-input and authoritative result select the existing Extensions view only after connect', () => {
  const input = parseManagerHostInput({arguments:{device_id:'device_01'}});
  assert.deepEqual(input,{device_id:'device_01'});
  const result = parseManagerHostResult({
    isError: false,
    structuredContent: {result:{device_id:'device_01',view:'providers'}},
    content:[{type:'text',text:'host content is not authorization'}],
  },input);
  assert.deepEqual(result,{device_id:'device_01',view:'providers'});
  const selected: Array<[string,string]> = [];
  const apply = (device:string,view:'providers') => selected.push([device,view]);
  assert.equal(applyManagerHostContext(result,false,apply),false);
  assert.deepEqual(selected,[],'notifications before host connect do not mutate UI');
  assert.equal(applyManagerHostContext(result,true,apply),true);
  assert.deepEqual(selected,[['device_01','providers']]);
});

test('invalid input/result, wrong device/view and extra authority fields do not initialize manager', () => {
  const valid = parseManagerHostInput({arguments:{device_id:'device_01'}});
  const invalidInputs = [
    null, {}, {arguments:{}}, {arguments:{device_id:'../private'}},
    {arguments:{device_id:'evil<token>'}}, {arguments:{device_id:'a'.repeat(129)}},
    {arguments:{device_id:'device_01',scopes:['host:manage']}},
    {arguments:{device_id:12}},
  ];
  for(const input of invalidInputs) assert.equal(parseManagerHostInput(input),null);
  const badResults = [
    {}, {isError:true,structuredContent:{result:{device_id:'device_01',view:'providers'}}},
    {isError:'false',structuredContent:{result:{device_id:'device_01',view:'providers'}}},
    {structuredContent:{result:{device_id:'other',view:'providers'}}},
    {structuredContent:{result:{device_id:'device_01',view:'jobs'}}},
    {structuredContent:{result:{device_id:'device_01',view:'extensions'}}},
    {structuredContent:{result:{device_id:'device_01',view:'providers',grant:'allow'}}},
    {structuredContent:{result:{device_id:'device_01',view:'providers'},accessToken:'forged'}},
    {content:[{type:'text',text:'{"device_id":"device_01","view":"providers"}'}]},
  ];
  let selected=0;
  const apply=()=>{selected++};
  for(const result of badResults) {
    const parsed=parseManagerHostResult(result,valid);
    assert.equal(parsed,null,JSON.stringify(result));
    assert.equal(applyManagerHostContext(parsed,true,apply),false);
  }
  assert.equal(parseManagerHostResult({structuredContent:{result:{device_id:'device_01',view:'providers'}}},null),null,
    'result without matching input cannot establish a device');
  assert.equal(selected,0,'untrusted host notifications must never trigger UI selection');
});

test('tool input alone never grants UI device authority or calls HostDeck tools', () => {
  const input=parseManagerHostInput({arguments:{device_id:'allowed'}});
  assert.ok(input);
  assert.equal(parseManagerHostResult({structuredContent:{result:{device_id:'unowned',view:'providers'}}},input),null);
  let toolCalls=0;
  const changed=applyManagerHostContext(null,true,()=>{toolCalls++});
  assert.equal(changed,false);
  assert.equal(toolCalls,0);
});


test('100 identical official input/result pairs mount only once, preserving later user navigation', () => {
  const applyOnce = createManagerHostContextApplier();
  const input = {arguments:{device_id:'device_01'}};
  const result = {structuredContent:{result:{device_id:'device_01',view:'providers'}}};
  let currentView = 'overview';
  let mounted = 0;
  let providerLoads = 0;
  const apply = (deviceId:string, view:'providers') => {
    assert.equal(deviceId,'device_01');
    currentView = view;
    mounted++;
    providerLoads++;
  };
  for (let i = 0; i < 100; i++) {
    const parsed = parseManagerHostResult(result, parseManagerHostInput(input));
    assert.equal(applyOnce(parsed, true, apply), i === 0);
    if (i === 0) currentView = 'files'; // Deliberate navigation away.
  }
  assert.equal(currentView,'files','duplicate notifications cannot steal navigation');
  assert.equal(mounted,1,'one host-context application');
  assert.equal(providerLoads,1,'one provider load; UI test verifies actual request count');
  assert.equal(applyOnce(parseManagerHostResult(result, parseManagerHostInput(input)),
    false, apply),false,'disconnected presentation has no effect');
});

test('invalid payloads do not apply or poison a valid future context', () => {
  const applyOnce = createManagerHostContextApplier();
  let mounts=0;
  const update=()=>{mounts++};
  const input=parseManagerHostInput({arguments:{device_id:'device_01'}});
  assert.equal(applyOnce(parseManagerHostResult({structuredContent:{result:{
    device_id:'other',view:'providers'}},isError:false},input),true,update),false);
  assert.equal(applyOnce(parseManagerHostResult({isError:true,structuredContent:{
    result:{device_id:'device_01',view:'providers'}}},input),true,update),false);
  assert.equal(applyOnce(parseManagerHostResult({structuredContent:{
    result:{device_id:'device_01',view:'providers',scope:'host:manage'}}},input),true,update),false);
  assert.equal(mounts,0);
  const valid=parseManagerHostResult({
    structuredContent:{result:{device_id:'device_01',view:'providers'}}},input);
  assert.equal(applyOnce(valid,false,update),false,'not-ready must not cache context');
  assert.equal(applyOnce(valid,true,update),true);
  assert.equal(mounts,1);
  assert.equal(applyOnce(valid,true,update),false);
  assert.equal(mounts,1);
});

test('context ledger is finite and a failed application cannot poison it', () => {
  const applyOnce=createManagerHostContextApplier();
  let mounts=0;
  const same={device_id:'device_01',view:'providers' as const};
  assert.throws(()=>applyOnce(same,true,()=>{throw new Error('fixture render threw');}),/fixture render threw/);
  assert.equal(applyOnce(same,true,()=>{mounts++}),true);
  for(let i=0;i<100;i++) {
    assert.equal(applyOnce({device_id:'device_'+i,view:'providers'},true,()=>{mounts++}),true);
  }
  assert.equal(mounts,101);
  // The latest context remains in the bounded 32-entry ledger.
  assert.equal(applyOnce({device_id:'device_99',view:'providers'},true,()=>{mounts++}),false);
  assert.equal(mounts,101);
  // Entries evicted after >32 different contexts can intentionally apply again.
  assert.equal(applyOnce(same,true,()=>{mounts++}),true);
  assert.equal(mounts,102);
});
