/** F026: explicit persisted Theia lifecycle; no automatic activation on render/app startup. */
import { useEffect, useRef, useState } from "react";
import type { TheiaInstalledEntry, TheiaInstalledResult } from "@contracts/ipc/modules.js";
import { api } from "@renderer/lib/api.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { executeTheiaWithMonaco } from "@renderer/lib/theiaMonacoOwner.js";

type Inspected = Extract<TheiaInstalledResult,{kind:"inspected"}>;
type Started = Extract<TheiaInstalledResult,{kind:"started"}>;
export function TheiaInstalledPanel() {
  const [items,setItems]=useState<TheiaInstalledEntry[]>([]);
  const [pending,setPending]=useState<Inspected|null>(null);
  const [session,setSession]=useState<Started|null>(null);
  const [approved,setApproved]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const [output,setOutput]=useState("");
  const [command,setCommand]=useState("");
  const held=useRef<{ticket?:string;sessionId?:string}>({});
  const unmounted=useRef(false);
  const refresh=async()=>{
    const result=await api.modules.theiaInstalled({op:"list"});
    if(result.kind==="list"&&!unmounted.current)setItems(result.items);
  };
  useEffect(()=>{
    unmounted.current=false;
    void refresh().catch(error=>{if(!unmounted.current)setMessage(String(error));});
    return ()=>{
      unmounted.current=true;
      const {ticket,sessionId}=held.current;held.current={};
      if(ticket)void api.modules.theiaInstalled({op:"cancel",ticket}).catch(()=>{});
      // Closing UI stops only the execution; installed files survive.
      if(sessionId)void api.modules.theiaInstalled({op:"stop",sessionId}).catch(()=>{});
    };
  },[]);
  const task=async(fn:()=>Promise<void>)=>{
    setBusy(true);setMessage(null);
    try{await fn();}catch(error){if(!unmounted.current)setMessage(String(error));}
    finally{if(!unmounted.current)setBusy(false);}
  };
  const inspect=()=>void task(async()=>{
    const selection=await api.pickFiles({title:"选择持久安装的 VSIX",filters:[{name:"VSIX",extensions:["vsix"]}]});
    if(!selection.paths[0])return;
    if(pending){await api.modules.theiaInstalled({op:"cancel",ticket:pending.ticket});held.current.ticket=undefined;setPending(null);}
    const result=await api.modules.theiaInstalled({op:"inspect",path:selection.paths[0]});
    if(result.kind!=="inspected")throw Error("没有生成安装预检报告");
    if(unmounted.current){await api.modules.theiaInstalled({op:"cancel",ticket:result.ticket});return;}
    held.current.ticket=result.ticket;setPending(result);setApproved(false);
  });
  const cancel=()=>void task(async()=>{
    if(!pending)return;
    await api.modules.theiaInstalled({op:"cancel",ticket:pending.ticket});
    held.current.ticket=undefined;setPending(null);setApproved(false);
  });
  const install=()=>void task(async()=>{
    if(!pending||!approved)return;
    held.current.ticket=undefined; // single use, including a failed start
    const result=await api.modules.theiaInstalled({op:"install",ticket:pending.ticket,accepted:true});
    setPending(null);setApproved(false);
    if(result.kind!=="installed")throw Error("没有安装成功");
    await refresh();
  });
  const start=(id:string)=>void task(async()=>{
    const result=await api.modules.theiaInstalled({op:"start",id});
    if(result.kind!=="started")throw Error("扩展未能启动");
    if(unmounted.current){await api.modules.theiaInstalled({op:"stop",sessionId:result.sessionId});return;}
    held.current.sessionId=result.sessionId;
    setSession(result);setCommand(result.commands[0]??"");setOutput("");
    await refresh();
  });
  const stop=()=>void task(async()=>{
    if(!session)return;
    await api.modules.theiaInstalled({op:"stop",sessionId:session.sessionId});
    held.current.sessionId=undefined;setSession(null);setOutput("");await refresh();
  });
  const execute=()=>void task(async()=>{
    if(!session||!command)return;
    const result=await executeTheiaWithMonaco(input=>api.modules.theiaInstalled(input),session.sessionId,command);
    if(result.kind!=="executed")throw Error("命令调用未完成");
    setOutput(result.result);
  });
  const toggle=(item:TheiaInstalledEntry)=>void task(async()=>{
    const result=await api.modules.theiaInstalled({op:"setEnabled",id:item.id,enabled:!item.enabled});
    if(result.kind!=="updated")throw Error("启用状态更新失败");
    await refresh();
  });
  const remove=(item:TheiaInstalledEntry)=>void task(async()=>{
    if(!window.confirm("确定永久卸载 "+item.extensionId+"？这会删除该扩展及其 Mcode 管理的本地扩展数据。"))return;
    const result=await api.modules.theiaInstalled({op:"remove",id:item.id});
    if(result.kind!=="removed")throw Error("卸载失败");
    await refresh();
  });
  return (
    <section className="space-y-2 rounded border border-edge p-3" data-testid="theia-installed-panel">
      <p className="text-body font-semibold">Theia 扩展管理（持久安装）</p>
      <p className="text-code text-content-muted">
        扩展保存在 Mcode 数据根，重启后仍在，但<strong>不会自动执行</strong>。启动需要你本人点击。扩展进程没有运行时沙箱，具备访问本机文件、程序和网络的能力；静态权限报告只是能力下限。
      </p>
      <Button disabled={busy||Boolean(session)} onClick={inspect}>选择 VSIX 并预检安装</Button>
      {pending&&(
        <div className="space-y-2 rounded border border-edge p-2" data-testid="theia-installed-consent">
          <p className="text-code font-semibold">{pending.extensionId} · {pending.fileCount} 个文件</p>
          <p className="text-code">{pending.prompt.headline}</p>
          <ul className="list-disc pl-5 text-code">{pending.prompt.capabilities.map(c=><li key={c.capability}>{c.label}</li>)}</ul>
          <p className="text-code text-content-muted">{pending.prompt.disclosure}</p>
          <ul className="list-disc pl-5 text-code text-content-muted">{pending.prompt.limits.map((v,i)=><li key={i}>{v}</li>)}</ul>
          <label className="flex items-start gap-2 text-code">
            <input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>
            <span>我了解这会持久保存未经运行时隔离的第三方代码，并明确同意安装。</span>
          </label>
          <div className="flex gap-2">
            <Button disabled={busy||!approved} onClick={install}>确认持久安装</Button>
            <Button disabled={busy} onClick={cancel}>取消并清理</Button>
          </div>
        </div>
      )}
      <div className="space-y-2" data-testid="theia-installed-list">
        {items.length===0&&<p className="text-code text-content-muted">尚未安装 Theia 扩展。</p>}
        {items.map(item=><div key={item.id} className="space-y-1 rounded border border-edge p-2">
          <p className="text-code font-semibold">{item.extensionId} · {item.version}</p>
          <p className="text-code text-content-muted">{item.corrupted?"安装记录损坏，已禁止启动":item.enabled?"已安装，启动前会验证全部文件":"已禁用，启动前会验证全部文件"}{item.running?" · 运行中":""}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy||!!session||!item.enabled||!!item.corrupted} onClick={()=>start(item.id)}>启动</Button>
            <Button disabled={busy||item.running||!!item.corrupted} onClick={()=>toggle(item)}>{item.enabled?"禁用":"启用"}</Button>
            <Button disabled={busy||item.running||!!item.corrupted} onClick={()=>remove(item)}>卸载</Button>
          </div>
        </div>)}
      </div>
      {session&&<div className="space-y-2 rounded border border-edge p-2" data-testid="theia-installed-running">
        <p className="text-code">已启动扩展。注册命令：{session.commands.length}</p>
        {session.activationErrors.map((s,i)=><p key={i} className="text-code">{s}</p>)}
        <select value={command} onChange={e=>setCommand(e.target.value)} className="w-full rounded border border-edge bg-surface p-1 text-code">
          {session.commands.map(id=><option key={id} value={id}>{id}</option>)}
        </select>
        <div className="flex gap-2">
          <Button disabled={busy||!command} onClick={execute}>执行命令</Button>
          <Button disabled={busy} onClick={stop}>停止宿主</Button>
        </div>
        {output&&<pre className="max-h-32 overflow-auto whitespace-pre-wrap text-code">{output}</pre>}
      </div>}
      {message&&<ErrorNote>{message}</ErrorNote>}
    </section>
  );
}
