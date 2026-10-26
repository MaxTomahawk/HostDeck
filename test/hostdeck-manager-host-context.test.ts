import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  parseManagerHostInput, parseManagerHostResult, applyManagerHostContext,
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
