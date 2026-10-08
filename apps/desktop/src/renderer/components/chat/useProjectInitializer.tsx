import { useEffect, useRef, useState } from "react";
import { INIT_NAME_RE, PROJECT_INIT_CHANGED_EVENT, appendInitNote, type ProjectInitResult } from "@contracts/ipc/projectInit";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import type { BuiltInCommand } from "@renderer/lib/slashCommands.js";
// 事件名走契约(与设置页 `ProjectInitManager` 同一份),不在这里再写一遍字面量;
// 仍不 import 那个组件本身 —— 免得把整个设置编辑器拉进每个对话。
const CHANGED = PROJECT_INIT_CHANGED_EVENT;
/** `command` is null while the bare `/init` chooser has not resolved a scenario yet. */
interface Request {sessionId:string;command:string|null;original?:string;chooser:boolean;}
export interface InitComposerSnapshot {text:string;attached:boolean;}
/** 发出 AI 生成说明文件那一轮。返回 false = 没发出去(例如还没配置模型)。 */
export type InitSend = (prompt:string, label:string, sessionId:string) => Promise<boolean|void>|boolean|void;
export type InitChooserOutcome = "started"|"rejected"|"unavailable";
/** Reserved commands are consumed even when invalid/unavailable. They must never
 * reach a provider, a skill, the queue, or running-turn injection. */
export function parseProjectInitCommand(text:string): {command:string;valid:boolean}|null {
 const value=text.trim();if(!/^\/init-/i.test(value))return null;
 const command=value.slice(1);return {command,valid:command.startsWith("init-")&&INIT_NAME_RE.test(command.slice(5))};
}
/** 裸 `/init`(可带补充要求)→ 打开场景选择框。`/init-名称` 与 `/initfoo` 不算。 */
export function parseBareInitCommand(text:string): {note:string}|null {
 const match=/^\/init(?:\s+([\s\S]*))?$/i.exec(text.trim());return match?{note:(match[1]??"").trim()}:null;
}
type SendState = "sent"|"notSent"|"skipped"|null;
export function useProjectInitializer(input:{sessionId:string;busy:boolean;menuOpen?:boolean;snapshot:()=>InitComposerSnapshot;clear:()=>void;send?:InitSend}) {
 const {t}=useI18n();const latest=useRef(input);latest.current=input;const desktop=!!window.api;
 const [version,setVersion]=useState(0);const [request,setRequest]=useState<Request|null>(null);
 const [result,setResult]=useState<ProjectInitResult|null>(null);const [error,setError]=useState<string|null>(null);
 const [applying,setApplying]=useState(false);const lock=useRef(false);
 const [choice,setChoice]=useState("");const [note,setNote]=useState("");const [sent,setSent]=useState<SendState>(null);
 const templates=useRpc(()=>api.projectInit.list(),[version],{enabled:desktop,toastOnError:false});
 useEffect(()=>{const change=()=>setVersion(n=>n+1);window.addEventListener(CHANGED,change);return()=>window.removeEventListener(CHANGED,change);},[]);
 useEffect(()=>{if(desktop&&input.menuOpen)void templates.refetch();},[desktop,input.menuOpen,templates.refetch]);
 useEffect(()=>{if(templates.error)useToastStore.getState().push({kind:"error",title:t("init.title"),body:templates.error.message});},[templates.error,t]);
 const list=templates.data?.templates??[];
 // 选择框:默认场景 → 第一个会生成说明文件的场景 → 第一个;已选的场景被删掉时重新挑。
 useEffect(()=>{
  if(!request?.chooser||result)return;const data=templates.data;if(!data)return;
  if(choice&&data.templates.some(x=>x.id===choice))return;
  const pick=data.templates.find(x=>x.id===data.defaultId)??data.templates.find(x=>x.agentFile)??data.templates[0];
  setChoice(pick?.id??"");
 },[request,choice,templates.data,result]);
 const chosen=request?.chooser?list.find(x=>x.id===choice):undefined;
 const command=request?(request.chooser?(chosen?`init-${chosen.name}`:null):request.command):null;
 const plan=useRpc(async()=>({request,command,preview:await api.projectInit.preview({sessionId:request!.sessionId,command:command!})}),[request,command],{enabled:desktop&&request!==null&&command!==null,toastOnError:false});
 const preview=plan.data?.request===request&&plan.data.command===command&&command!==null&&!plan.loading&&!plan.error?plan.data.preview:null;
 const notice=(body:string)=>useToastStore.getState().push({kind:"error",title:t("init.title"),body});
 const open=(next:Request,initialNote:string)=>{setError(null);setResult(null);setSent(null);setChoice("");setNote(initialNote);setRequest(next);};
 const start=(name:string,original?:string)=>{
  if(!desktop){notice(t("init.desktopOnly"));return false;}
  if(latest.current.busy||lock.current){notice(t("init.busy"));return false;}
  const snapshot=latest.current.snapshot();
  if(snapshot.attached){notice(t("init.noArguments"));return false;}
  open({sessionId:latest.current.sessionId,command:name,original,chooser:false},"");return true;
 };
 /** 裸 `/init`。没有桌面端能力时返回 unavailable,调用方按原来的方式交给引擎。 */
 const startChooser=(initialNote="",original?:string):InitChooserOutcome=>{
  if(!desktop)return "unavailable";
  if(latest.current.busy||lock.current){notice(t("init.busy"));return "rejected";}
  if(latest.current.snapshot().attached){notice(t("init.noAttachments"));return "rejected";}
  if(templates.data)void templates.refetch();
  open({sessionId:latest.current.sessionId,command:null,original,chooser:true},initialNote);return "started";
 };
 const intercept=(text:string,attached=false)=>{
  const bare=parseBareInitCommand(text);
  if(bare){
   if(!desktop)return false;
   if(attached){notice(t("init.noAttachments"));return true;}
   startChooser(bare.note,text);return true;
  }
  const parsed=parseProjectInitCommand(text);if(!parsed)return false;
  if(!parsed.valid||attached){notice(t("init.noArguments"));return true;}
  start(parsed.command,text);return true;
 };
 const apply=async()=>{
  if(!request||!preview||!command||lock.current)return;
  if(latest.current.sessionId!==request.sessionId||latest.current.busy){setError(t("init.contextChanged"));return;}
  lock.current=true;setApplying(true);setError(null);
  try {
   const done=await api.projectInit.apply({sessionId:request.sessionId,command,digest:preview.digest});setResult(done);
   const ok=done.actions.every(a=>a.status!=="failed");
   const current=latest.current.snapshot();
   if(ok&&request.original!==undefined&&latest.current.sessionId===request.sessionId&&current.text.trim()===request.original.trim()&&!current.attached)latest.current.clear();
   if(done.agentPrompt){
    if(!ok)setSent("skipped");
    else {
     const send=latest.current.send;let accepted=false;
     if(send){try{accepted=(await send(appendInitNote(done.agentPrompt,note),t("init.agentStep",{file:done.agentFilename??"AGENTS.md"}),request.sessionId))!==false;}catch{accepted=false;}}
     setSent(accepted?"sent":"notSent");
    }
   }
  }catch(e){setError(String(e));}finally{lock.current=false;setApplying(false);}
 };
 const commands:BuiltInCommand[]=list.map(item=>({name:`init-${item.name}`,description:item.description||t("init.commandHint"),kind:"project-init"}));
 const agent=preview?.agentFile;
 const blocked=preview?.actions.some(a=>a.status==="blocked")||!!agent?.blocked;const changed=request!==null&&request.sessionId!==input.sessionId;
 const rows=result?.actions??preview?.actions??[];
 const close=()=>{setRequest(null);setError(null);setResult(null);setSent(null);setChoice("");setNote("");};
 const dialog=<Dialog.Root open={request!==null} onOpenChange={next=>{if(!next&&!lock.current)close();}}>
  <Dialog.Portal><Dialog.Backdrop/><Dialog.Popup className="flex max-h-[85vh] w-[min(720px,94vw)] flex-col gap-3 overflow-y-auto p-5" data-testid="init-preview">
   <Dialog.Title>{t("init.title")} · /{command??"init"}</Dialog.Title>
   <Dialog.Description>{t("init.confirmHint")}</Dialog.Description>
   {request?.chooser&&!result&&<div className="space-y-1">
    {list.length>0?<label className="block space-y-1 text-sm">{t("init.scenario")}
     <select aria-label={t("init.scenario")} disabled={applying} value={choice} onChange={e=>{setError(null);setChoice(e.target.value);}} className="w-full rounded border border-edge bg-surface p-2 text-sm">
      {list.map(item=><option key={item.id} value={item.id}>{item.name}{item.id===templates.data?.defaultId?` · ${t("init.default")}`:""}</option>)}
     </select></label>:templates.loading?null:<p className="text-sm text-content-muted">{t("init.noTemplates")}</p>}
    {chosen?.description&&<p className="text-xs text-content-subtle">{chosen.description}</p>}
   </div>}
   {plan.loading&&<p role="status">{t("common.loading")}</p>}
   {(error||plan.error||changed)&&<ErrorNote>{changed?t("init.contextChanged"):error??plan.error?.message}</ErrorNote>}
   {preview&&<div className="rounded border border-edge p-2 text-sm"><strong>{preview.projectName}</strong><p className="break-all font-mono text-xs">{preview.root}</p><p className="text-xs text-content-subtle">{t("init.memoryScope",{id:preview.projectId})}</p></div>}
   {result&&<p role="status" className="text-sm font-semibold">{result.actions.some(a=>a.status==="failed")?t("init.partial"):t("init.complete")}</p>}
   {result&&sent&&<p role="status" className="text-sm">{sent==="sent"?t("init.agentSent",{file:result.agentFilename??"AGENTS.md"}):sent==="notSent"?t("init.agentNotSent"):t("init.agentSkipped")}</p>}
   <div className="space-y-2">{rows.map((a,i)=><details key={`${a.kind}:${a.path}:${i}`} className="rounded border border-edge p-2 text-xs">
    <summary className="cursor-pointer break-all">{t(`init.status.${a.status}`)} · {t(`init.kind.${a.kind}`)} · {a.path}</summary>
    {a.reason&&<p className="pt-2">{t(`init.reason.${a.reason}`)}</p>}{a.error&&<ErrorNote>{a.error}</ErrorNote>}
    {a.content!==undefined&&<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{a.content}</pre>}
   </details>)}</div>
   {agent&&!result&&<section className="space-y-2 rounded border border-edge p-3 text-sm" data-testid="init-agent">
    <p><strong>{t("init.agentStep",{file:agent.filename})}</strong> · {agent.exists?t("init.agentImprove"):t("init.agentCreate")}</p>
    <p className="text-xs text-content-subtle">{t("init.agentStepHint")}</p>
    {agent.shadowed&&<p className="text-xs text-content-muted">⚠ {t("init.agentShadowed")}</p>}
    {agent.blocked&&<ErrorNote>{agent.filename} · {t(`init.reason.${agent.blocked}`)}</ErrorNote>}
    <label className="block space-y-1 text-xs">{t("init.agentNote")}
     <textarea aria-label={t("init.agentNote")} maxLength={4000} disabled={applying} value={note} placeholder={t("init.agentNotePlaceholder")} onChange={e=>setNote(e.target.value)} className="min-h-16 w-full rounded border border-edge bg-surface p-2 text-xs"/>
    </label>
    <details className="text-xs"><summary className="cursor-pointer">{t("init.agentPromptPreview")}</summary>
     <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{appendInitNote(agent.prompt,note)}</pre>
    </details>
   </section>}
   <div className="flex flex-wrap justify-end gap-2">
    {!result&&<Button size="sm" disabled={applying||plan.loading||changed||command===null} onClick={()=>{setError(null);void plan.refetch();}}>{t("init.refreshPreview")}</Button>}
    <Button size="sm" disabled={applying} onClick={close}>{result?t("common.close"):t("common.cancel")}</Button>
    {!result&&<Button size="sm" variant="primary" disabled={!preview||!!blocked||applying||changed||input.busy} onClick={()=>void apply()}>{applying?t("common.loading"):agent?t("init.applyAndGenerate"):t("init.apply")}</Button>}
   </div>
  </Dialog.Popup></Dialog.Portal>
 </Dialog.Root>;
 return {commands,intercept,start,startChooser,dialog};
}
