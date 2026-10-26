import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretJobReceipt } from '../src/hostdeck/state/job-receipt.js';

test('native success/failure/timeout/cancel require explicit owned descendant containment', () => {
  assert.deepEqual(interpretJobReceipt({status:'completed',exitCode:0,descendantsContained:true}),
    {status:'succeeded',exitCode:0,descendantsContained:true});
  assert.deepEqual(interpretJobReceipt({status:'completed',exitCode:7,descendantsContained:true}),
    {status:'failed',exitCode:7,descendantsContained:true});
  for(const status of ['cancelled','timed_out','interrupted'] as const){
    const result=interpretJobReceipt({status,exitCode:null,descendantsContained:true});
    assert.equal(result.status,status);
    assert.equal(result.descendantsContained,true);
    assert.equal(result.message,undefined);
  }
  const rejected=interpretJobReceipt({status:'failed',exitCode:null,descendantsContained:false});
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
    {status:'completed',exitCode:null,descendantsContained:true},
    {status:'completed',descendantsContained:true},
    {status:'nonsense',exitCode:0,descendantsContained:true},
    {status:'uncertain',exitCode:null,descendantsContained:false},
    {status:'failed',exitCode:0,descendantsContained:false},
    null, {exitCode:'0',timedOut:false},
  ]){
    const v=interpretJobReceipt(receipt);
    assert.equal(v.status,'uncertain',JSON.stringify(receipt));
    assert.ok(v.message?.includes('uncertain'),JSON.stringify(receipt));
  }
});

test('legacy receipts preserve exit semantics WITHOUT native tree-containment claims', () => {
  const success=interpretJobReceipt({exitCode:0,timedOut:false,stdout:'',stderr:''});
  assert.equal(success.status,'succeeded');
  assert.equal(success.exitCode,0);
  assert.equal(success.descendantsContained,undefined);
  assert.match(success.message??'',/no verified descendant/);
  const failure=interpretJobReceipt({exitCode:5});
  assert.equal(failure.status,'failed');
  assert.equal(failure.exitCode,5);
  assert.equal(failure.descendantsContained,undefined);
  const timed=interpretJobReceipt({exitCode:0,timedOut:true});
  assert.equal(timed.status,'timed_out');
  assert.equal(timed.descendantsContained,undefined);
});

test('untrusted receipt strings never appear in finite error messages', () => {
  const injection={status:'cancelled',exitCode:null,descendantsContained:false,
    message:'PRIVATE_COMMAND_WITH_PASSWORD_ABC',stdout:'PRIVATE_STDOUT'};
  const result=interpretJobReceipt(injection);
  assert.equal(result.status,'uncertain');
  assert.doesNotMatch(result.message??'',/PRIVATE_COMMAND|PRIVATE_STDOUT/);
});
