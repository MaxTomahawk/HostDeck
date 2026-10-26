import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretJobReceipt } from '../src/hostdeck/state/job-receipt.js';

const native=(receipt:unknown)=>interpretJobReceipt(receipt,'native-job-object-v1');
const legacy=(receipt:unknown)=>interpretJobReceipt(receipt,'legacy-powershell-v1');

test('native success/failure/timeout/cancel require explicit owned descendant containment', () => {
  assert.deepEqual(native({status:'completed',exitCode:0,descendantsContained:true}),
    {status:'succeeded',exitCode:0,descendantsContained:true});
  assert.deepEqual(native({status:'completed',exitCode:7,descendantsContained:true}),
    {status:'failed',exitCode:7,descendantsContained:true});
  for(const status of ['cancelled','timed_out','interrupted'] as const){
    const result=native({status,exitCode:null,descendantsContained:true});
    assert.equal(result.status,status);
    assert.equal(result.descendantsContained,true);
    assert.equal(result.message,undefined);
  }
  const rejected=native({status:'failed',exitCode:null,descendantsContained:false});
  assert.equal(rejected.status,'failed');
  assert.equal(rejected.exitCode,null);
  assert.equal(rejected.descendantsContained,false);
  assert.match(rejected.message??'',/no confirmed command completion/);
});

test('accepted cancellation and false/absent containment are not terminal confirmations', () => {
  for(const receipt of [
    {status:'cancelled',exitCode:null,descendantsContained:false},
    {status:'timed_out',exitCode:null,descendantsContained:false},
    {status:'interrupted',exitCode:0,descendantsContained:false},
    {status:'completed',exitCode:0,descendantsContained:false},
    {status:'completed',exitCode:0},
    {status:'cancelled',descendantsContained:true},
    {status:'cancelled',exitCode:'0',descendantsContained:true},
    {status:'completed',exitCode:null,descendantsContained:true},
    {status:'completed',descendantsContained:true},
    {status:'nonsense',exitCode:0,descendantsContained:true},
    {status:'uncertain',exitCode:null,descendantsContained:false},
    {status:'failed',exitCode:0,descendantsContained:false},
    null, {exitCode:'0',timedOut:false},
  ]){
    const v=native(receipt);
    assert.equal(v.status,'uncertain',JSON.stringify(receipt));
    assert.ok(v.message?.includes('uncertain'),JSON.stringify(receipt));
  }
});

test('legacy receipts preserve exit semantics WITHOUT native tree-containment claims', () => {
  const success=legacy({exitCode:0,timedOut:false,stdout:'',stderr:''});
  assert.equal(success.status,'succeeded');
  assert.equal(success.exitCode,0);
  assert.equal(success.descendantsContained,undefined);
  assert.match(success.message??'',/no verified descendant/);
  const failure=legacy({exitCode:5});
  assert.equal(failure.status,'failed');
  assert.equal(failure.exitCode,5);
  assert.equal(failure.descendantsContained,undefined);
  const timed=legacy({exitCode:0,timedOut:true});
  assert.equal(timed.status,'timed_out');
  assert.equal(timed.descendantsContained,undefined);
});

test('untrusted receipt strings never appear in finite error messages', () => {
  const injection={status:'cancelled',exitCode:null,descendantsContained:false,
    message:'PRIVATE_COMMAND_WITH_PASSWORD_ABC',stdout:'PRIVATE_STDOUT'};
  const result=native(injection);
  assert.equal(result.status,'uncertain');
  assert.doesNotMatch(result.message??'',/PRIVATE_COMMAND|PRIVATE_STDOUT/);
});

test('expected protocol blocks malformed-native to legacy downgrade and ambiguous historic receipts', () => {
  const corruptNative={exitCode:0,stdout:'',stderr:''};
  const nativeVerdict=native(corruptNative);
  assert.equal(nativeVerdict.status,'uncertain');
  assert.notEqual(nativeVerdict.descendantsContained,true);
  assert.match(nativeVerdict.message??'',/Native runner receipt is missing/);
  const historical=interpretJobReceipt(corruptNative,undefined);
  assert.equal(historical.status,'uncertain');
  assert.match(historical.message??'',/Persisted runner protocol is unavailable/);
  assert.equal(legacy(corruptNative).status,'succeeded',
    'same shape is only meaningful for a job already known to be legacy');
  const nativeLookingLegacy=legacy({status:'completed',exitCode:0,descendantsContained:true});
  assert.equal(nativeLookingLegacy.status,'uncertain','wrong-protocol receipt cannot silently upgrade');
});
