/** F034: Mcode-native panel for explicitly sandboxed inline VS Code Webviews.
 * - iframe has opaque origin (NO allow-same-origin), no Electron/Node bridge.
 * - CSP denies subresource/network APIs, file schemes, nested frames and forms.
 * - Sandbox blocks parent/top navigation, not necessarily self-navigation;
 *   unsupported remote resources/navigation need real Electron U1 policy tests.
 * - Child may communicate only with its own verified Theia session via IPC.
 * Full vscode-resource, WebviewView, custom editors require separate work.
 */
import {useEffect,useRef,useState} from "react";
import {api} from "@renderer/lib/api.js";
import type {TheiaWebviewEvent} from "@contracts/ipc/modules.js";

interface Panel {
  sessionId:string;extensionId:string;handle:string;title:string;html:string;pending:unknown[];
}
const policy="default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; navigate-to 'none';"+
  " frame-src 'none'; object-src 'none'; img-src data: blob:; font-src data:;"+
  " style-src 'unsafe-inline'; script-src 'unsafe-inline'";
const shim=`<script>
(function(){
  var currentState;
  window.acquireVsCodeApi=function(){
    return Object.freeze({
      postMessage:function(message){
        parent.postMessage({__mcodeVsixWebview:true,payload:message},'*');
        return Promise.resolve(true);
      },
      getState:function(){return currentState;},
      setState:function(state){currentState=state;return state;}
    });
  };
  window.addEventListener('message',function(event){
    if(event.data&&event.data.__mcodeToWebview===true){
      window.dispatchEvent(new MessageEvent('message',{data:event.data.payload}));
    }
  });
})();
</script>`;
function documentFor(html:string):string{
  return '<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="'+policy+'">'+shim+html;
}
export function TheiaWebviewHost(){
  const [panels,setPanels]=useState<Panel[]>([]);
  const [active,setActive]=useState<string|null>(null);
  const frames=useRef(new Map<string,HTMLIFrameElement>());
  const ready=useRef(new Set<string>());
  useEffect(()=>api.on.theiaWebview(event=>{
    const key=event.sessionId+":"+event.handle;
    if(event.action==="html"||event.action==="dispose")ready.current.delete(key);
    setPanels(current=>{
      if(event.action==="dispose"){
        return current.filter(panel=>panel.sessionId+":"+panel.handle!==key);
      }
      const found=current.find(panel=>panel.sessionId+":"+panel.handle===key);
      if(event.action==="create"){
        if(current.length>=4&&!found)return current;
        if(!found)return [...current,{sessionId:event.sessionId,extensionId:event.extensionId,
          handle:event.handle,title:event.title??event.extensionId,html:"",pending:[]}];
      }
      if(!found)return current;
      return current.map(panel=>panel!==found?panel:{
        ...panel,
        ...(event.action==="html"?{html:event.html??"",pending:[]}:{}),
        ...(event.action==="title"?{title:event.title??panel.title}:{}),
        ...(event.action==="message"?{pending:[...panel.pending,event.payload].slice(-32)}:{}),
      });
    });
    if(event.action==="create")setActive(key);
    if(event.action==="dispose")setActive(previous=>previous===key?null:previous);
  }),[]);
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
      const panel=panels.find(item=>frames.current.get(item.sessionId+":"+item.handle)?.contentWindow===event.source);
      if(!panel||!event.data||event.data.__mcodeVsixWebview!==true)return;
      let encoded="";
      try{encoded=JSON.stringify(event.data.payload);}
      catch{return;}
      if(!encoded||encoded.length>64_000)return;
      void api.modules.theiaInstalled({op:"webviewMessage",sessionId:panel.sessionId,
        handle:panel.handle,payload:event.data.payload}).catch(()=>{});
    };
    window.addEventListener("message",listener);
    return ()=>window.removeEventListener("message",listener);
  },[panels]);
  const close=(panel:Panel)=>void api.modules.theiaInstalled({op:"webviewDispose",
    sessionId:panel.sessionId,handle:panel.handle}).catch(()=>{
    setPanels(old=>old.filter(item=>item!==panel));
  });
  const visible=panels.find(panel=>panel.sessionId+":"+panel.handle===active)??panels.at(-1);
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
      {panels.map(panel=><button type="button" key={panel.sessionId+":"+panel.handle}
        onClick={()=>setActive(panel.sessionId+":"+panel.handle)}
        className="max-w-32 truncate rounded px-2 py-1 text-code hover:bg-surface-muted"
        aria-pressed={panel===visible}>{panel.title}</button>)}
      <button type="button" onClick={()=>close(visible)} className="ml-auto rounded px-2 py-1 text-code hover:bg-surface-muted"
        aria-label="关闭扩展视图">关闭</button>
    </div>
    {panels.map(panel=><iframe key={panel.sessionId+":"+panel.handle}
      title={panel.title}
      ref={frame=>{const id=panel.sessionId+":"+panel.handle;
        if(frame)frames.current.set(id,frame);else frames.current.delete(id);}}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={panel===visible?"min-h-0 w-full flex-1 border-0":"hidden"}
      srcDoc={documentFor(panel.html)}
      onLoad={()=>onLoaded(panel)}/>)}
  </aside>;
}
