/** Synthetic metadata ONLY for isolated engine/ranking/ACL lifecycle tests.
 * NOT a Windows Hidden/System or effective-ACL qualification. Those require
 * test/hostdeck-fulltext-native.test.ts and the opt-in real bridge fixtures.
 */
import type {FullTextAttributeProbe} from '../../src/hostdeck/fulltext/native-attributes.js';

export const syntheticFullTextAttributes:FullTextAttributeProbe=async paths=>
  paths.map((_,index)=>({
    index,status:'ok',hidden:false,system:false,reparse:false,
    hidden_component:false,system_component:false,directory:false,
  }));
