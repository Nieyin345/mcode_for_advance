import { useEffect, useRef, useState } from "react";
import { INIT_NAME_RE, type ProjectInitResult } from "@contracts/ipc/projectInit";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import type { BuiltInCommand } from "@renderer/lib/slashCommands.js";
// Do not import the settings editor into every conversation.
const CHANGED = "mcode:project-initializers-changed";
interface Request {sessionId:string;command:string;original?:string;}
export interface InitComposerSnapshot {text:string;attached:boolean;}
/** Reserved commands are consumed even when invalid/unavailable. They must never
 * reach a provider, a skill, the queue, or running-turn injection. */
export function parseProjectInitCommand(text:string): {command:string;valid:boolean}|null {
 const value=text.trim();if(!/^\/init-/i.test(value))return null;
 const command=value.slice(1);return {command,valid:command.startsWith("init-")&&INIT_NAME_RE.test(command.slice(5))};
}
export function useProjectInitializer(input:{sessionId:string;busy:boolean;menuOpen?:boolean;snapshot:()=>InitComposerSnapshot;clear:()=>void}) {
 const {t}=useI18n();const latest=useRef(input);latest.current=input;const desktop=!!window.api;
 const [version,setVersion]=useState(0);const [request,setRequest]=useState<Request|null>(null);
 const [result,setResult]=useState<ProjectInitResult|null>(null);const [error,setError]=useState<string|null>(null);
 const [applying,setApplying]=useState(false);const lock=useRef(false);
 const templates=useRpc(()=>api.projectInit.list(),[version],{enabled:desktop,toastOnError:false});
 useEffect(()=>{const change=()=>setVersion(n=>n+1);window.addEventListener(CHANGED,change);return()=>window.removeEventListener(CHANGED,change);},[]);
 useEffect(()=>{if(desktop&&input.menuOpen)void templates.refetch();},[desktop,input.menuOpen,templates.refetch]);
 useEffect(()=>{if(templates.error)useToastStore.getState().push({kind:"error",title:t("init.title"),body:templates.error.message});},[templates.error,t]);
 const plan=useRpc(async()=>({request,preview:await api.projectInit.preview({sessionId:request!.sessionId,command:request!.command})}),[request],{enabled:desktop&&request!==null,toastOnError:false});
 const preview=plan.data?.request===request&&!plan.loading&&!plan.error?plan.data.preview:null;
 const notice=(body:string)=>useToastStore.getState().push({kind:"error",title:t("init.title"),body});
 const start=(command:string,original?:string)=>{
  if(!desktop){notice(t("init.desktopOnly"));return false;}
  if(latest.current.busy||lock.current){notice(t("init.busy"));return false;}
  const snapshot=latest.current.snapshot();
  if(snapshot.attached){notice(t("init.noArguments"));return false;}
  setError(null);setResult(null);setRequest({sessionId:latest.current.sessionId,command,original});return true;
 };
 const intercept=(text:string,attached=false)=>{
  const parsed=parseProjectInitCommand(text);if(!parsed)return false;
  if(!parsed.valid||attached){notice(t("init.noArguments"));return true;}
  start(parsed.command,text);return true;
 };
 const apply=async()=>{
  if(!request||!preview||lock.current)return;
  if(latest.current.sessionId!==request.sessionId||latest.current.busy){setError(t("init.contextChanged"));return;}
  lock.current=true;setApplying(true);setError(null);
  try {
   const done=await api.projectInit.apply({sessionId:request.sessionId,command:request.command,digest:preview.digest});setResult(done);
   const current=latest.current.snapshot();
   if(done.actions.every(a=>a.status!=="failed")&&request.original!==undefined&&latest.current.sessionId===request.sessionId&&current.text.trim()===request.original.trim()&&!current.attached)latest.current.clear();
  }catch(e){setError(String(e));}finally{lock.current=false;setApplying(false);}
 };
 const commands:BuiltInCommand[]=(templates.data?.templates??[]).map(item=>({name:`init-${item.name}`,description:item.description||t("init.commandHint"),kind:"project-init"}));
 const blocked=preview?.actions.some(a=>a.status==="blocked");const changed=request!==null&&request.sessionId!==input.sessionId;
 const rows=result?.actions??preview?.actions??[];
 const dialog=<Dialog.Root open={request!==null} onOpenChange={open=>{if(!open&&!lock.current){setRequest(null);setError(null);setResult(null);}}}>
  <Dialog.Portal><Dialog.Backdrop/><Dialog.Popup className="flex max-h-[85vh] w-[min(680px,94vw)] flex-col gap-3 overflow-y-auto p-5" data-testid="init-preview">
   <Dialog.Title>{t("init.title")} · /{request?.command}</Dialog.Title>
   <Dialog.Description>{t("init.confirmHint")}</Dialog.Description>
   {plan.loading&&<p role="status">{t("common.loading")}</p>}
   {(error||plan.error||changed)&&<ErrorNote>{changed?t("init.contextChanged"):error??plan.error?.message}</ErrorNote>}
   {preview&&<div className="rounded border border-edge p-2 text-sm"><strong>{preview.projectName}</strong><p className="break-all font-mono text-xs">{preview.root}</p><p className="text-xs text-content-subtle">{t("init.memoryScope",{id:preview.projectId})}</p></div>}
   {result&&<p role="status" className="text-sm font-semibold">{result.actions.some(a=>a.status==="failed")?t("init.partial"):t("init.complete")}</p>}
   <div className="space-y-2">{rows.map((a,i)=><details key={`${a.kind}:${a.path}:${i}`} className="rounded border border-edge p-2 text-xs">
    <summary className="cursor-pointer break-all">{t(`init.status.${a.status}`)} · {t(`init.kind.${a.kind}`)} · {a.path}</summary>
    {a.reason&&<p className="pt-2">{t(`init.reason.${a.reason}`)}</p>}{a.error&&<ErrorNote>{a.error}</ErrorNote>}
    {a.content!==undefined&&<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{a.content}</pre>}
   </details>)}</div>
   <div className="flex flex-wrap justify-end gap-2">
    {!result&&<Button size="sm" disabled={applying||plan.loading||changed} onClick={()=>{setError(null);void plan.refetch();}}>{t("init.refreshPreview")}</Button>}
    <Button size="sm" disabled={applying} onClick={()=>setRequest(null)}>{result?t("common.close"):t("common.cancel")}</Button>
    {!result&&<Button size="sm" variant="primary" disabled={!preview||!!blocked||applying||changed||input.busy} onClick={()=>void apply()}>{applying?t("common.loading"):t("init.apply")}</Button>}
   </div>
  </Dialog.Popup></Dialog.Portal>
 </Dialog.Root>;
 return {commands,intercept,start,dialog};
}
