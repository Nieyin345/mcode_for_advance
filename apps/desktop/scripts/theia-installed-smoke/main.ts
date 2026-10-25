/** F026: no user data; injected temp root, real Theia host and tamper-negative tests. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { registerTheiaInstalledHandlers } from "../../src/main/ipc/theiaInstalled.js";
import { IPC } from "@contracts/ipc";
import { TheiaInstalledRegistry } from "../../src/main/modules/theiaHost/installedRegistry.js";
import { policyFor } from "../../src/main/appControl/policy.js";
import { APP_METHOD_PERMISSIONS } from "@contracts/appPermission";

const root=process.env.MCODE_SMOKE_REPO_ROOT;
if(!root) throw Error("MCODE_SMOKE_REPO_ROOT missing");
const theia=path.join(root,"vendor/theia");
if(!existsSync(path.join(theia,"packages/plugin-ext/lib/hosted/node/plugin-host.js"))||
   !existsSync(path.join(theia,"packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js"))) {
  console.error("THEIA_BUILD_REQUIRED");process.exit(2);
}
let pass=0,fail=0;
function check(name:string,ok:boolean,info?:unknown):void {
  if(ok){pass++;console.log("  ok "+name);}else{fail++;console.error("  FAIL "+name+" "+String(info??""));}
}
async function rejects(name:string,call:()=>unknown|Promise<unknown>):Promise<void>{
  let error="";try{await call();}catch(e){error=String(e);}
  check(name,!!error,error);
}
function crc32(raw: Buffer): number {
  let crc = 0xffffffff;
  for (const b of raw) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
interface Entry { name: string; bytes: Buffer; mode?: number; corruptCrc?: boolean; declaredSize?: number }
function zip(entries: Entry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = deflateRawSync(entry.bytes);
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(entry.corruptCrc ? crc + 1 : crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.declaredSize ?? entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.mode === undefined ? 0 : (entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const middle = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(middle.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, middle, eocd]);
}

const fixture=path.join(root,"apps/desktop/scripts/theia-host-boot-smoke/fixtures/spawn-ext");
const pkg=readFileSync(path.join(fixture,"package.json"));
const main=readFileSync(path.join(fixture,"extension.js"));
const entries=[{name:"extension/package.json",bytes:pkg},{name:"extension/extension.js",bytes:main},
  {name:"extension/docs/info.txt",bytes:Buffer.from("fixture")}];
const dir=mkdtempSync(path.join(tmpdir(),"mcode-f026-")), store=path.join(dir,"theia-extensions");
const vsix=path.join(dir,"sample.vsix");
writeFileSync(vsix,zip(entries));
let manager:TheiaInstalledRegistry|undefined;
try{
  check("F026: Agent 不得管理本机持久扩展",policyFor("modules.theiaInstalled").level==="blocked");
  check("F026: 管理扩展是 mutating 而非只读",policyFor("modules.theiaInstalled").effect==="mutating");
  check("F026: 扩展不得委托宿主安装其他代码",APP_METHOD_PERMISSIONS["modules.theiaInstalled"]===null);
  manager=new TheiaInstalledRegistry(store,theia);
  check("全新数据根列表为空",manager.list().length===0);
  const first=await manager.inspect(51,vsix);
  check("预检发放一次性 ticket 与静态权限报告",first.kind==="inspected"&&first.prompt.disclosure.includes("不是沙箱"));
  if(first.kind!=="inspected")throw Error("inspection missing");
  check("预检阶段没有安装扩展",manager.list().length===0);
  await rejects("其他窗口不可抢占当前安装预检",()=>manager!.inspect(52,vsix));
  await rejects("非本人不可使用 ticket 安装",()=>manager!.install(52,first.ticket,true));
  await rejects("伪造 ticket 不可安装",()=>manager!.install(51,"06548fd9-a1eb-49f0-9590-b677923081e9",true));
  const installed=manager.install(51,first.ticket,true);
  if(installed.kind!=="installed")throw Error("installation failed");
  const id=installed.item.id;
  check("明确同意后持久安装入库",manager.list().length===1&&manager.list()[0].id===id);
  check("安装目标在注入数据根而非用户目录",existsSync(path.join(store,"installed",id,"record.json")));
  await rejects("一个 ticket 不能装第二遍",()=>manager!.install(51,first.ticket,true));
  await rejects("重复同一 publisher.name 被明确拒绝",()=>manager!.inspect(51,vsix));
  await manager.disposeAll();
  manager=new TheiaInstalledRegistry(store,theia);
  check("重建管理器后只恢复元数据，不自动运行也不假称校验通过",manager.list().length===1&&manager.list()[0].running===false&&manager.list()[0].integrity==="not-checked");
  const disabled=manager.setEnabled(id,false);
  check("禁用状态持久化",disabled.kind==="updated"&&!disabled.item.enabled);
  await rejects("禁用后的扩展不能启动",()=>manager!.start(51,id));
  manager.setEnabled(id,true);
  const run=await manager.start(51,id);
  if(run.kind!=="started")throw Error("could not start");
  check("手动启动真正 Theia Host 后命令已注册",run.commands.includes("mcodeSmoke.spawnEcho"),run);
  const ownCommands=manager.list(51)[0].activeSession;
  check("Mcode 原生命令面板能发现本人会话的真实 Theia 命令",
    ownCommands?.sessionId===run.sessionId&&ownCommands.commands.includes("mcodeSmoke.spawnEcho"));
  check("另一桌面窗口不能取得运行会话的可执行令牌",manager.list(52)[0].activeSession===undefined);
  check("无 sender 的普通安装列表不能泄露扩展执行令牌",manager.list()[0].activeSession===undefined);
  await rejects("运行时禁止重复启动",()=>manager!.start(51,id));
  await rejects("未注册命令不得调用",()=>manager!.execute(51,run.sessionId,"mcodeSmoke.declaredOnly"));
  await rejects("另一窗口不得调用扩展命令",()=>manager!.execute(52,run.sessionId,"mcodeSmoke.spawnEcho"));
  const reply=await manager.execute(51,run.sessionId,"mcodeSmoke.spawnEcho");
  check("真实 Theia 扩展执行结果可回传",reply.kind==="executed"&&reply.result.includes('"echo":"pong"'));
  await rejects("扩展运行中禁止卸载",()=>manager!.remove(id));
  await rejects("扩展运行中禁止禁用",()=>manager!.setEnabled(id,false));
  const stopped=await manager.stop(51,run.sessionId);
  check("停止真实子进程不会删除已安装扩展",stopped.kind==="stopped"&&manager.list().length===1);
  check("停止扩展后不再向 Mcode 命令面板发布注册命令",manager.list(51)[0].activeSession===undefined);
  await rejects("停止后的旧会话不能继续执行",()=>manager!.execute(51,run.sessionId,"mcodeSmoke.spawnEcho"));
  // F027: synthetic 24 MiB payload in the ISOLATED temp root. Catalogue must never hash it.
  const large=path.join(store,"installed",id,"extension","perf-data.bin");
  const sample=Buffer.alloc(24*1024*1024,0x57);
  writeFileSync(large,sample);
  const recordPath=path.join(store,"installed",id,"record.json");
  const record=JSON.parse(readFileSync(recordPath,"utf8")) as {files:Record<string,string>};
  record.files["perf-data.bin"]=createHash("sha256").update(sample).digest("hex");
  writeFileSync(recordPath,JSON.stringify(record));
  const beforeList=performance.now();
  for(let k=0;k<40;k++)manager.list();
  const listMs=performance.now()-beforeList;
  const beforeHash=performance.now();
  for(let k=0;k<10;k++)createHash("sha256").update(readFileSync(large)).digest("hex");
  const fullHashMs=performance.now()-beforeHash;
  console.log("  PERF (same machine, synthetic temp fixture): list 40x="+listMs.toFixed(1)+"ms; full SHA-256 24MiB 10x="+fullHashMs.toFixed(1)+"ms");
  check("40 次扩展列表无需重复哈希 24MiB 文件",listMs<fullHashMs,{listMs,fullHashMs});
  // A disappearing payload must not block an ordinary catalogue view; startup still fails closed.
  const hidden=large+".hidden";
  renameSync(large,hidden);
  check("列表不扫描文件内容：未校验的元数据不能被显示成校验通过",manager.list()[0].integrity==="not-checked");
  renameSync(hidden,large);
  const extFile=path.join(store,"installed",id,"extension","extension.js");
  writeFileSync(extFile,Buffer.concat([main,Buffer.from("\n// tampered\n")]));
  check("列表不扫描扩展内容，并明确标注启动前才做完整性检查",manager.list()[0].integrity==="not-checked");
  let eventLoopTick=false;
  const tick=setTimeout(()=>{eventLoopTick=true;},0);
  await rejects("扩展文件被篡改必须拒绝启动",()=>manager!.start(51,id));
  clearTimeout(tick);
  check("大文件完整性校验让出主线程事件循环",eventLoopTick);
  writeFileSync(extFile,main);
  check("恢复源文件后列表保持元数据状态",manager.list()[0].integrity==="not-checked");
  rmSync(large,{force:true});
  delete record.files["perf-data.bin"];
  writeFileSync(recordPath,JSON.stringify(record));
  const originalRecord=readFileSync(recordPath,"utf8");
  writeFileSync(recordPath,"invalid-json");
  check("损坏安装记录仍在列表中明确报告",manager.list()[0].integrity==="corrupt"&&manager.list()[0].corrupted===true);
  writeFileSync(recordPath,originalRecord);
  const removed=manager.remove(id);
  check("卸载后持久目录消失",removed.kind==="removed"&&!existsSync(path.join(store,"installed",id)));
  check("卸载后的目录和列表都为空",manager.list().length===0);
  const pending=await manager.inspect(51,vsix);
  if(pending.kind!=="inspected")throw Error("final inspection missing");
  await manager.disposeSender(51);
  await rejects("窗口退出废除安装 ticket",()=>manager!.install(51,pending.ticket,true));
  check("窗口关闭清理未授权暂存目录",readdirSync(path.join(store,"staging")).length===0);

  // Use the real desktop handler, not a second dispatch implementation, to prove IPC wiring.
  const calls = new Map<string,(event:unknown,arg:unknown)=>Promise<unknown>>();
  registerTheiaInstalledHandlers({handle:(channel:string,handler:(event:unknown,arg:unknown)=>Promise<unknown>)=>{
    calls.set(channel,handler);
  }} as never,{dataRoot:()=>dir,theiaRoot:theia});
  const invoke=calls.get(IPC.MODULE_THEIA_INSTALLED);
  check("持久扩展桌面 IPC 单独注册",calls.size===1&&typeof invoke==="function");
  if(!invoke)throw Error("missing F026 IPC handler");
  const mainFrame={};
  const wc=Object.assign(new EventEmitter(),{id:99,mainFrame,isDestroyed:()=>false});
  const actor={sender:wc,senderFrame:mainFrame};
  await rejects("没有桌面 sender 的调用被拒绝",()=>invoke({}, {op:"list"}));
  await rejects("子框架的调用被拒绝",()=>invoke({sender:wc,senderFrame:{}}, {op:"list"}));
  await rejects("非法输入字段不允许逃过 schema",()=>invoke(actor, {op:"list",accepted:true}));
  const before=await invoke(actor,{op:"list"}) as {kind:string;items:unknown[]};
  check("产品 IPC 从真实持久根列出扩展",before.kind==="list"&&before.items.length===0);
  const ipcInspect=await invoke(actor,{op:"inspect",path:vsix}) as {kind:string;ticket:string};
  check("IPC 可以生成安装权限确认 ticket",ipcInspect.kind==="inspected");
  await rejects("IPC 的安装拒绝无确认标志",()=>invoke(actor,{op:"install",ticket:ipcInspect.ticket,accepted:false}));
  const ipcAdded=await invoke(actor,{op:"install",ticket:ipcInspect.ticket,accepted:true}) as
    {kind:string;item:{id:string}};
  check("IPC 用户确认后真实写入持久安装",ipcAdded.kind==="installed"&&!!ipcAdded.item.id);
  const ipcLive=await invoke(actor,{op:"start",id:ipcAdded.item.id}) as
    {kind:string;sessionId:string;commands:string[]};
  check("IPC 手动启动真实 Theia 子进程",ipcLive.kind==="started"&&ipcLive.commands.includes("mcodeSmoke.spawnEcho"));
  const ipcRunningList=await invoke(actor,{op:"list"}) as {kind:string;items:Array<{activeSession?:{sessionId:string;commands:string[]}}>} ;
  check("真实 IPC list 返回当前窗口可执行的注册命令",
    ipcRunningList.items[0]?.activeSession?.sessionId===ipcLive.sessionId&&
    ipcRunningList.items[0]?.activeSession?.commands.includes("mcodeSmoke.spawnEcho")===true);
  const ipcOutput=await invoke(actor,{op:"execute",sessionId:ipcLive.sessionId,commandId:"mcodeSmoke.spawnEcho"}) as
    {kind:string;result:string};
  check("IPC 扩展命令结果正常返回",ipcOutput.kind==="executed"&&ipcOutput.result.includes('"echo":"pong"'));
  await invoke(actor,{op:"stop",sessionId:ipcLive.sessionId});
  await invoke(actor,{op:"remove",id:ipcAdded.item.id});
  check("IPC 卸载后恢复空列表",(await invoke(actor,{op:"list"}) as {items:unknown[]}).items.length===0);
  wc.emit("destroyed");
  await rejects("销毁窗口后旧 IPC sender 不可重新安装",()=>invoke(actor,{op:"inspect",path:vsix}));
}finally{
  if(manager)await manager.disposeAll();
  rmSync(dir,{recursive:true,force:true});
}
console.log("NOT-COVERED: Electron U1, packaged Theia runtime, Monaco editor, runtime sandbox, auto-start intentionally disabled");
console.log("theia-installed-smoke: "+pass+"/"+(pass+fail)+" 通过");
process.exitCode=fail?1:0;
