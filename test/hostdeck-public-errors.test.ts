import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publicError} from '../src/hostdeck/gateway.js';
test('expected stale/conflict errors are distinct while arbitrary backend details stay private',()=>{
 for(const code of ['STALE_WINDOW','STALE_ELEMENT','EDIT_CONFLICT','WINDOW_NOT_FOREGROUND'])assert.equal(publicError(new Error(code)),code);
 assert.equal(publicError(new Error('file failed: PRIVATE_FIXTURE_CONTENT')),'IO_ERROR');
});
