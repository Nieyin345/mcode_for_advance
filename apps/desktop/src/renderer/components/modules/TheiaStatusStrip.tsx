/** F032: VS Code contributed status items use Mcode's app chrome, not Theia UI. */
import {useEffect,useState} from "react";
import {api} from "@renderer/lib/api.js";
import {executeTheiaWithMonaco} from "@renderer/lib/theiaMonacoOwner.js";
import {useToastStore} from "@renderer/stores/toastStore.js";
import type {TheiaStatusEntry} from "@contracts/ipc/theia.js";

export function TheiaStatusStrip(){
  const [entries,setEntries]=useState<TheiaStatusEntry[]>([]);
  useEffect(()=>{
    let alive=true,revision=0;
    const unsubscribe=api.on.theiaStatusEntry(event=>{
      revision++;
      setEntries(previous=>{
        if(event.id==="*"&&event.removed)return previous.filter(e=>e.sessionId!==event.sessionId);
        const prior=previous.filter(e=>!(e.sessionId===event.sessionId&&e.id===event.id));
        if(event.removed)return prior;
        return [...prior,event].sort((a,b)=>(a.alignment??1)-(b.alignment??1)||
          (b.priority??0)-(a.priority??0)).slice(0,40);
      });
    });
    const restore=async(attempt=0)=>{
      const snapshotRevision=revision;
      try{
        const result=await api.modules.theiaInstalled({op:"list"});
        if(!alive||result.kind!=="list")return;
        if(revision!==snapshotRevision){if(attempt<2)void restore(attempt+1);return;}
        setEntries(result.items.flatMap(item=>item.activeSession?.statusEntries??[])
          .sort((a,b)=>(a.alignment??1)-(b.alignment??1)||(b.priority??0)-(a.priority??0)).slice(0,40));
      }catch{/* Extension runtime is optional in browser and unsupported desktop builds. */}
    };
    void restore();
    return ()=>{alive=false;unsubscribe();};
  },[]);
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
  const leftEntries=entries.filter(entry=>(entry.alignment??1)!==2);
  const rightEntries=entries.filter(entry=>entry.alignment===2);
  const renderEntry=(item:TheiaStatusEntry)=><button type="button" key={item.sessionId+":"+item.id}
    disabled={!item.command} title={item.tooltip??item.name??item.extensionId}
    className="pointer-events-auto max-w-48 truncate rounded px-1.5 text-[11px] text-content-muted enabled:hover:bg-surface-muted enabled:hover:text-content"
    onClick={()=>void run(item)}>{item.text??item.name??item.extensionId}</button>;
  return <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex items-end justify-between gap-2 px-2"
      data-testid="mcode-extension-status">
    {!!leftEntries.length&&<div className="pointer-events-auto flex max-w-[46vw] items-center gap-1 rounded-tr border border-edge bg-surface/95 px-2 py-0.5"
      role="group" aria-label="左侧扩展状态栏">{leftEntries.map(renderEntry)}</div>}
    {!!rightEntries.length&&<div className="pointer-events-auto flex max-w-[46vw] items-center gap-1 rounded-tl border border-edge bg-surface/95 px-2 py-0.5"
      role="group" aria-label="右侧扩展状态栏">{rightEntries.map(renderEntry)}</div>}
  </div>;
}
