import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { EXAMPLE_MODULE, ModuleManifestSchema, type ModuleCatalog, type ModuleManifest, type ModuleContribution, type ModuleReply, type ModuleTask } from "@contracts/modules";
import { createModuleClient } from "@contracts/moduleClient";
import { api } from "@renderer/lib/api.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { CapabilityCatalogPanel } from "./CapabilityCatalogPanel.js";

export interface SurfaceContext {
  catalog:ModuleCatalog | undefined;
  busy:boolean;
  openManager():void;
  invoke(module:ModuleManifest,contribution:ModuleContribution,path:string):Promise<void>;
}
const Surface=createContext<SurfaceContext|null>(null);

/** One host per file panel, not a subscription/RPC per tree row. Project-keyed
 * by the parent. An invoked job outlives this view; history reopens its snapshot. */
export function ModuleSurface({projectPath,children}:{projectPath:string;children:ReactNode}) {
  const {t,locale}=useI18n();
  const text=(v:{zh:string;en:string})=>v[locale];
  const catalog=useRpc(()=>api.modules.catalog(),[],{toastOnError:false});
  const [manager,setManager]=useState(false),[reply,setReply]=useState<ModuleReply|null>(null);
  useSuppressBrowserView(manager || reply !== null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const busyRef=useRef(false),alive=useRef(true);
  const [draft,setDraft]=useState(JSON.stringify(EXAMPLE_MODULE,null,2)),[consent,setConsent]=useState(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const history=useRpc(()=>api.modules.tasks({projectPath}),[projectPath],{enabled:manager,toastOnError:false});
  const mutate=async(fn:()=>Promise<void>)=>{
    if(busyRef.current)return;
    busyRef.current=true;setBusy(true);setError(null);
    try{await fn();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
    finally{busyRef.current=false;if(alive.current)setBusy(false);}
  };
  const invoke=async(module:ModuleManifest,contribution:ModuleContribution,path:string)=>{
    await mutate(async()=>{
      const result=await createModuleClient(api.modules,module.id).invoke(contribution.id,{projectPath,path},crypto.randomUUID());
      if(alive.current)setReply(result);
    });
  };
  const install=async()=>{
    await mutate(async()=>{
      const manifest=ModuleManifestSchema.parse(JSON.parse(draft));
      await api.modules.install({manifest,confirmReadAccess:true});
      if(alive.current){setConsent(false);await catalog.refetch();}
    });
  };
  return <Surface.Provider value={{catalog:catalog.data,busy,openManager:()=>setManager(true),invoke}}>
    {children}
    {error && !manager && <ErrorNote action={<Button onClick={()=>setError(null)}>{t("common.close")}</Button>}>{error}</ErrorNote>}
    <Dialog.Root open={manager} onOpenChange={setManager}>
      <Dialog.Portal><Dialog.Backdrop/><Dialog.Popup className="max-h-[85vh] w-[min(92vw,760px)] space-y-4 overflow-auto p-5">
        <Dialog.Title>{t("ide.modules.title")}</Dialog.Title><Dialog.Close/>
        <Dialog.Description>{t("ide.modules.boundary")}</Dialog.Description>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="space-y-2">{catalog.data?.modules.map(m=><div key={m.id} className="flex items-center gap-2 rounded border border-edge p-2 text-sm">
          <span className="flex-1">{text(m.title)} <code className="text-xs text-content-muted">{m.id} · {m.version}</code></span>
          {!m.id.startsWith("core.") && <Button disabled={busy} onClick={()=>void mutate(async()=>{await api.modules.remove({moduleId:m.id});await catalog.refetch();await history.refetch();})}>{t("ide.modules.remove")}</Button>}
        </div>)}</div>
        <CapabilityCatalogPanel catalog={catalog.data} loading={catalog.loading} error={catalog.error} onRetry={()=>void catalog.refetch()}/>
        <label className="block space-y-2 text-sm"><span>{t("ide.modules.manifest")}</span>
          <textarea data-testid="module-manifest" className="h-52 w-full rounded border border-edge bg-surface-muted p-2 font-mono text-xs" value={draft} onChange={e=>{setDraft(e.target.value);setConsent(false);}} spellCheck={false}/>
        </label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>{t("ide.modules.consent")}</label>
        <Button variant="primary" disabled={busy||!consent} onClick={()=>void install()}>{t("ide.modules.install")}</Button>
        <h3 className="text-sm font-semibold">{t("ide.modules.history")}</h3>
        <p className="text-xs text-content-muted">{t("ide.modules.retention")}</p>
        <Button onClick={()=>void history.refetch()}>{t("ide.modules.refresh")}</Button>
        {history.error && <ErrorNote>{history.error.message}</ErrorNote>}
        {history.loading && !history.data && <LoadingNote label={t("common.loading")}/>}
        {history.data?.length===0 && <p className="text-xs text-content-muted">{t("ide.modules.empty")}</p>}
        {history.data?.map(task=><Button key={task.id} className="block w-full truncate text-left" onClick={()=>{setManager(false);setReply({type:"task",task});}}>{text(task.view.title)} · {task.resource.path}</Button>)}
      </Dialog.Popup></Dialog.Portal>
    </Dialog.Root>
    {reply && <ModuleResultDialog key={reply.type==="task"?reply.task.id:"query"} reply={reply} onClose={()=>setReply(null)}/>}
  </Surface.Provider>;
}

/** 自定义 UI 的文件右键(`components/customUi/FileMenuEntries.tsx`)取模块项用。
 * 不在 ModuleSurface 里(比如别处挂的文件树)时是 null —— 那里就没有模块项。 */
export function useModuleSurface(): SurfaceContext | null {
  return useContext(Surface);
}

/** 打开模块管理浮窗。Files 面板上已经不挂它了(入口搬进「设置 → 自定义 UI → 高级」),
 * 冒烟夹具仍按这个名字用。 */
export function ModuleToolsButton() {
  const context=useContext(Surface),{t}=useI18n();
  if(!context)return null;
  return <Button size="sm" onClick={context.openManager}>{t("ide.modules.title")}</Button>;
}

/** The actual file-tree menu extension point. Data contributes native host
 * menu items; arbitrary HTML/JS/DOM injection is never evaluated. */
export function ModuleMenuItems({path}:{path:string}) {
  const context=useContext(Surface),{locale}=useI18n();
  if(!context)return null;
  const entries=context.catalog?.modules.flatMap(module=>module.contributions.filter(c=>!c.extensions||c.extensions.some(ext=>path.toLowerCase().endsWith(ext))).map(contribution=>({module,contribution})))??[];
  if(!entries.length)return null;
  return <><ContextMenu.Separator className="my-1 h-px bg-edge"/>{entries.map(({module,contribution})=><ContextMenu.Item key={module.id+":"+contribution.id} disabled={context.busy} onClick={()=>void context.invoke(module,contribution,path)} className="flex w-full items-center px-3 py-1.5 text-xs text-content outline-none data-[highlighted]:bg-surface-muted data-[disabled]:opacity-50">{contribution.title[locale]}</ContextMenu.Item>)}</>;
}

export function ModuleResultDialog({reply,onClose}:{reply:ModuleReply;onClose:()=>void}) {
  const {t,locale}=useI18n();
  const initial=reply.type==="task"?reply.task:null;
  const read=useRpc(async()=>{if(!initial)throw Error("No task");return createModuleClient(api.modules,initial.moduleId).task(initial.id);},[initial?.id],{enabled:!!initial,toastOnError:false});
  const task=read.data??initial;
  const [error,setError]=useState<string|null>(null),[cancelling,setCancelling]=useState(false);
  useEffect(()=>{
    if(!initial || read.error || task?.status!=="running" || read.loading)return;
    const timer=setTimeout(()=>void read.refetch(),500);return()=>clearTimeout(timer);
  },[initial?.id,task?.status,task?.updatedAt,read.loading,read.error,read.refetch]);
  const view=reply.type==="task"?reply.task.view:reply.view;
  const result=reply.type==="result"?reply.value:task?.result;
  const statusKeys={running:"ide.modules.running",completed:"ide.modules.completed",failed:"ide.modules.failed",cancelled:"ide.modules.cancelled"} as const;
  const cancel=async()=>{
    if(!initial||cancelling)return;setCancelling(true);setError(null);
    try{await createModuleClient(api.modules,initial.moduleId).cancel(initial.id);await read.refetch();}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setCancelling(false);}
  };
  return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}>
    <Dialog.Portal><Dialog.Backdrop/><Dialog.Popup className="max-h-[85vh] w-[min(92vw,640px)] space-y-4 overflow-auto p-5">
      <Dialog.Title>{view.title[locale]}</Dialog.Title><Dialog.Close/>
      <Dialog.Description>{initial?.resource.path??t("ide.modules.result")}</Dialog.Description>
      {task && <div role="status" className="space-y-2 text-sm"><span>{t(statusKeys[task.status])}</span><progress className="w-full" max={1} value={task.progress} aria-label={t("ide.modules.progress")}/>
        {task.status==="running" && <Button disabled={cancelling} onClick={()=>void cancel()}>{t("ide.modules.cancel")}</Button>}
      </div>}
      {read.error && <ErrorNote action={<Button onClick={()=>void read.refetch()}>{t("common.retry")}</Button>}>{read.error.message}</ErrorNote>}
      {(error||task?.error) && <ErrorNote>{error??task?.error}</ErrorNote>}
      {result && <dl className="space-y-3">{view.fields.map(field=><div key={field.key} className="rounded border border-edge p-3"><dt className="text-xs text-content-muted">{field.title[locale]}</dt><dd className="mt-1 break-all font-mono text-sm">{Object.hasOwn(result,field.key)?String(result[field.key]):"—"}</dd></div>)}</dl>}
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
