import { useEffect, useMemo, useState } from "react";
import type { ModuleCatalog, ModuleContribution, ModuleManifest, ModuleReply, ModuleSettingProperty } from "@contracts/modules";
import { createModuleClient } from "@contracts/moduleClient";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { CUSTOM_ICONS } from "@renderer/components/customUi/registry.js";
import { IconEye } from "@renderer/lib/icons.js";
// 【T41】形状判据与它的提示出口拆在独立模块里 —— 纯件,且四个消费点共用一份。
// 这里 import **并且** re-export:只写 `export … from` 不会在本文件作用域里绑定名字,
// 而本文件的 `ModuleViewDock` 自己也要用它们。
import { contributionsOf, moduleCatalogShapeError, ModuleCatalogNotice } from "./moduleCatalogShape.js";
export { contributionsOf, moduleCatalogShapeError, ModuleCatalogNotice };

/** Catalog refreshes after the settings overlay closes (the module manager lives there). */
export function useModuleContributions(enabled = true) {
  const settingsOpen = useSessionStore(s => s.settingsOpen);
  return useRpc(() => api.modules.catalog(), [settingsOpen], { enabled, toastOnError:false });
}

/** ModuleHost's current resource contract is strictly a regular file within a known project.
 * Never fake a resource or silently loosen the host's authorization boundary. */
export function useModuleFileResource() {
  const activeProjectId = useSessionStore(s => s.activeProjectId);
  const projectPath = useSessionStore(s => s.projects.find(p => p.id === s.activeProjectId)?.path ?? null);
  const path = useSessionStore(s => activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null);
  return projectPath && path ? { projectPath, path } : null;
}

/** Native declarative view. Never executes HTML or injects DOM from manifest/result. */
export function ModuleViewDock({ location }: {location:"left"|"right"|"bottom"}) {
  const {locale} = useI18n();
  const catalog = useModuleContributions();
  const entries = useMemo(()=>contributionsOf(catalog.data,"view").filter(x=>x.contribution.location===location),[catalog.data,location]);
  const [selected,setSelected] = useState<string|null>(null);
  const chosen = entries.find(({module,contribution})=>module.id+":"+contribution.id===selected) ?? entries[0];
  const id = chosen ? chosen.module.id+":"+chosen.contribution.id : null;
  const resource = useModuleFileResource();
  const [reply,setReply] = useState<ModuleReply|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [revision,setRevision] = useState(0);
  useEffect(()=>{setReply(null);setError(null);},[id,resource?.path]);
  useEffect(()=>{
    if (!chosen || !resource) return;
    let alive = true;
    setBusy(true); setError(null);
    const client=createModuleClient(api.modules,chosen.module.id);
    void (async()=>{
      let response=await client.invoke(chosen.contribution.id,resource,crypto.randomUUID());
      if(alive)setReply(response);
      // A declarative view may also target a task capability. Poll the same
      // host snapshot rather than leaving "running" on screen indefinitely.
      while(alive && response.type==="task" && response.task.status==="running"){
        await new Promise<void>(resolve=>setTimeout(resolve,500));
        if(!alive)break;
        response={type:"task",task:await client.task(response.task.id)};
        if(alive)setReply(response);
      }
    })()
      .catch(err=>{if(alive)setError(err instanceof Error?err.message:String(err));})
      .finally(()=>{if(alive)setBusy(false);});
    return ()=>{alive=false;};
  },[id,resource?.projectPath,resource?.path,revision]);
  // 【T41】目录读不懂时**不能** return null —— 那会让已经打开的扩展视图无声消失。
  // 渲染一条明确的提示,并保留坞的外壳,用户才看得出「不是没有扩展,是目录坏了」。
  const shapeError = moduleCatalogShapeError(catalog.data);
  if (!entries.length) {
    if (!shapeError) return null;
    const notice = <ModuleCatalogNotice catalog={catalog} className="m-2" />;
    return location === "right" || location === "left" || location === "bottom"
      ? <section data-testid={`module-view-${location}`} className="flex min-h-0 flex-col border-t border-edge bg-surface text-sm">{notice}</section>
      : notice;
  }
  const result = reply?.type === "result" ? reply.value : reply?.task.result;
  return <section data-testid={`module-view-${location}`} className="flex min-h-0 flex-col border-t border-edge bg-surface text-sm">
    <div className="flex shrink-0 items-center gap-1 border-b border-edge p-2">
      <select aria-label={locale==="zh"?"扩展视图":"Extension views"} value={id??""} onChange={e=>setSelected(e.target.value)}
        className="min-w-0 flex-1 rounded bg-surface-muted p-1">
        {entries.map(({module,contribution})=><option key={module.id+":"+contribution.id} value={module.id+":"+contribution.id}>{contribution.title[locale]} · {module.title[locale]}</option>)}
      </select>
      <button type="button" data-testid="module-view-refresh" disabled={!resource||busy} onClick={()=>setRevision(n=>n+1)}
        className="rounded border border-edge px-2 py-1" aria-label={locale==="zh"?"刷新扩展视图":"Refresh extension view"}>↻</button>
    </div>
    <div className="min-h-0 overflow-y-auto p-3">
      {!resource && <p role="status">{locale==="zh"?"先打开工作区中的文件，才能运行扩展能力。":"Open a workspace file to run this extension capability."}</p>}
      {busy && <p role="status">{locale==="zh"?"加载中…":"Loading…"}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      {result && chosen && <dl className="space-y-2">{chosen.contribution.view.fields.map(field=><div key={field.key} className="rounded border border-edge p-2">
        <dt className="text-xs text-content-muted">{field.title[locale]}</dt>
        <dd data-testid={`module-view-field-${field.key}`} className="break-all font-mono">{Object.hasOwn(result,field.key)?String(result[field.key]):"—"}</dd>
      </div>)}</dl>}
      {reply?.type==="task" && !result && <p role="status">{reply.task.status}</p>}
    </div>
  </section>;
}

/** Each property stays in extensionStore under the extension's own host-issued module id.
 * SettingsRepo / setting.set is intentionally never used. */
export function ModuleSettingControl({moduleId, property}:{moduleId:string;property:ModuleSettingProperty}) {
  const {locale} = useI18n();
  const stored = useRpc(()=>api.extensionStore.get({extensionId:moduleId,key:property.key}),[moduleId,property.key],{toastOnError:false});
  const [value,setValue] = useState<string|number|boolean>(property.default);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [saved,setSaved] = useState(false);
  useEffect(()=>{setValue(property.default);setSaved(false);},[moduleId,property.key,property.default]);
  useEffect(()=>{
    if (!stored.data) return;
    const raw = stored.data.value;
    const good = property.type==="boolean" ? typeof raw==="boolean"
      : property.type==="number" ? typeof raw==="number" && Number.isFinite(raw)
      : typeof raw==="string" && (property.type!=="enum" || property.enum.includes(raw));
    setValue(good ? raw as string|number|boolean : property.default);
  },[stored.data,property]);
  const save = async() => {
    setBusy(true);setError(null);setSaved(false);
    try {
      const r=await api.extensionStore.set({extensionId:moduleId,key:property.key,value});
      if (!r.ok) throw Error("Extension store quota exceeded");
      setSaved(true);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  return <div className="space-y-1 rounded border border-edge p-3" data-testid={`module-setting-${moduleId}-${property.key}`}>
    <label className="block text-sm font-medium" htmlFor={`module-${moduleId}-${property.key}`}>{property.title[locale]}</label>
    {property.description && <p className="text-xs text-content-muted">{property.description[locale]}</p>}
    {property.type==="string" && <input id={`module-${moduleId}-${property.key}`} className="w-full rounded border border-edge p-2" value={String(value)} maxLength={4096} onChange={e=>{setValue(e.target.value);setSaved(false);}}/>}
    {property.type==="number" && <input id={`module-${moduleId}-${property.key}`} type="number" className="w-full rounded border border-edge p-2" value={String(value)} onChange={e=>{const next=e.target.valueAsNumber;if(Number.isFinite(next))setValue(next);setSaved(false);}}/>}
    {property.type==="boolean" && <input id={`module-${moduleId}-${property.key}`} type="checkbox" checked={Boolean(value)} onChange={e=>{setValue(e.target.checked);setSaved(false);}}/>}
    {property.type==="enum" && <select id={`module-${moduleId}-${property.key}`} value={String(value)} onChange={e=>{setValue(e.target.value);setSaved(false);}} className="w-full rounded border border-edge p-2">
      {property.enum.map(item=><option key={item} value={item}>{item}</option>)}
    </select>}
    <button type="button" className="rounded border border-edge px-3 py-1 text-xs" disabled={busy||stored.loading||!!stored.error} onClick={()=>void save()}>
      {busy ? "…" : locale==="zh"?"保存":"Save"}
    </button>
    {saved && <span role="status" className="ml-2 text-xs">{locale==="zh"?"已保存到扩展存储":"Saved to extension storage"}</span>}
    {(error||stored.error) && <p role="alert" className="text-xs text-danger">{error??stored.error?.message}</p>}
  </div>;
}
export function ModuleSettingsPanel() {
  const {locale} = useI18n();
  const {data,error,loading,refetch} = useModuleContributions();
  const groups = contributionsOf(data,"settings");
  return <section className="space-y-4 py-5" data-testid="module-settings-group">
    <header><h2 className="text-lg font-semibold">{locale==="zh"?"扩展设置":"Extension settings"}</h2>
      <p className="text-sm text-content-muted">{locale==="zh"?"按扩展分组，值仅保存在各扩展的私有存储中。":"Grouped by extension; values stay in each extension's private store."}</p></header>
    {loading && <p>{locale==="zh"?"加载中…":"Loading…"}</p>}
    {error && <p role="alert">{error.message}<button onClick={()=>void refetch()}> ↻ </button></p>}
    {!loading && !error && groups.length===0 && <p className="text-content-muted">{locale==="zh"?"尚无扩展设置贡献":"No extension settings contributions yet"}</p>}
    {groups.map(({module,contribution})=><section data-testid={`module-settings-${module.id}`} key={module.id+":"+contribution.id} className="space-y-2 rounded border border-edge p-3">
      <h3 className="font-semibold">{module.title[locale]} · {contribution.title[locale]}</h3>
      {contribution.properties.map(property=><ModuleSettingControl key={property.key} moduleId={module.id} property={property}/>)}
    </section>)}
  </section>;
}

/** Only renderer-registered icons are ever instanced; no dynamic SVG/URL. */
export function ModuleIcon({name}:{name:typeof import("@contracts/modules").MODULE_CONTRIBUTION_ICONS[number]|undefined}) {
  const Icon = name ? CUSTOM_ICONS[name] : IconEye;
  return <Icon size={15} className="shrink-0"/>;
}
