import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {EverythingClient} from '../src/hostdeck/everything.js';

test('actual client cancellation waits for close and reports unconfirmed termination',async()=>{
 for(const closeConfirmed of [true,false]){
  const child=new EventEmitter() as any;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  let killed=false;child.kill=()=>{killed=true;return closeConfirmed;};
  const patch=mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
  try{
   const client=new EverythingClient({worker:'fixture',executable:'fixture',sha256:'0'.repeat(64),version:'fixture',instance:'',identity:{session_id:1} as any});
   const abort=new AbortController();let settled=false;
   const result=client.query('fixture',1000,abort.signal);result.finally(()=>{settled=true;}).catch(()=>{});
   abort.abort();await new Promise(r=>setImmediate(r));assert.equal(killed,true);assert.equal(settled,false,'kill signal alone is not exit confirmation');
   if(closeConfirmed){child.emit('close',1);await assert.rejects(result,/EVERYTHING_CANCELLED/);}
   else await assert.rejects(result,/EVERYTHING_TERMINATION_UNCERTAIN/);
  }finally{patch.mock.restore();syncBuiltinESMExports();child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();}
 }
});
