import { useEffect, useState, useSyncExternalStore } from "react";
import { AGENT_FILE_NAMES, ProjectInitDraftSchema, buildAgentFilePrompt, type AgentFileConfig, type ProjectInitDraft, type ProjectInitTemplate } from "@contracts/ipc/projectInit";
import { MEMORY_CATEGORIES } from "@contracts/memory";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, ErrorNote, Input } from "@renderer/components/ui/index.js";
export const INIT_CHANGED = "mcode:project-initializers-changed";
type Draft = { draft: ProjectInitDraft; id?: string; revision?: string; baseline: string };
// 新场景默认带上「AI 生成说明文件」:这是 /init 最常用的那一步。
const empty = (): Draft => ({draft:{name:"",description:"",directories:[],files:[],memories:[],agentFile:{enabled:true,filename:"AGENTS.md",focus:""}},baseline:""});
// Preserve unsaved drafts across settings tabs; never persist them as templates.
const kept = new Map<string, Draft>();
let last = "new";
let mutationPending = false;
let lastError: string | null = null;
let lastSaved = false;
let epoch = 0;
const listeners = new Set<() => void>();
const publish = () => { epoch++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => epoch;
const setPending = (value: boolean) => { mutationPending = value; publish(); };
const setError = (value: string | null) => { lastError = value; publish(); };
const setSaved = (value: boolean) => { lastSaved = value; publish(); };
const area = "min-h-24 w-full rounded border border-edge bg-surface p-2 font-mono text-xs";
export function ProjectInitManager() {
 const {t}=useI18n();const desktop=!!window.api;
 useSyncExternalStore(subscribe,snapshot);
 const selected=last;const entry=kept.get(selected)??empty();
 const pending=mutationPending;const error=lastError;const saved=lastSaved;
 const [confirmDelete,setConfirmDelete]=useState(false);const [confirmReload,setConfirmReload]=useState(false);
 const list=useRpc(()=>api.projectInit.list(),[],{enabled:desktop,toastOnError:false});
 useEffect(()=>{if(!desktop)return;const refresh=()=>void list.refetch();window.addEventListener(INIT_CHANGED,refresh);return()=>window.removeEventListener(INIT_CHANGED,refresh);},[desktop,list.refetch]);
 const read=useRpc(async()=>({key:selected,value:await api.projectInit.get({id:selected})}),[selected],{enabled:desktop&&selected!=="new"&&!kept.has(selected),toastOnError:false});
 const loaded=selected==="new"||kept.has(selected);
 const accept=(key:string,value:Draft)=>{kept.set(key,value);last=key;publish();};
 useEffect(()=>{
  if(read.data?.key===selected&&!read.loading&&!read.error&&!kept.has(selected)) {
   const {id,revision,...draft}=read.data.value;const value={id,revision,draft,baseline:JSON.stringify(draft)};
   kept.set(selected,value);publish();
  }
 },[read.data,read.loading,read.error,selected]);
 const update=(draft:ProjectInitDraft)=>{const next={...entry,draft};kept.set(selected,next);setSaved(false);setError(null);};
 const choose=(key:string)=>{last=key;setSaved(false);setError(null);};
 const notify=()=>{window.dispatchEvent(new Event(INIT_CHANGED));};
 const save=async()=>{
  if(mutationPending)return;const parsed=ProjectInitDraftSchema.safeParse({...entry.draft,directories:entry.draft.directories.filter(p=>p!=="")});
  if(!parsed.success){setError(t("init.invalid")+": "+parsed.error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; "));return;}
  setPending(true);setError(null);const key=selected;
  try {
   const result:ProjectInitTemplate=await api.projectInit.save({id:entry.id,expectedRevision:entry.revision,draft:parsed.data});
   const {id,revision,...draft}=result;kept.delete(key);accept(id,{id,revision,draft,baseline:JSON.stringify(draft)});setSaved(true);notify();
  }catch(e){setError(String(e));}finally{setPending(false);}
 };
 const remove=async()=>{
  if(mutationPending||!entry.id||!entry.revision)return;setPending(true);setError(null);
  try {await api.projectInit.delete({id:entry.id,expectedRevision:entry.revision});kept.delete(selected);accept("new",kept.get("new")??empty());notify();}
  catch(e){setError(String(e));}finally{setPending(false);setConfirmDelete(false);}
 };
 const defaultId=list.data?.defaultId??null;
 const toggleDefault=async()=>{
  if(mutationPending||!entry.id)return;setPending(true);setError(null);
  try {await api.projectInit.setDefault({id:defaultId===entry.id?null:entry.id});notify();}
  catch(e){setError(String(e));}finally{setPending(false);}
 };
 /** 以当前内容(含未保存改动)开一个新场景,名称加后缀;不会自动保存。 */
 const duplicate=()=>{
  const draft:ProjectInitDraft={...structuredClone(entry.draft),name:(entry.draft.name+t("init.copySuffix")).slice(0,48)};
  kept.set("new",{draft,baseline:""});choose("new");
 };
 if(!desktop)return <p className="p-4 text-sm text-content-muted">{t("init.desktopOnly")}</p>;
 const d=entry.draft;const dirty=entry.baseline!==JSON.stringify(d);
 const agent=d.agentFile;
 const setAgent=(patch:Partial<AgentFileConfig>)=>update({...d,agentFile:{enabled:true,filename:"AGENTS.md",focus:"",...d.agentFile,...patch}});
 return <div className="space-y-4 p-4" data-testid="init-manager">
  <p className="text-sm text-content-muted">{t("init.description")}</p>
  <div className="flex flex-wrap items-center gap-2">
   <select aria-label={t("init.choose")} disabled={pending} value={selected} onChange={e=>choose(e.target.value)} className="min-w-0 flex-1 rounded border border-edge bg-surface p-2 text-sm">
    <option value="new">{t("init.new")}</option>
    {list.data?.templates.map(item=><option key={item.id} value={item.id}>/init-{item.name}{item.id===defaultId?` · ${t("init.default")}`:""}{kept.has(item.id)&&kept.get(item.id)!.baseline!==JSON.stringify(kept.get(item.id)!.draft)?" *":""}</option>)}
   </select>
   <Button size="sm" disabled={pending} onClick={()=>{choose("new");}}>{t("init.new")}</Button>
   <Button size="sm" variant="ghost" disabled={pending} onClick={()=>void list.refetch()}>{t("memory.assistant.refresh")}</Button>
  </div>
  {(error||list.error||read.error)&&<ErrorNote>{error??list.error?.message??read.error?.message}</ErrorNote>}
  {!loaded?<Button size="sm" onClick={()=>void read.refetch()}>{read.loading?t("common.loading"):t("memory.assistant.retry")}</Button>:<fieldset disabled={pending} className="space-y-4">
   <label className="block space-y-1 text-sm">{t("init.name")}<Input aria-label={t("init.name")} value={d.name} maxLength={48} onChange={e=>update({...d,name:e.target.value})}/></label>
   <p className="break-all font-mono text-xs text-content-subtle">/init-{d.name} · {t("init.nameHint")}</p>
   <label className="block space-y-1 text-sm">{t("init.note")}<Input aria-label={t("init.note")} value={d.description} maxLength={500} onChange={e=>update({...d,description:e.target.value})}/></label>
   <label className="block space-y-1 text-sm">{t("init.directories")}<textarea aria-label={t("init.directories")} className={area} value={d.directories.join("\n")} onChange={e=>update({...d,directories:e.target.value.split("\n")})}/></label>
   <section className="space-y-2"><h3 className="text-sm font-semibold">{t("init.files")}</h3>
    {d.files.map((file,i)=><div key={i} className="space-y-2 rounded border border-edge p-3">
     <Input aria-label={t("init.filePath")} placeholder={t("init.filePath")} value={file.path} onChange={e=>update({...d,files:d.files.map((v,j)=>j===i?{...v,path:e.target.value}:v)})}/>
     <textarea aria-label={t("init.content")} className={area} value={file.content} onChange={e=>update({...d,files:d.files.map((v,j)=>j===i?{...v,content:e.target.value}:v)})}/>
     <Button size="sm" variant="ghost" onClick={()=>update({...d,files:d.files.filter((_,j)=>j!==i)})}>{t("common.delete")}</Button>
    </div>)}
    <Button size="sm" disabled={d.files.length>=100} onClick={()=>update({...d,files:[...d.files,{path:"",content:""}]})}>{t("init.addFile")}</Button>
   </section>
   <section className="space-y-2"><h3 className="text-sm font-semibold">{t("init.memories")}</h3><p className="text-xs text-content-subtle">{t("init.memoryHint")}</p>
    {d.memories.map((m,i)=>{const change=(patch:Partial<typeof m>)=>update({...d,memories:d.memories.map((v,j)=>j===i?{...v,...patch}:v)});return <div key={i} className="space-y-2 rounded border border-edge p-3">
     <select className="rounded border border-edge bg-surface p-2 text-sm" aria-label={t("init.category")} value={m.category} onChange={e=>change({category:e.target.value as typeof m.category})}>{MEMORY_CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}</select>
     <Input aria-label={t("init.memoryFile")} placeholder={t("init.memoryFile")} value={m.filename} onChange={e=>change({filename:e.target.value})}/>
     <Input aria-label={t("init.memoryTitle")} placeholder={t("init.memoryTitle")} value={m.title} onChange={e=>change({title:e.target.value})}/>
     <textarea aria-label={t("init.content")} className={area} value={m.content} onChange={e=>change({content:e.target.value})}/>
     <label className="flex gap-2 text-sm"><input type="checkbox" checked={m.pinned} onChange={e=>change({pinned:e.target.checked})}/>{t("init.pinned")}</label>
     <Button size="sm" variant="ghost" onClick={()=>update({...d,memories:d.memories.filter((_,j)=>j!==i)})}>{t("common.delete")}</Button>
    </div>;})}
    <Button size="sm" disabled={d.memories.length>=30} onClick={()=>update({...d,memories:[...d.memories,{category:"project",filename:"",title:"",content:"",pinned:true}]})}>{t("init.addMemory")}</Button>
   </section>
   <section className="space-y-2" data-testid="init-agent-config"><h3 className="text-sm font-semibold">{t("init.agentFile")}</h3><p className="text-xs text-content-subtle">{t("init.agentFileHint")}</p>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!agent?.enabled} onChange={e=>setAgent({enabled:e.target.checked})}/>{t("init.agentEnable")}</label>
    {agent?.enabled&&<div className="space-y-2 rounded border border-edge p-3">
     <label className="block space-y-1 text-sm">{t("init.agentFilename")}
      <select className="block rounded border border-edge bg-surface p-2 text-sm" aria-label={t("init.agentFilename")} value={agent.filename} onChange={e=>setAgent({filename:e.target.value as AgentFileConfig["filename"]})}>{AGENT_FILE_NAMES.map(name=><option key={name} value={name}>{name}</option>)}</select>
     </label>
     <p className="text-xs text-content-subtle">{agent.filename==="AGENTS.md"?t("init.agentFilenameAgents"):t("init.agentFilenameClaude")}</p>
     <label className="block space-y-1 text-sm">{t("init.agentFocus")}<textarea aria-label={t("init.agentFocus")} maxLength={8000} className={area} placeholder={t("init.agentFocusPlaceholder")} value={agent.focus} onChange={e=>setAgent({focus:e.target.value})}/></label>
     <details className="text-xs"><summary className="cursor-pointer">{t("init.agentPromptPreview")}</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{buildAgentFilePrompt({filename:agent.filename,exists:false,scenario:d.name||"…",focus:agent.focus,scaffold:[...d.directories.filter(p=>p!==""),...d.files.map(f=>f.path)]})}</pre>
     </details>
    </div>}
   </section>
   <div className="flex flex-wrap items-center gap-2">
    <Button variant="primary" size="sm" onClick={()=>void save()}>{pending?t("common.loading"):t("common.save")}</Button>
    <Button size="sm" variant="ghost" onClick={()=>setConfirmReload(true)}>{t("init.discard")}</Button>
    {entry.id&&<Button size="sm" variant="ghost" title={defaultId===entry.id?t("init.isDefault"):undefined} onClick={()=>void toggleDefault()}>{defaultId===entry.id?t("init.clearDefault"):t("init.setDefault")}</Button>}
    {entry.id&&<Button size="sm" variant="ghost" onClick={duplicate}>{t("init.duplicate")}</Button>}
    {entry.id&&<Button size="sm" variant="ghost" onClick={()=>setConfirmDelete(true)}>{t("common.delete")}</Button>}
    <span className="text-xs text-content-subtle" role="status">{saved?t("init.saved"):dirty?t("init.unsaved"):""}</span>
   </div>
  </fieldset>}
  <ConfirmDialog open={confirmReload} danger title={t("init.discard")} description={t("init.discardHint")} confirmText={t("init.discard")} onOpenChange={setConfirmReload} onConfirm={()=>{
   kept.delete(selected);setSaved(false);setError(null);setConfirmReload(false);
   if(selected!=="new")void read.refetch();
  }}/>
  <ConfirmDialog open={confirmDelete} danger title={t("init.deleteTitle")} description={t("init.deleteHint")} confirmText={t("common.delete")} onOpenChange={open=>{if(!pending)setConfirmDelete(open);}} onConfirm={()=>void remove()}/>
 </div>;
}
