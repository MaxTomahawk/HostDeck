import { build } from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// The backend tsconfig excludes ui/. Bundling alone erases types, so check the
// actual browser sources before emitting the production bundle.
execFileSync(process.execPath,[fileURLToPath(new URL('../node_modules/typescript/bin/tsc',import.meta.url)),
  '--project',fileURLToPath(new URL('../tsconfig.ui.json',import.meta.url))],{stdio:'inherit'});
await build({entryPoints:['ui/newtree/app.ts'],outfile:'ui/newtree/app.js',bundle:true,format:'esm',platform:'browser',minify:true,legalComments:'eof'});
const output=await readFile('ui/newtree/app.js','utf8');
await writeFile('ui/newtree/app.js',output.split('\n').map(line=>line.trimEnd()).join('\n'));
