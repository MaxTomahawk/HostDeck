import { build } from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
await build({entryPoints:['ui/newtree/app.ts'],outfile:'ui/newtree/app.js',bundle:true,format:'esm',platform:'browser',minify:true,legalComments:'eof'});
const output=await readFile('ui/newtree/app.js','utf8');
await writeFile('ui/newtree/app.js',output.split('\n').map(line=>line.trimEnd()).join('\n'));
