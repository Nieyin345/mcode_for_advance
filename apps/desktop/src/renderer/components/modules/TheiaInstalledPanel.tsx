/** F030: one Mcode extension surface for multiple running VSIX sessions.
 * Mounting/unmounting a settings panel never owns or terminates the extension host.
 * Main process owns host lifetime; window destruction and explicit Stop dispose it.
 */
import { useEffect, useRef, useState } from "react";
import type { TheiaInstalledEntry, TheiaInstalledResult, TheiaNativeConfigSetting } from "@contracts/ipc/modules.js";
import { api } from "@renderer/lib/api.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { executeTheiaWithMonaco } from "@renderer/lib/theiaMonacoOwner.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

type Inspected = Extract<TheiaInstalledResult,{kind:"inspected"}>;
export function TheiaInstalledPanel() {
  const [items,setItems]=useState<TheiaInstalledEntry[]>([]);
  const [pending,setPending]=useState<Inspected|null>(null);
  const [approved,setApproved]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const [selected,setSelected]=useState<Record<string,string>>({});
  const [outputs,setOutputs]=useState<Record<string,string>>({});
  const [configId,setConfigId]=useState<string|null>(null);
  const [configSettings,setConfigSettings]=useState<TheiaNativeConfigSetting[]>([]);
  const [configDrafts,setConfigDrafts]=useState<Record<string,string>>({});
  const pendingRef=useRef<string|null>(null);
  const alive=useRef(false);

  const refresh=async()=>{
    const result=await api.modules.theiaInstalled({op:"list"});
    if(result.kind==="list"&&alive.current)setItems(result.items);
  };
  useEffect(()=>{
    alive.current=true;
    void refresh().catch(error=>{if(alive.current)setMessage(String(error));});
    return ()=>{
      alive.current=false;
      // Installation tickets are local UI preflights. Running extensions are
      // NOT owned by this React panel and must survive navigation/unmount.
      const ticket=pendingRef.current;pendingRef.current=null;
      if(ticket)void api.modules.theiaInstalled({op:"cancel",ticket}).catch(()=>{});
    };
  },[]);
  const task=(fn:()=>Promise<void>)=>void(async()=>{
    if(busy)return;
    setBusy(true);setMessage(null);
    try{await fn();}catch(error){if(alive.current)setMessage(String(error));}
    finally{if(alive.current)setBusy(false);}
  })();
  const inspect=()=>task(async()=>{
    const selection=await api.pickFiles({title:"选择持久安装的 VSIX",filters:[{name:"VSIX",extensions:["vsix"]}]});
    if(!selection.paths[0])return;
    if(pendingRef.current){
      await api.modules.theiaInstalled({op:"cancel",ticket:pendingRef.current});
      pendingRef.current=null;setPending(null);
    }
    const result=await api.modules.theiaInstalled({op:"inspect",path:selection.paths[0]});
    if(result.kind!=="inspected")throw Error("没有生成安装预检报告");
    if(!alive.current){await api.modules.theiaInstalled({op:"cancel",ticket:result.ticket});return;}
    pendingRef.current=result.ticket;setPending(result);setApproved(false);
  });
  const cancel=()=>task(async()=>{
    const ticket=pendingRef.current;
    if(!ticket)return;
    await api.modules.theiaInstalled({op:"cancel",ticket});
    pendingRef.current=null;setPending(null);setApproved(false);
  });
  const install=()=>task(async()=>{
    const ticket=pendingRef.current;
    if(!ticket||!approved)return;
    pendingRef.current=null;
    const result=await api.modules.theiaInstalled({op:"install",ticket,accepted:true});
    setPending(null);setApproved(false);
    if(result.kind!=="installed")throw Error("没有安装成功");
    await refresh();
  });
  const start=(item:TheiaInstalledEntry)=>task(async()=>{
    const state=useSessionStore.getState();
    const workspacePath=state.projects.find(p=>p.id===state.activeProjectId)?.path;
    const result=await api.modules.theiaInstalled({op:"start",id:item.id,workspacePath});
    if(result.kind!=="started")throw Error("扩展未能启动");
    if(!alive.current)return; // no React owner to stop: process is owned by main
    setSelected(previous=>({...previous,[item.id]:result.commands[0]??""}));
    if(result.activationErrors.length)setMessage(result.activationErrors.join("; "));
    await refresh();
  });
  const stop=(item:TheiaInstalledEntry)=>task(async()=>{
    const sessionId=item.activeSession?.sessionId;
    if(!sessionId)return;
    await api.modules.theiaInstalled({op:"stop",sessionId});
    setOutputs(previous=>({...previous,[item.id]:""}));
    await refresh();
  });
  const execute=(item:TheiaInstalledEntry,commandId:string)=>task(async()=>{
    const sessionId=item.activeSession?.sessionId;
    if(!sessionId||!commandId)return;
    const result=await executeTheiaWithMonaco(input=>api.modules.theiaInstalled(input),sessionId,commandId);
    if(result.kind!=="executed")throw Error("命令执行失败");
    if(alive.current)setOutputs(previous=>({...previous,[item.id]:result.result}));
  });
  const showConfig=(item:TheiaInstalledEntry)=>task(async()=>{
    if(configId===item.id){setConfigId(null);return;}
    const result=await api.modules.theiaInstalled({op:"configList",id:item.id});
    if(result.kind!=="configurations")throw Error("无法读取扩展配置");
    setConfigId(item.id);setConfigSettings(result.settings);
    setConfigDrafts(Object.fromEntries(result.settings.map(setting=>
      [setting.key,String(setting.value??"")])));
  });
  const saveConfig=(item:TheiaInstalledEntry,setting:TheiaNativeConfigSetting)=>task(async()=>{
    const raw=configDrafts[setting.key]??"";
    const value=setting.type==="boolean"?raw==="true":
      setting.type==="number"?Number(raw):raw;
    if(setting.type==="number"&&(!raw||!Number.isFinite(value)))throw Error("请输入有效数字");
    const result=await api.modules.theiaInstalled({
      op:"configSet",id:item.id,key:setting.key,value,
    });
    if(result.kind!=="configurationUpdated")throw Error("扩展配置保存失败");
    setMessage("已保存扩展配置："+setting.key);
  });
  const toggle=(item:TheiaInstalledEntry)=>task(async()=>{
    const result=await api.modules.theiaInstalled({op:"setEnabled",id:item.id,enabled:!item.enabled});
    if(result.kind!=="updated")throw Error("扩展启用状态更新失败");
    await refresh();
  });
  const remove=(item:TheiaInstalledEntry)=>task(async()=>{
    if(!window.confirm("确定永久卸载 "+item.extensionId+"？这会删除该扩展及其 Mcode 管理的本地数据。"))return;
    const result=await api.modules.theiaInstalled({op:"remove",id:item.id});
    if(result.kind!=="removed")throw Error("扩展卸载失败");
    await refresh();
  });
  return (
    <section className="space-y-2 rounded border border-edge p-3" data-testid="theia-installed-panel">
      <p className="text-body font-semibold">Mcode 扩展管理（VSIX）</p>
      <p className="text-code text-content-muted">
        扩展安装后会保留，启动需手动确认。离开这个页面不会停止已启动的扩展；
        你可以在 Mcode 命令面板调用它们，停止请使用每个扩展自己的「停止」按钮。
        第三方扩展运行于未隔离的 Node.js 进程，能够访问本机资源。
      </p>
      <Button disabled={busy} onClick={inspect}>选择 VSIX 并预检安装</Button>
      {pending&&(
        <div className="space-y-2 rounded border border-edge p-2" data-testid="theia-installed-consent">
          <p className="text-code font-semibold">{pending.extensionId} · {pending.fileCount} 个文件</p>
          <p className="text-code">{pending.prompt.headline}</p>
          <ul className="list-disc pl-5 text-code">{pending.prompt.capabilities.map(c=><li key={c.capability}>{c.label}</li>)}</ul>
          <p className="text-code text-content-muted">{pending.prompt.disclosure}</p>
          <ul className="list-disc pl-5 text-code text-content-muted">{pending.prompt.limits.map((v,i)=><li key={i}>{v}</li>)}</ul>
          <label className="flex items-start gap-2 text-code">
            <input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>
            <span>我了解安装并运行此扩展的潜在风险，明确同意持久安装。</span>
          </label>
          <div className="flex gap-2">
            <Button disabled={busy||!approved} onClick={install}>确认安装</Button>
            <Button disabled={busy} onClick={cancel}>取消并清理</Button>
          </div>
        </div>
      )}
      <div className="space-y-2" data-testid="theia-installed-list">
        {items.length===0&&<p className="text-code text-content-muted">尚未安装 VSIX 扩展。</p>}
        {items.map(item=>{
          const session=item.activeSession;
          const commands=session?.commands??[];
          const command=commands.includes(selected[item.id]??"")?selected[item.id]:commands[0]??"";
          return <div key={item.id} className="space-y-2 rounded border border-edge p-2">
            <p className="text-code font-semibold">{item.extensionId} · {item.version}</p>
            <p className="text-code text-content-muted">
              {item.corrupted?"安装记录损坏，禁止启动":item.running?
                (session?"运行中，可通过 Mcode 命令面板调用":"其他桌面窗口正在运行"):
                item.enabled?"已安装，启动前会完整校验":"已禁用"}
            </p>
            <div className="flex flex-wrap gap-2">
              {!item.running&&<Button disabled={busy||!item.enabled||!!item.corrupted} onClick={()=>start(item)}>启动</Button>}
              {session&&<Button disabled={busy} onClick={()=>stop(item)}>停止</Button>}
              <Button disabled={busy||!!item.corrupted} onClick={()=>showConfig(item)}>配置</Button>
              <Button disabled={busy||item.running||!!item.corrupted} onClick={()=>toggle(item)}>{item.enabled?"禁用":"启用"}</Button>
              <Button disabled={busy||item.running||!!item.corrupted} onClick={()=>remove(item)}>卸载</Button>
            </div>
            {configId===item.id&&<div className="space-y-2 rounded border border-edge p-2"
              data-testid="mcode-native-extension-config">
              {configSettings.length===0&&<p className="text-code text-content-muted">此扩展没有声明受支持的配置项。</p>}
              {configSettings.map(setting=><div key={setting.key} className="space-y-1">
                <label className="block text-code font-semibold">{setting.key}</label>
                {setting.description&&<p className="text-code text-content-muted">{setting.description}</p>}
                <div className="flex items-center gap-2">
                  {setting.type==="boolean"?
                    <input type="checkbox" checked={configDrafts[setting.key]==="true"}
                      onChange={e=>setConfigDrafts(old=>({...old,[setting.key]:String(e.target.checked)}))}/>:
                    <input type={setting.type==="number"?"number":"text"}
                      value={configDrafts[setting.key]??""}
                      onChange={e=>setConfigDrafts(old=>({...old,[setting.key]:e.target.value}))}
                      className="min-w-0 flex-1 rounded border border-edge bg-surface px-2 py-1 text-code" />}
                  <Button disabled={busy} onClick={()=>saveConfig(item,setting)}>保存</Button>
                </div>
              </div>)}
            </div>}
            {session&&(
              <div className="space-y-2" data-testid="theia-installed-running">
                <p className="text-code text-content-muted">已注册 {commands.length} 个命令；与 Mcode 命令面板共享。</p>
                {commands.length>0&&<>
                  <select value={command} onChange={e=>setSelected(previous=>({...previous,[item.id]:e.target.value}))}
                    className="w-full rounded border border-edge bg-surface p-1 text-code">
                    {commands.map(id=><option key={id} value={id}>{id}</option>)}
                  </select>
                  <Button disabled={busy||!command} onClick={()=>execute(item,command)}>执行命令</Button>
                </>}
                {outputs[item.id]&&<pre className="max-h-32 overflow-auto whitespace-pre-wrap text-code">{outputs[item.id]}</pre>}
              </div>
            )}
          </div>;
        })}
      </div>
      {message&&<ErrorNote>{message}</ErrorNote>}
    </section>
  );
}
