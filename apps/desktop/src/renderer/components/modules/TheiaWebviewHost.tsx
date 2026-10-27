/** F034: Mcode-native panel for explicitly sandboxed inline VS Code Webviews.
 * - iframe has opaque origin (NO allow-same-origin), no Electron/Node bridge.
 * - CSP denies arbitrary network APIs, file schemes, nested frames and forms.
 * - Local resources use a per-host scheme and are authorized against main-owned
 *   localResourceRoots; the iframe still has an opaque origin and no Node bridge.
 * - Main-owned title/HTML/state/active snapshots restore panels after remounts.
 * - WebviewView and CustomDocument editors share the native drawer lifecycle;
 *   CustomTextEditor and save-as remain explicitly unsupported.
 */
import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {api} from "@renderer/lib/api.js";
import {useToastStore} from "@renderer/stores/toastStore.js";
import type {TheiaWebviewEvent} from "@contracts/ipc/theia.js";

interface Panel {
  sessionId:string;extensionId:string;handle:string;title:string;html:string;state?:unknown;bootstrapState?:unknown;
  enableScripts:boolean;resourceOrigin:string;surface?:"panel"|"view"|"custom-editor";viewType?:string;
  description?:string;badge?:{value:number;tooltip?:string};filePath?:string;editable?:boolean;dirty?:boolean;
  undoCount?:number;redoCount?:number;pending:unknown[];
}
const policy="default-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none';"+
  " frame-src 'none'; object-src 'none';";
const shim=`<script>
(function(){
  var currentState=window.__mcodeVsixInitialState;
  var apiAcquired=false;
  window.acquireVsCodeApi=function(){
    if(apiAcquired)throw new Error("acquireVsCodeApi may only be called once");
    apiAcquired=true;
    return Object.freeze({
      postMessage:function(message){
        parent.postMessage({__mcodeVsixWebview:true,payload:message},'*');
        return Promise.resolve(true);
      },
      getState:function(){return currentState;},
      setState:function(state){
        if(state===undefined){
          currentState=undefined;
        }else{
          var encoded;
          try{encoded=JSON.stringify(state);}catch(_error){throw new Error("Webview state must be JSON serializable");}
          if(typeof encoded!=="string"||encoded.length>64000)throw new Error("Webview state exceeds 64 KB");
          currentState=JSON.parse(encoded);
        }
        parent.postMessage({__mcodeVsixWebviewState:true,state:currentState},'*');
        return currentState;
      }
    });
  };
  window.addEventListener('message',function(event){
    if(event.data&&event.data.__mcodeToWebview===true){
      window.dispatchEvent(new MessageEvent('message',{data:event.data.payload}));
    }
  });
})();
</script>`;
function documentFor(html:string,state:unknown,enableScripts:boolean,resourceOrigin:string):string{
  let encoded="undefined";
  if(state!==undefined){
    try{encoded=JSON.stringify(state)??"null";}catch{encoded="null";}
    // The bootstrap is an inline script under the Webview CSP. Escape HTML
    // delimiters so stored JSON can never terminate that script element.
    encoded=encoded.replace(/</g,"\\u003c").replace(/>/g,"\\u003e")
      .replace(/&/g,"\\u0026").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
  }
  const bootstrap="<script>window.__mcodeVsixInitialState="+encoded+";</script>";
  const scriptPolicy=enableScripts?"script-src 'unsafe-inline' "+resourceOrigin:"script-src 'none'";
  const resourcePolicy=" img-src data: blob: "+resourceOrigin+"; font-src data: "+resourceOrigin+";"+
    " style-src 'unsafe-inline' "+resourceOrigin+"; connect-src "+resourceOrigin+";"+
    " media-src data: blob: "+resourceOrigin+"; worker-src blob: "+resourceOrigin+";";
  return '<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="'+policy+resourcePolicy+scriptPolicy+'">'+bootstrap+shim+html;
}
export function TheiaWebviewHost(){
  const [panels,setPanels]=useState<Panel[]>([]);
  const [active,setActive]=useState<string|null>(null);
  const panelsRef=useRef<Panel[]>([]);
  const frames=useRef(new Map<string,HTMLIFrameElement>());
  const ready=useRef(new Set<string>());
  useLayoutEffect(()=>{panelsRef.current=panels;},[panels]);
  useEffect(()=>{
    let alive=true,revision=0;
    const applyEvent=(event:TheiaWebviewEvent,fromSnapshot=false)=>{
      if(!fromSnapshot)revision++;
      const key=event.sessionId+":"+event.handle;
      if(event.action==="html"||event.action==="options"||event.action==="dispose")ready.current.delete(key);
      setPanels(current=>{
        if(event.action==="dispose")return current.filter(panel=>panel.sessionId+":"+panel.handle!==key);
        const found=current.find(panel=>panel.sessionId+":"+panel.handle===key);
        if(event.action==="create"){
          if(current.length>=4&&!found)return current;
          if(!found)return [...current,{sessionId:event.sessionId,extensionId:event.extensionId,
            handle:event.handle,title:event.title??event.extensionId,html:"",enableScripts:event.enableScripts===true,
            resourceOrigin:event.resourceOrigin??"mcode-webview-resource://unavailable",
            ...(event.surface?{surface:event.surface}:{}),...(event.viewType?{viewType:event.viewType}:{}),
            ...(event.description?{description:event.description}:{}),...(event.badge?{badge:event.badge}:{}),
            ...(event.filePath?{filePath:event.filePath}:{}),...(event.editable!==undefined?{editable:event.editable}:{}),
            ...(event.dirty!==undefined?{dirty:event.dirty}:{}),...(event.undoCount!==undefined?{undoCount:event.undoCount}:{}),
            ...(event.redoCount!==undefined?{redoCount:event.redoCount}:{}),
            ...(event.state!==undefined?{state:event.state,bootstrapState:event.state}:{}),pending:[]}];
        }
        if(!found)return current;
        return current.map(panel=>panel!==found?panel:{
          ...panel,
          ...(event.action==="html"?{html:event.html??"",bootstrapState:panel.state}:{}),
          ...(event.action==="options"?{enableScripts:event.enableScripts===true,
            resourceOrigin:event.resourceOrigin??panel.resourceOrigin}:{}),
          ...(event.action==="title"?{title:event.title??panel.title}:{}),
          ...(event.action==="description"?{description:event.description??undefined}:{}),
          ...(event.action==="badge"?{badge:event.badge??undefined}:{}),
          ...(event.action==="dirty"?{dirty:event.dirty===true,undoCount:event.undoCount??0,redoCount:event.redoCount??0}:{}),
          ...(event.action==="message"?{pending:[...panel.pending,event.payload].slice(-32)}:{}),
        });
      });
      if(event.action==="create"&&event.active)setActive(key);
      if(event.action==="reveal")setActive(key);
      if(event.action==="dispose")setActive(previous=>previous===key?null:previous);
    };
    const unsubscribe=api.on.theiaWebview(event=>applyEvent(event));
    const restore=async(attempt=0)=>{
      const expectedRevision=revision;
      try{
        const result=await api.modules.theiaInstalled({op:"webviewList"});
        if(!alive||result.kind!=="webviews")return;
        if(expectedRevision!==revision){if(attempt<2)void restore(attempt+1);return;}
        for(const event of result.items)applyEvent(event,true);
      }catch{/* The web renderer and older runtimes may not provide native VSIX Webviews. */}
    };
    void restore();
    return ()=>{alive=false;unsubscribe();};
  },[]);
  // Extension messages can arrive long AFTER the iframe load event. Flush on
  // every pending-queue change, never solely in onLoad; this also protects
  // messages delivered before the iframe is mounted and becoming ready.
  useEffect(()=>{
    for(const panel of panels){
      const key=panel.sessionId+":"+panel.handle;
      if(!ready.current.has(key)||!panel.pending.length)continue;
      const frame=frames.current.get(key);
      if(!frame?.contentWindow)continue;
      const count=panel.pending.length;
      for(const payload of panel.pending){
        frame.contentWindow.postMessage({__mcodeToWebview:true,payload},"*");
      }
      setPanels(current=>current.map(item=>
        item.sessionId+":"+item.handle===key?{...item,pending:item.pending.slice(count)}:item));
    }
  },[panels]);
  useEffect(()=>{
    const listener=(event:MessageEvent)=>{
      const panel=panelsRef.current.find(item=>frames.current.get(item.sessionId+":"+item.handle)?.contentWindow===event.source);
      if(!panel||!event.data||typeof event.data!=="object")return;
      if(event.data.__mcodeVsixWebviewState===true){
        let encoded:string|undefined;
        try{encoded=JSON.stringify(event.data.state);}catch{return;}
        if(encoded!==undefined&&encoded.length>64_000)return;
        // Update the live React snapshot synchronously with the bridge event so
        // a concurrent HTML refresh cannot reload the iframe with stale state.
        const key=panel.sessionId+":"+panel.handle;
        setPanels(current=>current.map(item=>item.sessionId+":"+item.handle===key?{...item,state:event.data.state}:item));
        void api.modules.theiaInstalled({op:"webviewStateSet",sessionId:panel.sessionId,
          handle:panel.handle,state:event.data.state}).catch(()=>{});
        return;
      }
      if(event.data.__mcodeVsixWebview!==true)return;
      let encoded:string|undefined;
      try{encoded=JSON.stringify(event.data.payload);}catch{return;}
      if(!encoded||encoded.length>64_000)return;
      void api.modules.theiaInstalled({op:"webviewMessage",sessionId:panel.sessionId,
        handle:panel.handle,payload:event.data.payload}).catch(()=>{});
    };
    window.addEventListener("message",listener);
    return ()=>window.removeEventListener("message",listener);
  },[]);
  const close=(panel:Panel)=>{
    const key=panel.sessionId+":"+panel.handle;
    void api.modules.theiaInstalled({op:"webviewDispose",
      sessionId:panel.sessionId,handle:panel.handle}).catch(()=>{
      ready.current.delete(key);
      setPanels(old=>old.filter(item=>item.sessionId+":"+item.handle!==key));
      setActive(previous=>previous===key?null:previous);
    });
  };
  const visible=panels.find(panel=>panel.sessionId+":"+panel.handle===active)??panels.at(-1);
  const [customActionBusy,setCustomActionBusy]=useState<string|null>(null);
  const customAction=(action:"save"|"revert"|"undo"|"redo")=>async()=>{
    if(!visible||customActionBusy)return;
    setCustomActionBusy(action);
    try{
      const result=await api.modules.theiaInstalled({op:"customEditorAction",sessionId:visible.sessionId,handle:visible.handle,action});
      if(result.kind!=="webviewAcknowledged")throw Error("自定义编辑器操作未完成");
    }catch(error){
      useToastStore.getState().push({kind:"error",title:"扩展自定义编辑器",
        body:error instanceof Error?error.message:String(error)});
    }finally{setCustomActionBusy(null);}
  };
  if(!visible)return null;
  const onLoaded=(panel:Panel)=>{
    const id=panel.sessionId+":"+panel.handle;
    if(!frames.current.has(id))return;
    ready.current.add(id);
    // Trigger the pending-queue flush for events that arrived before load.
    setPanels(current=>[...current]);
  };
  return <aside className="fixed bottom-8 right-3 top-14 z-[60] flex w-[min(650px,78vw)] flex-col rounded border border-edge bg-surface shadow-[var(--shadow-popover)]"
    data-testid="theia-native-webview" aria-label="Mcode 扩展 Webview">
    <div className="flex min-h-10 items-center gap-1 border-b border-edge px-2">
      <span className="mr-2 text-code font-semibold">扩展视图</span>
      {visible.surface==="custom-editor"&&<>
        <span className="text-[11px] text-content-muted">{visible.dirty?"未保存":"已保存"}</span>
        {visible.editable&&<>
          <button type="button" disabled={customActionBusy!==null} onClick={customAction("save")}
            className="rounded border border-edge px-2 py-1 text-code hover:bg-surface-muted">保存</button>
          <button type="button" disabled={customActionBusy!==null} onClick={customAction("revert")}
            className="rounded border border-edge px-2 py-1 text-code hover:bg-surface-muted">还原</button>
          <button type="button" disabled={customActionBusy!==null||(visible.undoCount??0)===0} onClick={customAction("undo")}
            className="rounded border border-edge px-2 py-1 text-code hover:bg-surface-muted">撤销</button>
          <button type="button" disabled={customActionBusy!==null||(visible.redoCount??0)===0} onClick={customAction("redo")}
            className="rounded border border-edge px-2 py-1 text-code hover:bg-surface-muted">重做</button>
        </>}
      </>}
      {panels.map(panel=><button type="button" key={panel.sessionId+":"+panel.handle}
        onClick={()=>{
          setActive(panel.sessionId+":"+panel.handle);
          void api.modules.theiaInstalled({op:"webviewReveal",sessionId:panel.sessionId,handle:panel.handle}).catch(()=>{});
        }}
        className="max-w-40 truncate rounded px-2 py-1 text-code hover:bg-surface-muted"
        title={panel.description??panel.title}
        aria-pressed={panel===visible}>{panel.title}{panel.badge&&<span className="ml-1 rounded bg-surface-muted px-1 text-[10px]">{panel.badge.value}</span>}</button>)}
      <button type="button" onClick={()=>close(visible)} className="ml-auto rounded px-2 py-1 text-code hover:bg-surface-muted"
        aria-label="关闭扩展视图">关闭</button>
    </div>
    {panels.map(panel=><iframe key={panel.sessionId+":"+panel.handle}
      title={panel.title}
      ref={frame=>{const id=panel.sessionId+":"+panel.handle;
        if(frame)frames.current.set(id,frame);else frames.current.delete(id);}}
      sandbox={panel.enableScripts?"allow-scripts":""}
      referrerPolicy="no-referrer"
      className={panel===visible?"min-h-0 w-full flex-1 border-0":"hidden"}
      srcDoc={documentFor(panel.html,panel.bootstrapState,panel.enableScripts,panel.resourceOrigin)}
      onLoad={()=>onLoaded(panel)}/>)}
  </aside>;
}
