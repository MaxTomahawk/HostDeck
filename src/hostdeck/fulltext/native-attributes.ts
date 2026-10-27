/** Policy-only adapter to PR22's native Win32 batch metadata contract.
 * This does NOT implement native access, ACL verification, or a fallback.
 */
import path from 'node:path';
import type {FullTextNativeAttribute} from '../fulltext-native-bridge.js';
import {within} from './policy.js';
import type {FullTextAction,FullTextPrincipal} from './types.js';

export type FullTextAttributeProbe = (
  paths:readonly string[], principal:FullTextPrincipal, selectedRoot:string, action:FullTextAction,
)=>Promise<FullTextNativeAttribute[]>;

export function selectedComponents(root:string,candidate:string):string[]{
  const base=path.resolve(root),target=path.resolve(candidate);
  if(!within(base,target))throw new Error('FULLTEXT_OUTSIDE_ROOT');
  const parts=path.relative(base,target).split(path.sep).filter(Boolean);
  if(parts.length>60)throw new Error('FULLTEXT_NATIVE_BATCH_LIMIT');
  const paths=[base];
  let current=base;
  for(const part of parts){current=path.join(current,part);paths.push(current);}
  return paths;
}

/** A selected fixed-volume root may itself have Windows Hidden+System flags.
 * Its descendants must NOT inherit those leaf exclusions. On every path,
 * reparse_component is still an unconditional denial.
 */
export function eligibleNativeLeaf(
  metadata:FullTextNativeAttribute,
  includeHidden:boolean,
  selectedFixedVolumeRoot=false,
):boolean{
  if(metadata.status==='reparse_component'||metadata.reparse===true)
    throw new Error('FULLTEXT_REPARSE_DENIED');
  if(metadata.status!=='ok'||metadata.hidden===null||metadata.system===null||
      metadata.reparse!==false||metadata.directory===null)
    throw new Error('FULLTEXT_NATIVE_METADATA_UNAVAILABLE');
  if(selectedFixedVolumeRoot)return true;
  // Deliberately ignore hidden_component/system_component here: PR22 reports
  // C: drive-root flags in these fields even for normal descendant files.
  // Instead check the leaf of EACH in-scope ancestor with selectedComponents().
  return !metadata.system&&(includeHidden||!metadata.hidden);
}

export function qualifiedBatch(
  paths:readonly string[],result:readonly FullTextNativeAttribute[],
  root:string,includeHidden:boolean,fixedVolumeRoots:readonly string[],
):boolean[]{
  if(paths.length!==result.length||paths.length<1||paths.length>64)
    throw new Error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
  return paths.map((candidate,index)=>{
    const item=result[index];
    if(!item||item.index!==index||!within(root,candidate))
      throw new Error('FULLTEXT_NATIVE_PROTOCOL_INVALID');
    const fixedVolumeRoot=path.resolve(candidate)===path.resolve(root)&&
      fixedVolumeRoots.some(fixed=>path.resolve(fixed)===path.resolve(root))&&
      path.parse(root).root.toLowerCase()===path.resolve(root).toLowerCase();
    return eligibleNativeLeaf(item,includeHidden,fixedVolumeRoot);
  });
}
