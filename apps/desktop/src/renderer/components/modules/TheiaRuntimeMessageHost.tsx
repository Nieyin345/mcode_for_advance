/** F031: VS Code extension messages are Mcode-native UI, not a Theia window.
 * Mounted once at App root; plain notices reuse the existing ToastStore.
 * Actionable notices/modal decisions return the exact action index to the host.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@renderer/hooks/useFocusTrap.js";
import { api } from "@renderer/lib/api.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import type { TheiaRuntimeMessage } from "@contracts/ipc/theia.js";

export function TheiaRuntimeMessageHost() {
  const [pending,setPending]=useState<TheiaRuntimeMessage[]>([]);
  const rootRef=useRef<HTMLDivElement>(null);
  const hasModal=pending.some(msg=>msg.modal);
  useFocusTrap(rootRef,hasModal);
  const reply=useCallback((notice:TheiaRuntimeMessage,choice:number|null)=>{
    setPending(current=>current.filter(item=>item.requestId!==notice.requestId));
    void api.modules.theiaInstalled({
      op:"messageRespond",requestId:notice.requestId,sessionId:notice.sessionId,choice
    }).catch(()=>{ /* A stopped extension/window cannot accept a stale choice. */ });
  },[]);
  useEffect(()=>{
    return api.on.theiaRuntimeMessage(msg=>{
      if(!msg.modal && msg.actions.length===0){
        useToastStore.getState().push({
          kind:msg.kind,title:msg.extensionId,body:msg.message+(msg.detail?" — "+msg.detail:""),
          dedupeKey:msg.requestId,
        });
        return;
      }
      setPending(current=>current.some(x=>x.requestId===msg.requestId)?
        current:current.length>=16?current:[...current,msg]);
    });
  },[]);
  // A prompt that outlives the host timeout must not remain on screen indefinitely.
  useEffect(()=>{
    if(pending.length===0)return;
    const timers=pending.map(msg=>setTimeout(()=>reply(msg,null),30000));
    return ()=>timers.forEach(clearTimeout);
  },[pending,reply]);
  if(pending.length===0)return null;
  return (
    <div ref={rootRef} className={hasModal?
      "pointer-events-auto fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-2 bg-black/35 p-5":
      "pointer-events-none fixed inset-0 z-[10000] flex flex-col items-center justify-end gap-2 p-5"}
      data-testid="theia-native-messages">
      {pending.map(msg=>(
        <div key={msg.requestId}
          className={msg.modal?
            "pointer-events-auto w-full max-w-md rounded border border-edge bg-surface p-4 shadow-[var(--shadow-popover)]":
            "pointer-events-auto w-full max-w-md rounded border border-edge bg-surface p-3 shadow-[var(--shadow-popover)]"}
          role="dialog" aria-modal={msg.modal} aria-label={msg.extensionId}
          onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();reply(msg,null);}}}>
          <p className="text-body font-semibold">{msg.extensionId}</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-code">{msg.message}</p>
          {msg.detail&&<p className="mt-1 whitespace-pre-wrap break-words text-code text-content-muted">{msg.detail}</p>}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {msg.actions.map((label,index)=>(
              <button type="button" key={index} autoFocus={index===0}
                className="rounded border border-edge px-3 py-1.5 text-code hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-strong"
                onClick={()=>reply(msg,index)}>{label}</button>
            ))}
            <button type="button" className="rounded border border-edge px-3 py-1.5 text-code hover:bg-surface-muted"
              onClick={()=>reply(msg,null)}>关闭</button>
          </div>
        </div>
      ))}
    </div>
  );
}
