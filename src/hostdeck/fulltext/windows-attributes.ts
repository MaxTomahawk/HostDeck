import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const execFile=promisify(execFileCb);

/**
 * Windows Node fs.Dirent/Stats do not expose FILE_ATTRIBUTE_HIDDEN. Query
 * Windows' own attrib.exe (under SystemRoot, no shell), not filename heuristics.
 * A non-zero exit, timeout, unexpected output or unknown path FAILS CLOSED.
 * Only ASCII flag columns are parsed; no Unicode filename decoding is needed.
 *
 * This bounded compatibility route is deliberately simple rather than fast.
 * Broader indexing needs a qualified native GetFileAttributesW batch provider;
 * no GPU, packages, elevation or global configuration are required here.
 */
export async function windowsAttributes(file:string):Promise<{hidden:boolean;system:boolean}>{
  if(process.platform!=='win32')return {hidden:false,system:false};
  if(!path.win32.isAbsolute(file)||file.startsWith('\\\\')||file.startsWith('\\\\?\\'))
    throw new Error('FULLTEXT_ATTRIBUTES_UNQUALIFIED_PATH');
  const systemRoot=process.env.SystemRoot??process.env.WINDIR;
  if(!systemRoot||!path.win32.isAbsolute(systemRoot))
    throw new Error('FULLTEXT_ATTRIBUTES_UNAVAILABLE');
  const binary=path.win32.join(systemRoot,'System32','attrib.exe');
  let stdout:string,stderr:string;
  try{
    const answer=await execFile(binary,[file],{
      shell:false,windowsHide:true,timeout:2500,maxBuffer:8192,encoding:'utf8',
    });
    stdout=String(answer.stdout);stderr=String(answer.stderr);
  }catch{throw new Error('FULLTEXT_ATTRIBUTES_UNAVAILABLE');}
  if(stderr.trim())throw new Error('FULLTEXT_ATTRIBUTES_UNAVAILABLE');
  const lines=stdout.split(/\r?\n/u).filter(Boolean);
  if(lines.length!==1)throw new Error('FULLTEXT_ATTRIBUTES_UNAVAILABLE');
  const line=lines[0].trimEnd();
  // Windows attrib format: "A   H   S           C:\\...\\file.txt".
  // Verify the exact requested path at end; never inspect letters from names.
  if(!line.toLowerCase().endsWith(file.toLowerCase()))
    throw new Error('FULLTEXT_ATTRIBUTES_UNAVAILABLE');
  const flags=line.slice(0,line.length-file.length);
  if(!/^\s*[A-Z\s]*\s{2,}$/u.test(flags))
    throw new Error('FULLTEXT_ATTRIBUTES_UNAVAILABLE');
  return {hidden:flags.includes('H'),system:flags.includes('S')};
}

export async function excludedByFileAttributes(file:string,includeHidden:boolean):Promise<boolean>{
  // A file marked System is never silently included even when the owner
  // selected includeHidden; broad System traversal is separately unqualified.
  const flags=await windowsAttributes(file);
  return flags.system||(!includeHidden&&flags.hidden);
}
