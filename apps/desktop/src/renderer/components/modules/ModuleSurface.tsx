import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { EXAMPLE_MODULE, ModuleManifestSchema, type ModuleCatalog, type ModuleManifest, type ModuleContribution, type ModuleReply, type ModuleTask } from "@contracts/modules";
import { createModuleClient } from "@contracts/moduleClient";
import { defaultModuleGrants } from "@contracts/modulePermissions";
import { MODULE_HIGH_RISK_PERMISSIONS, type ModulePermission } from "@contracts/appPermission";
import { api } from "@renderer/lib/api.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { CapabilityCatalogPanel } from "./CapabilityCatalogPanel.js";
import { ModuleInstallConsentHost, useInstallConsentCard } from "./ModuleInstallConsentCard.js";
import { VsixInstallSection } from "./VsixInstallSection.js";

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
  const [riskAcknowledged,setRiskAcknowledged]=useState(false);
  const busyRef=useRef(false),alive=useRef(true);
  const [draft,setDraft]=useState(JSON.stringify(EXAMPLE_MODULE,null,2)),[consent,setConsent]=useState(false),[codeConsent,setCodeConsent]=useState(false);
  const [granted,setGranted]=useState<ModulePermission[]>(() => defaultModuleGrants(EXAMPLE_MODULE));
  const draftManifest=(()=>{try{return ModuleManifestSchema.parse(JSON.parse(draft));}catch{return null;}})();
  const requested = draftManifest?.permissions ?? [];
  const groups = [...new Set(requested.map(p=>p.split(".")[0]))];
  // 【MC-035】草稿里是否声明了执行程序 —— 决定"执行代码"那份同意需不需要出现。
  // 解析失败(草稿写坏)时不显示,安装时会由 schema 给出更准确的错误。
  const draftHasProgram=(()=>{try{return (JSON.parse(draft) as {program?:unknown}).program!==undefined;}catch{return false;}})();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const history=useRpc(()=>api.modules.tasks({projectPath}),[projectPath],{enabled:manager,toastOnError:false});
  const egress=useRpc(()=>api.modules.egressConsentGet(),[],{enabled:manager,toastOnError:false});
  const mutate=async(fn:()=>Promise<void>)=>{
    if(busyRef.current)return;
    busyRef.current=true;setBusy(true);setError(null);
    try{await fn();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
    finally{busyRef.current=false;if(alive.current)setBusy(false);}
  };
  /** 【ARC-006 Gate E】安装/升级/卸载的**变更诊断**：取消数 > 0 弹一条 info toast
   *  （「已取消 N 个运行中任务」—— 用户刚点了升级，需要知道旧任务被停掉）；
   *  取消失败非空时把原因摆进 `ErrorNote`（不静默）。`t` 来自 `useI18n`，
   *  组件外的 store 不参与这条路径。 */
  const reportChange=(result:{cancelledTasks?:number;cancelFailures?:Array<{taskId:string;reason:string}>}|null|undefined)=>{
    if(!alive.current||!result)return;
    const cancelled=result.cancelledTasks??0;
    if(cancelled>0){
      useToastStore.getState().push({
        kind:"info",
        title:t("ide.modules.changeCancelled",{count:cancelled}),
      });
    }
    const failures=result.cancelFailures??[];
    if(failures.length>0){
      setError(t("ide.modules.changeCancelFailed",{count:failures.length})+"："+failures.map(f=>f.reason).join("；"));
    }
  };
  /** 【T18】菜单调用一个**「允许一次」已因重启失效**的扩展时，先按原授权子集
   *  重新弹卡（允许一次 / 始终允许 / 拒绝）。拒绝则不调用 —— 换来的是一句明确的
   *  「需要重新授权」，而不是一个莫名其妙的失败。持久授权不会走到这里
   *  （`moduleStaleConsents` 只收 `reason:"restart"` 的会话级记录）。 */
  const ensureConsent=async(module:ModuleManifest):Promise<boolean>=>{
    const stale=catalog.data?.moduleStaleConsents?.[module.id];
    if(!stale)return true;
    const decision=await installCard.request({manifest:module,granted:stale.granted.filter((p):p is ModulePermission=>module.permissions.includes(p)),upgrading:false,origin:"desktop"});
    if(decision==="deny")return false;
    await api.modules.install({
      manifest:module,confirmReadAccess:true,grantedPermissions:stale.granted.filter(p=>module.permissions.includes(p)),installConsent:decision,
      ...(module.program!==undefined?{confirmExecutableCode:true as const}:{}),
    });
    await catalog.refetch();
    return true;
  };
  const invoke=async(module:ModuleManifest,contribution:ModuleContribution,path:string)=>{
    await mutate(async()=>{
      if(!(await ensureConsent(module)))throw Error(t("ide.modules.consentCard.reconsentRequired"));
      const result=await createModuleClient(api.modules,module.id).invoke(contribution.id,{projectPath,path},crypto.randomUUID());
      if(alive.current)setReply(result);
    });
  };
  /** 【T18】安装必须经过**安装卡**（允许一次 / 始终允许 / 拒绝）。清单面板负责
   *  收集"声明了什么 / 这次授予哪些"，卡片负责拿到**三态决定**；「拒绝」/ 关闭 /
   *  Esc 一律不调用 `api.modules.install` —— 拒绝 = 不写盘。 */
  const installCard = useInstallConsentCard();
  const install=async()=>{
    await mutate(async()=>{
      const manifest=ModuleManifestSchema.parse(JSON.parse(draft));
      const decision=await installCard.request({
        manifest, granted,
        upgrading:Boolean(catalog.data?.modules.some(m=>m.id===manifest.id && !m.id.startsWith("core."))),
        origin:"desktop",
      });
      if(decision==="deny")return; // 拒绝：磁盘无任何写入
      const result=await api.modules.install({
        manifest,confirmReadAccess:true,grantedPermissions:granted,installConsent:decision,
        // 【MC-035】可执行扩展的第二次同意由 UI 的独立勾选框给出;纯声明式模块不传。
        ...(manifest.program!==undefined?{confirmExecutableCode:true as const}:{}),
      });
      reportChange(result);
      if(alive.current){setConsent(false);setCodeConsent(false);await catalog.refetch();}
    });
  };
  return <Surface.Provider value={{catalog:catalog.data,busy,openManager:()=>setManager(true),invoke}}>
    {children}
    {/* 【T18】安装卡挂在这里（`App` 根也挂一份）—— 夹具只渲染 ModuleSurface 时
        卡片仍然在树上；两份在场时只有持有者画卡。 */}
    <ModuleInstallConsentHost />
    {error && !manager && <ErrorNote action={<Button onClick={()=>setError(null)}>{t("common.close")}</Button>}>{error}</ErrorNote>}
    <Dialog.Root open={manager} onOpenChange={setManager}>
      <Dialog.Portal><Dialog.Backdrop/><Dialog.Popup className="max-h-[85vh] w-[min(92vw,760px)] space-y-4 overflow-auto p-5">
        <Dialog.Title>{t("ide.modules.title")}</Dialog.Title><Dialog.Close/>
        <Dialog.Description>{t("ide.modules.boundary")}</Dialog.Description>
        {error && <ErrorNote>{error}</ErrorNote>}
        {egress.error && <ErrorNote>{egress.error.message}</ErrorNote>}
        {!egress.loading && egress.data?.osIsolation===false && <section className="space-y-2 rounded border border-warning/60 p-3" data-testid="module-egress-downgrade">
          <p className="text-body font-semibold">{t("ide.modules.egressTitle")}</p>
          <p className="text-code text-content-muted">{t("ide.modules.egressWarning")}</p>
          <p role="status" className="text-code">{t(egress.data.enabled?"ide.modules.egressEnabled":"ide.modules.egressDisabled")}</p>
          {!egress.data.enabled && <label className="flex gap-2 text-code" data-testid="module-egress-acknowledgment">
            <input type="checkbox" checked={riskAcknowledged} onChange={e=>setRiskAcknowledged(e.target.checked)}/>
            {t("ide.modules.egressAck")}
          </label>}
          <Button disabled={busy||(!egress.data.enabled&&!riskAcknowledged)} onClick={()=>void mutate(async()=>{
            await api.modules.egressConsentSet({enabled:!egress.data!.enabled,acknowledgeRisk:true});
            setRiskAcknowledged(false);
            await egress.refetch();
          })}>{t(egress.data.enabled?"ide.modules.egressDisable":"ide.modules.egressEnable")}</Button>
        </section>}
        <div className="space-y-2">{catalog.data?.modules.map(m=><div key={m.id} className="flex items-center gap-2 rounded border border-edge p-2 text-body">
          <span className="flex-1">{text(m.title)} <code className="text-code text-content-muted">{m.id} · {m.version}</code></span>
          {!m.id.startsWith("core.") && <Button disabled={busy} onClick={()=>void mutate(async()=>{const result=await api.modules.remove({moduleId:m.id});reportChange(result);await catalog.refetch();await history.refetch();})}>{t("ide.modules.remove")}</Button>}
          {!m.id.startsWith("core.") && <section className="w-full space-y-1" data-testid={`module-grants-${m.id}`}>
            <p className="text-code font-semibold">{t("ide.modules.granted")}</p>
            {!catalog.data?.modulePermissions?.[m.id] && <p className="text-code text-content-muted">{t("ide.modules.noGrant")}</p>}
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {m.permissions.map(permission=><label key={permission} className="flex items-center gap-1 text-code">
                <input type="checkbox" disabled={busy} checked={catalog.data?.modulePermissions?.[m.id]?.granted.includes(permission)??false}
                  onChange={event=>void mutate(async()=>{
                    const before=catalog.data?.modulePermissions?.[m.id]?.granted ?? [];
                    const next=event.target.checked ? [...before,permission] : before.filter(p=>p!==permission);
                    await api.modules.setPermissions({moduleId:m.id,grantedPermissions:next});
                    await catalog.refetch();
                  })}/>
                <code>{permission}</code>{MODULE_HIGH_RISK_PERMISSIONS.has(permission) && <span>{t("ide.modules.highRisk")}</span>}
              </label>)}
            </div>
          </section>}
        </div>)}</div>
        <CapabilityCatalogPanel catalog={catalog.data} loading={catalog.loading} error={catalog.error} onRetry={()=>void catalog.refetch()}/>
        {/* 【F006】从 .vsix 装真实扩展 —— 放在手填清单**之前**：对绝大多数用户来说
            这是他们真正想要的那条路，手填 JSON 是给写扩展的人的。 */}
        <VsixInstallSection onInstalled={()=>void catalog.refetch()}/>
        <label className="block space-y-2 text-body"><span>{t("ide.modules.manifest")}</span>
          <textarea data-testid="module-manifest" className="h-52 w-full rounded border border-edge bg-surface-muted p-2 font-mono text-code" value={draft} onChange={e=>{setDraft(e.target.value);setConsent(false);setCodeConsent(false);
            try{setGranted(defaultModuleGrants(ModuleManifestSchema.parse(JSON.parse(e.target.value))));}catch{setGranted([]);}
          }} spellCheck={false}/>
        </label>
        <section className="space-y-2 rounded border border-edge p-3" data-testid="module-permission-picker">
          <p className="text-body font-semibold">{t("ide.modules.permissionsRequest")}</p>
          <p className="text-code text-content-muted">{t("ide.modules.upgradeConsent")}</p>
          {groups.map(group=><div key={group} className="space-y-1">
            <p className="text-code font-medium">{group}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">{requested.filter(permission=>permission.startsWith(group+".")).map(permission=><label key={permission} className="flex items-center gap-2 text-code">
              <input type="checkbox" checked={granted.includes(permission)}
                onChange={event=>setGranted(before=>event.target.checked ? [...before,permission] : before.filter(p=>p!==permission))}/>
              <code>{permission}</code>{MODULE_HIGH_RISK_PERMISSIONS.has(permission) && <span className="text-warning">{t("ide.modules.highRisk")}</span>}
            </label>)}</div>
          </div>)}
          <fieldset className="space-y-1 border-t border-edge pt-2" disabled data-testid="module-permissions-nondelegable">
            <legend className="text-code text-content-muted">{t("ide.modules.nondelegable")}</legend>
            {["claude.approve","workflow.approve","customModel.getToken"].map(method=><label key={method} className="flex items-center gap-2 text-code text-content-muted">
              <input type="checkbox" disabled checked={false}/><code>{method}</code>
            </label>)}
          </fieldset>
          {draftManifest===null && <p className="text-code text-warning">{t("ide.modules.manifest")}</p>}
        </section>
        <label className="flex items-center gap-2 text-code"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>{t("ide.modules.consent")}</label>
        {/* 【MC-035】执行代码是**另一件事**:与只读声明的同意分开勾。清单里没有 program 时
            不出现 —— 不给纯声明式模块制造"你到底同意了啥"的歧义。 */}
        {draftHasProgram && egress.data?.osIsolation===false && <p role="alert" className="text-code text-warning">{t("ide.modules.egressInstallNotice")}</p>}
        {draftHasProgram && <label className="flex items-center gap-2 text-code" data-testid="module-code-consent">
          <input type="checkbox" checked={codeConsent} onChange={e=>setCodeConsent(e.target.checked)}/>{t("ide.modules.codeConsent")}
        </label>}
        <Button variant="primary" disabled={busy||!consent||(draftHasProgram&&!codeConsent)} onClick={()=>void install()}>{t("ide.modules.install")}</Button>
        <h3 className="text-body font-semibold">{t("ide.modules.history")}</h3>
        <p className="text-code text-content-muted">{t("ide.modules.retention")}</p>
        <Button onClick={()=>void history.refetch()}>{t("ide.modules.refresh")}</Button>
        {history.error && <ErrorNote>{history.error.message}</ErrorNote>}
        {history.loading && !history.data && <LoadingNote label={t("common.loading")}/>}
        {history.data?.length===0 && <p className="text-code text-content-muted">{t("ide.modules.empty")}</p>}
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
  const entries=context.catalog?.modules.flatMap(module=>module.contributions.filter(c=>c.slot === "files.context" && (!c.extensions||c.extensions.some(ext=>path.toLowerCase().endsWith(ext)))).map(contribution=>({module,contribution})))??[];
  if(!entries.length)return null;
  return <><ContextMenu.Separator className="my-1 h-px bg-edge"/>{entries.map(({module,contribution})=><ContextMenu.Item key={module.id+":"+contribution.id} disabled={context.busy} onClick={()=>void context.invoke(module,contribution,path)} className="flex w-full items-center px-3 py-1.5 text-code text-content outline-none data-[highlighted]:bg-surface-muted data-[disabled]:opacity-50">{contribution.title[locale]}</ContextMenu.Item>)}</>;
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
      {task && <div role="status" className="space-y-2 text-body"><span>{t(statusKeys[task.status])}</span><progress className="w-full" max={1} value={task.progress} aria-label={t("ide.modules.progress")}/>
        {task.status==="running" && <Button disabled={cancelling} onClick={()=>void cancel()}>{t("ide.modules.cancel")}</Button>}
      </div>}
      {read.error && <ErrorNote action={<Button onClick={()=>void read.refetch()}>{t("common.retry")}</Button>}>{read.error.message}</ErrorNote>}
      {(error||task?.error) && <ErrorNote>{error??task?.error}</ErrorNote>}
      {result && <dl className="space-y-3">{(view.fields.length ? view.fields : Object.keys(result).map(key=>({key,title:{zh:key,en:key}}))).map(field=><div key={field.key} className="rounded border border-edge p-3"><dt className="text-code text-content-muted">{field.title[locale]}</dt><dd className="mt-1 break-all font-mono text-body">{Object.hasOwn(result,field.key)?String(result[field.key]):"—"}</dd></div>)}</dl>}
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
