/**
 * Isolated host side of the real MCP Apps SDK iframe test.
 * Bundled only by the test; never embedded in the production manager.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';

type FixtureState = {
  ready:boolean;
  managerMounts:number;
  providerRequests:number;
  unexpectedRequests:string[];
  sendInitial:()=>Promise<void>;
  sendRepeated:(count:number)=>Promise<void>;
  sendInvalid:()=>Promise<void>;
  monitor:()=>void;
  snapshot:()=>Record<string,unknown>;
  close:()=>Promise<void>;
  observer?:MutationObserver;
};
declare global {interface Window{__hostdeckFixture:FixtureState;}}
const frame=document.querySelector<HTMLIFrameElement>('#hosted-app')!;
const providerPayload={
  providers:[
    {id:'direct',installed:true,enabled:true,running:'on_demand',
      compatible:true,healthy:true,capabilities:['files.name','files.content']},
    {id:'everything',installed:true,enabled:true,running:true,
      compatible:true,healthy:false,qualified:'not_independently_accepted',
      capabilities:['files.name'],version:'1.5.0-fixture'},
  ],
  functions:[
    {capability:'files.name',preference:'everything',default:'direct',selected:'everything'},
    {capability:'files.content',preference:null,default:'direct',selected:'direct'},
  ],
};
const bridge=new AppBridge(null,
  {name:'HostDeck isolated fixture',version:'1.0.0'},
  {serverTools:{},logging:{}});
const input={arguments:{device_id:'fixture-device'}};
const result={
  isError:false,
  structuredContent:{result:{device_id:'fixture-device',view:'providers'}},
  content:[{type:'text',text:'HostDeck manager context'}],
};
const state:FixtureState={
  ready:false,managerMounts:0,providerRequests:0,unexpectedRequests:[],
  sendInitial:async()=>{
    await bridge.sendToolInput(input);
    await bridge.sendToolResult(result);
    // MCP ping is an ordering barrier: all prior PostMessage notifications
    // from this bridge are processed before the fixture samples DOM/requests.
    await bridge.request({method:'ping'},EmptyResultSchema,{timeout:3_000});
  },
  sendRepeated:async count=>{
    for(let i=0;i<count;i++){
      await bridge.sendToolInput(input);
      await bridge.sendToolResult(result);
    }
    await bridge.request({method:'ping'},EmptyResultSchema,{timeout:3_000});
  },
  sendInvalid:async()=>{
    await bridge.sendToolInput({arguments:{device_id:'../invalid'}});
    await bridge.sendToolResult(result);
    await bridge.sendToolInput(input);
    await bridge.sendToolResult({
      isError:false,structuredContent:{result:{device_id:'other',view:'providers'}},
    });
    await bridge.sendToolInput(input);
    await bridge.sendToolResult({
      isError:false,structuredContent:{result:{device_id:'fixture-device',
        view:'providers',scopes:['host:manage']}},
    });
    await bridge.sendToolInput(input);
    await bridge.sendToolResult({
      isError:true,structuredContent:{result:{device_id:'fixture-device',view:'providers'}},
    });
    await bridge.request({method:'ping'},EmptyResultSchema,{timeout:3_000});
  },
  monitor:()=>{
    const root=frame.contentDocument!.querySelector<HTMLElement>('#content')!;
    const observer=new MutationObserver(records=>{
      for(const record of records){
        if(record.target!==root)continue;
        for(const node of record.addedNodes){
          // Iframe elements belong to another JavaScript realm, so the host's
          // HTMLElement constructor cannot recognize them with instanceof.
          if(node.nodeType===1&&(node as Element).classList.contains('manager'))state.managerMounts++;
        }
      }
    });
    observer.observe(root,{childList:true});
    state.observer=observer;
  },
  snapshot:()=>{
    const doc=frame.contentDocument!;
    return {
      managerMounts:state.managerMounts,
      providerRequests:state.providerRequests,
      unexpectedRequests:[...state.unexpectedRequests],
      totalDomNodes:doc.querySelectorAll('*').length,
      device:(doc.querySelector('#device') as HTMLInputElement|null)?.value,
      visibleStatus:doc.querySelector('#status')?.textContent??null,
      fileInput:(doc.querySelector('#file-path') as HTMLInputElement|null)?.value??null,
      managerCount:doc.querySelectorAll('#content .manager').length,
      heapBytes:(performance as Performance & {memory?:{usedJSHeapSize:number}})
        .memory?.usedJSHeapSize??null,
    };
  },
  close:async()=>{state.observer?.disconnect();await bridge.close();},
};
window.__hostdeckFixture=state;
bridge.oncalltool=async({name})=>{
  if(name==='hostdeck_list_providers'){
    state.providerRequests++;
    return {
      content:[{type:'text' as const,text:JSON.stringify(providerPayload)}],
      structuredContent:{result:providerPayload},
    };
  }
  state.unexpectedRequests.push(name);
  return {isError:true,content:[{type:'text' as const,text:'DENIED'}]};
};
bridge.oninitialized=()=>{state.ready=true;};
await bridge.connect(new PostMessageTransport(frame.contentWindow!,frame.contentWindow!));
frame.src='/ui/index.html';
