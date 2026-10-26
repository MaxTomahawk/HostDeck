/** Disposable two-process HostDeck fulltext writer test helper. Not production. */
import {readFile} from 'node:fs/promises';
import {FullTextEngine} from '../../src/hostdeck/fulltext/engine.js';
import type {FullTextConfig,FullTextPrincipal,FullTextAuthorizer} from '../../src/hostdeck/fulltext/types.js';

const principal:FullTextPrincipal={ownerId:'writer-fixture',deviceId:'writer-test-device',executorId:'writer-test-executor'};
const authorize:FullTextAuthorizer=async request=>request.principal.ownerId===principal.ownerId
  && request.principal.deviceId===principal.deviceId && request.principal.executorId===principal.executorId;

async function main():Promise<void> {
  const configFile=process.argv[2],mode=process.argv[3];
  if (!configFile || !['hold','probe'].includes(mode)) throw new Error('TEST_ARGUMENTS_MISSING');
  const config=JSON.parse(await readFile(configFile,'utf8')) as FullTextConfig;
  const preview=await FullTextEngine.preview(config,principal,authorize);
  let engine:FullTextEngine|undefined;
  try {
    engine=await FullTextEngine.openConfirmed(config,principal,authorize,preview.digest);
    let state=(await engine.status(principal)).state;
    if (mode==='hold') {
      if (state==='unstarted') {
        await engine.start(principal);
        state=(await engine.status(principal)).state;
      }
      if(state!=='running')throw new Error('TEST_EXPECTED_RUNNING');
      process.stdout.write('HELD '+state+'\n');
      await new Promise<void>(resolve=>process.stdin.once('data',()=>resolve()));
      // Releasing SQLite is not sufficient for process exit while stdin is
      // still in flowing mode and the parent keeps its pipe open.
      process.stdin.pause();
      process.stdin.destroy();
      engine.close();
      engine=undefined;
      // This is a deliberately short-lived test helper. Exit explicitly
      // after the observable receipt has been flushed to the parent pipe.
      process.stdout.write('CLOSED\n',()=>process.exit(0));
    } else {
      process.stdout.write('OPENED '+state+'\n');
    }
  } catch(error) {
    if (error instanceof Error && error.message==='FULLTEXT_WRITER_BUSY') {
      process.stdout.write('BUSY FULLTEXT_WRITER_BUSY\n');
      return;
    }
    throw error;
  } finally {engine?.close();}
}
main().catch(error=>{
  process.stderr.write('WRITER_FIXTURE_FAILED:'+(error instanceof Error?error.message:'UNKNOWN')+'\n');
  process.exitCode=4;
});
