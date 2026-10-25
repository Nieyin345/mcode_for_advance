/** F032: VS Code contributed status items use Mcode's app chrome, not Theia UI. */
import {useEffect,useState} from "react";
import {api} from "@renderer/lib/api.js";
import {executeTheiaWithMonaco} from "@renderer/lib/theiaMonacoOwner.js";
import {useToastStore} from "@renderer/stores/toastStore.js";
import type {TheiaStatusEntry} from "@contracts/ipc/modules.js";

export function TheiaStatusStrip(){
  const [entries,setEntries]=useState<TheiaStatusEntry[]>([]);
  useEffect(()=>api.on.theiaStatusEntry(event=>{
    setEntries(previous=>{
      if(event.id==="*"&&event.removed)return previous.filter(e=>e.sessionId!==event.sessionId);
      const prior=previous.filter(e=>!(e.sessionId===event.sessionId&&e.id===event.id));
      if(event.removed)return prior;
      return [...prior,event].sort((a,b)=>(a.alignment??1)-(b.alignment??1)||
        (b.priority??0)-(a.priority??0)).slice(0,40);
    });
  }),[]);
  if(!entries.length)return null;
  const run=async(entry:TheiaStatusEntry)=>{
    if(!entry.command)return;
    try{
      const result=await executeTheiaWithMonaco(
        input=>api.modules.theiaInstalled(input),entry.sessionId,entry.command);
      if(result.kind!=="executed")throw Error("扩展状态栏命令未完成");
    }catch(error){useToastStore.getState().push({
      kind:"error",title:entry.extensionId,body:error instanceof Error?error.message:String(error),
    });}
  };
  return <div className="pointer-events-none fixed bottom-0 left-0 z-20 flex max-w-[72vw] gap-1 rounded-tr border border-edge bg-surface/95 px-2 py-0.5"
      data-testid="mcode-extension-status" role="status">
    {entries.map(item=><button type="button" key={item.sessionId+":"+item.id}
      disabled={!item.command} title={item.tooltip??item.name??item.extensionId}
      className="pointer-events-auto max-w-48 truncate rounded px-1.5 text-[11px] text-content-muted enabled:hover:bg-surface-muted enabled:hover:text-content"
      onClick={()=>void run(item)}>{item.text??item.name??item.extensionId}</button>)}
  </div>;
}
