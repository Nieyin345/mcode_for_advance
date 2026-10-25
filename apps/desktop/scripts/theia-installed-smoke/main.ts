/** F026: no user data; injected temp root, real Theia host and tamper-negative tests. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { registerTheiaInstalledHandlers } from "../../src/main/ipc/theiaInstalled.js";
import { IPC } from "@contracts/ipc";
import { TheiaInstalledRegistry } from "../../src/main/modules/theiaHost/installedRegistry.js";
import { McodeExtensionState } from "../../src/main/modules/theiaHost/mcodeExtensionState.js";
import { McodeTheiaTerminalDriver } from "../../src/main/modules/theiaHost/mcodeTerminalDriver.js";
import { policyFor } from "../../src/main/appControl/policy.js";
import { APP_METHOD_PERMISSIONS } from "@contracts/appPermission";
import { registerTheiaMonacoOwner, subscribeTheiaMonacoEdits, executeTheiaWithMonaco, applyTheiaMonacoEdit } from "../../src/renderer/lib/theiaMonacoOwner.js";
import type { TheiaMonacoEditRequest, TheiaRuntimeMessage, TheiaQuickInputRequest, TheiaStatusEntry, TheiaDiagnosticsEvent } from "@contracts/ipc/modules.js";

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
  const driverRoot=path.join(dir,"terminal-workspace");
  mkdirSync(driverRoot,{recursive:true});
  const nativeCalls:string[]=[];
  const driver=new McodeTheiaTerminalDriver("native-owner-1",driverRoot,{
    create:async p=>{nativeCalls.push("create:"+p.cwd);return {ok:true,terminalId:"native-"+nativeCalls.length,pid:1042};},
    write:(id,data)=>{nativeCalls.push("write:"+id+":"+data);return true;},
    kill:id=>{nativeCalls.push("kill:"+id);return true;},
  });
  await rejects("扩展终端不得越出 Mcode 当前项目",()=>driver.create("bad",{cwd:"../outside"}));
  await rejects("扩展终端不得选择其他 shell 可执行文件",()=>driver.create("override",{shellPath:"C:/other.exe"}));
  const terminalOne=await driver.create("one",{name:"VS Code"});
  check("原生扩展终端真正使用 Mcode 注入的 PTY create",terminalOne==="one"&&nativeCalls.some(x=>x.startsWith("create:"))&&driver.getProcessId("one")===1042);
  await driver.sendText("one","echo native",true);
  check("扩展终端输入由已有 Mcode PTY 管理器接收且保留回车语义",
    nativeCalls.some(x=>x.includes("echo native\\r"))||nativeCalls.some(x=>x.includes("echo native\r")));
  await driver.disposeAll();
  check("停止扩展 session 只清理本会话创建的原生终端",
    nativeCalls.some(x=>x.startsWith("kill:native-")));
  await rejects("扩展停止后无法继续创建终端",()=>driver.create("late",{}));
  const storageTest=await McodeExtensionState.open(path.join(dir,"concurrency-state"),path.join(dir,"concurrency-project"));
  await Promise.all([
    storageTest.set("first.extension",{count:1},true),
    storageTest.set("second.extension",{count:2},true),
  ]);
  const reopenedState=await McodeExtensionState.open(path.join(dir,"concurrency-state"),path.join(dir,"concurrency-project"));
  check("并行扩展状态写入不会丢失前一个插件的数据",
    reopenedState.get("first.extension",true)?.count===1&&
    reopenedState.get("second.extension",true)?.count===2);
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
  const availableConfig=await manager.configList(id);
  check("Mcode 扩展设置页读取 VS Code 清单声明的真实配置",
    availableConfig.kind==="configurations"&&availableConfig.settings.some(s=>
      s.key==="mcodeSmoke.greeting"&&s.value==="hello-from-manifest-default"));
  await rejects("拒绝未在 VS Code 扩展清单中声明的配置项",
    ()=>manager!.configSet(51,id,"other.extension.unsafe","x"));
  const configured=await manager.configSet(51,id,"mcodeSmoke.greeting","from-mcode-ui");
  check("Mcode 原生扩展配置保存到托管数据根",
    configured.kind==="configurationUpdated"&&
    readFileSync(path.join(store,"installed",id,"storage","preferences.json"),"utf8").includes("from-mcode-ui"));
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
  const workspace=path.join(dir,"mcode-project");
  mkdirSync(workspace,{recursive:true});
  const webviewEvents:Array<{handle:string;action:string;html?:string;payload?:unknown}>=[];
  const terminalEvents:string[]=[];
  const terminalDriver=(sessionId:string,root:string)=>{
    check("扩展终端和真实 Mcode 工作区与扩展会话绑定",!!sessionId&&root===workspace);
    return {
      create:async(terminalId:string,opts:{name?:string})=>{
        terminalEvents.push("create:"+terminalId+":"+opts.name);return terminalId;
      },
      getProcessId:()=>1042,
      sendText:async(terminalId:string,input:string,execute?:boolean)=>{
        terminalEvents.push("send:"+terminalId+":"+input+":"+Boolean(execute));
      },
      dispose:async(terminalId:string)=>{terminalEvents.push("dispose:"+terminalId);},
      disposeAll:async()=>{terminalEvents.push("disposeAll");},
    };
  };
  const run=await manager.start(51,id,undefined,workspace,undefined,undefined,undefined,terminalDriver,
    (_session,_extension,event)=>webviewEvents.push(event));
  if(run.kind!=="started")throw Error("could not start");
  check("手动启动真正 Theia Host 后命令已注册",run.commands.includes("mcodeSmoke.spawnEcho"),run);
  const terminalResponse=await manager.execute(51,run.sessionId,"mcodeSmoke.nativeTerminal");
  for(let attempts=0;attempts<30&&!terminalEvents.some(x=>x.startsWith("dispose:"));attempts++)
    await new Promise(resolve=>setTimeout(resolve,15));
  check("真实 VS Code 创建/发送/释放终端都经过注入的 Mcode 原生 driver",
    terminalResponse.kind==="executed"&&terminalResponse.result.includes('"pid":1042')&&
    terminalEvents.some(x=>x.startsWith("create:"))&&
    terminalEvents.some(x=>x.includes("echo Mcode terminal"))&&
    terminalEvents.some(x=>x.startsWith("dispose:")),terminalEvents);
  const webviewCall=await manager.execute(51,run.sessionId,"mcodeSmoke.webview");
  const webview=webviewEvents.find(event=>event.action==="create");
  check("真实 VS Code Webview create/html/postMessage 进入 Mcode 隔离视图通道",
    webviewCall.kind==="executed"&&webviewCall.result.includes('"delivered":true')&&
    !!webview&&webviewEvents.some(e=>e.action==="html"&&e.html?.includes("Mcode isolated Webview"))&&
    webviewEvents.some(e=>e.action==="message"),webviewEvents);
  if(webview){
    await rejects("其他窗口不能给本窗口 VS Code Webview 发消息",
      ()=>manager!.webviewMessage(52,run.sessionId,webview.handle,{stolen:true}));
    const acknowledged=await manager.webviewMessage(51,run.sessionId,webview.handle,{from:"mcode-ui"});
    check("Mcode Webview 用户消息经 Theia RPC 进入真实扩展",
      acknowledged.kind==="webviewAcknowledged");
    const webReply=await manager.execute(51,run.sessionId,"mcodeSmoke.webviewReply");
    check("真实 VS Code Webview onDidReceiveMessage 收到本会话消息",
      webReply.kind==="executed"&&webReply.result.includes("mcode-ui"),webReply);
    await manager.webviewDispose(51,run.sessionId,webview.handle);
    check("用户关闭 Mcode Webview 会向真实扩展发送 dispose",
      webviewEvents.some(e=>e.action==="dispose"&&e.handle===webview.handle));
    await rejects("关闭的 Webview 标识不能被旧窗口继续发送消息",
      ()=>manager!.webviewMessage(51,run.sessionId,webview.handle,{stale:true}));
  }
  const initialState=await manager.execute(51,run.sessionId,"mcodeSmoke.stateWrite");
  check("真实扩展 globalState/workspaceState 第一次写入并可读回",
    initialState.kind==="executed"&&initialState.result.includes('"globalAfter":1')&&
    initialState.result.includes('"workspaceAfter":1'),initialState);
  check("真实 VSIX editor/context 菜单被识别为 Mcode 原生编辑器菜单贡献",
    manager.list(51).find(x=>x.id===id)?.activeSession?.editorMenus?.some(m=>
      m.commandId==="mcodeSmoke.spawnEcho"&&m.label==="Mcode smoke: spawn echo")===true);
  const initialConfigured=await manager.execute(51,run.sessionId,"mcodeSmoke.spawnEcho");
  check("重启宿主时从 Mcode 配置存储加载用户设置",
    initialConfigured.kind==="executed"&&initialConfigured.result.includes("from-mcode-ui"));
  check("真实 VS Code Provider 注册进入 Mcode 宿主能力目录",
    manager.list(51).find(x=>x.id===id)?.activeSession?.languageProviders?.some(x=>x.kind==="hover"&&x.language==="plaintext")===true&&
    manager.list(51).find(x=>x.id===id)?.activeSession?.languageProviders?.some(x=>x.kind==="completion"&&x.language==="plaintext")===true);
  await manager.editorSync(51,run.sessionId,{
    filePath:path.join(workspace,"f032-roundtrip.txt"),languageId:"plaintext",text:"native-workspace"
  },async()=>false);
  const hover=await manager.languageQuery(51,run.sessionId,"hover",1,3);
  check("真实 Theia vscode.languages Hover Provider 返回 Mcode 编辑器悬停文本",
    hover.kind==="languageResult"&&hover.contents.some(x=>x.includes("Mcode native hover provider")),hover);
  const completion=await manager.languageQuery(51,run.sessionId,"completion",1,3);
  check("真实 Theia vscode.languages Completion Provider 返回原生补全文本",
    completion.kind==="languageResult"&&completion.suggestions.some(x=>x.label==="mcodeNativeCompletion"),completion);
  const fsReply=await manager.execute(51,run.sessionId,"mcodeSmoke.workspaceFs");
  check("真实 VS Code workspace.fs 读写 Mcode 当前项目",
    fsReply.kind==="executed"&&fsReply.result.includes("native-workspace")&&fsReply.result.includes('"names":true')&&fsReply.result.includes('"search":true'),fsReply);
  check("扩展写入的是 Mcode 项目真实文件而非宿主目录",
    readFileSync(path.join(workspace,"f032-roundtrip.txt"),"utf8")==="native-workspace");
  writeFileSync(path.join(workspace,"f033-watch.txt"),"outside-change");
  let watchResult="";
  for(let tries=0;tries<24;tries++){
    await new Promise(resolve=>setTimeout(resolve,70));
    const observed=await manager.execute(51,run.sessionId,"mcodeSmoke.watchEvents");
    if(observed.kind==="executed"){
      watchResult=observed.result;
      if(/"(?:created|changed)":[1-9]/.test(watchResult))break;
    }
  }
  check("Mcode 原生文件监听把外部文件变化真正转给 VS Code createFileSystemWatcher",
    /"(?:created|changed)":[1-9]/.test(watchResult),watchResult);
  const configReply=await manager.execute(51,run.sessionId,"mcodeSmoke.configRoundtrip");
  check("真实 VS Code getConfiguration/update 写入 Mcode 扩展私有配置",
    configReply.kind==="executed"&&configReply.result.includes("mcode-persisted"),JSON.stringify(configReply));
  await rejects("运行中另一窗口不可修改本窗口扩展配置",
    ()=>manager!.configSet(52,id,"mcodeSmoke.greeting","intruder"));
  await manager.configSet(51,id,"mcodeSmoke.greeting","updated-from-mcode-ui");
  const liveConfig=await manager.execute(51,run.sessionId,"mcodeSmoke.spawnEcho");
  check("Mcode 设置页面的更改无需重启即可推送 VS Code 配置事件",
    liveConfig.kind==="executed"&&liveConfig.result.includes("updated-from-mcode-ui"),liveConfig);
  check("配置持久化位于扩展安装数据而非 Mcode 通用设置",
    readFileSync(path.join(store,"installed",id,"storage","preferences.json"),"utf8").includes("updated-from-mcode-ui"));
  const escape=await manager.execute(51,run.sessionId,"mcodeSmoke.fsEscape");
  check("vscode.workspace.fs 禁止通过 .. 访问工作区外文件",
    escape.kind==="executed"&&escape.result==='"blocked"',escape);
  // F030: install a DIFFERENT VSIX while the first real Theia host is active.
  // Distinct Node child processes guarantee cross-extension command isolation
  // until shared-worker semantics are implemented and independently verified.
  const secondManifest=JSON.parse(pkg.toString("utf8")) as Record<string,unknown>;
  secondManifest.name=String(secondManifest.name)+"-second";
  const vsix2=path.join(dir,"second.vsix");
  writeFileSync(vsix2,zip([
    {name:"extension/package.json",bytes:Buffer.from(JSON.stringify(secondManifest))},
    {name:"extension/extension.js",bytes:main},
    {name:"extension/docs/info.txt",bytes:Buffer.from("fixture second")}
  ]));
  const secondInspection=await manager.inspect(51,vsix2);
  if(secondInspection.kind!=="inspected")throw Error("second VSIX inspection failed");
  const secondInstalled=manager.install(51,secondInspection.ticket,true);
  if(secondInstalled.kind!=="installed")throw Error("second VSIX install failed");
  const secondId=secondInstalled.item.id;
  const secondRun=await manager.start(51,secondId);
  if(secondRun.kind!=="started")throw Error("second VSIX start failed");
  check("两个不同 VSIX 可同时启动并保持不同会话",manager.list(51).filter(x=>x.running).length===2&&run.sessionId!==secondRun.sessionId);
  check("Mcode 原生命令面板可同时发现两扩展命令",manager.list(51).filter(x=>x.activeSession?.commands.includes("mcodeSmoke.spawnEcho")).length===2);
  await rejects("一个已启动扩展不能二次启动",()=>manager!.start(51,secondId));
  const firstReply=await manager.execute(51,run.sessionId,"mcodeSmoke.spawnEcho");
  const secondReply=await manager.execute(51,secondRun.sessionId,"mcodeSmoke.spawnEcho");
  check("两个独立 Theia 会话都能执行真实命令",firstReply.kind==="executed"&&secondReply.kind==="executed"&&firstReply.result.includes('"echo":"pong"')&&secondReply.result.includes('"echo":"pong"'));
  await rejects("另一窗口不能停止第二扩展",()=>manager!.stop(52,secondRun.sessionId));
  await rejects("运行中第二扩展不能卸载",()=>manager!.remove(secondId));
  await manager.stop(51,secondRun.sessionId);
  check("停止第二扩展不影响第一扩展",manager.list(51).find(x=>x.id===id)?.activeSession?.sessionId===run.sessionId&&manager.list().filter(x=>x.running).length===1);
  await rejects("停止后的第二扩展旧会话不能继续执行",()=>manager!.execute(51,secondRun.sessionId,"mcodeSmoke.spawnEcho"));
  manager.remove(secondId);
  check("卸载第二扩展后第一扩展仍持续运行",manager.list().length===1&&manager.list()[0].running===true);
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
  const restarted=await manager.start(51,id,undefined,workspace);
  if(restarted.kind!=="started")throw Error("cannot restart to verify persistence");
  const persisted=await manager.execute(51,restarted.sessionId,"mcodeSmoke.stateRead");
  check("扩展重启后恢复真实 globalState/workspaceState，而非初始化空对象",
    persisted.kind==="executed"&&persisted.result.includes('"global":1')&&
    persisted.result.includes('"workspace":1'),persisted);
  await manager.stop(51,restarted.sessionId);
  const otherWorkspace=path.join(dir,"other-mcode-project");
  mkdirSync(otherWorkspace,{recursive:true});
  const scoped=await manager.start(51,id,undefined,otherWorkspace);
  if(scoped.kind!=="started")throw Error("cannot open alternate workspace");
  const different=await manager.execute(51,scoped.sessionId,"mcodeSmoke.stateRead");
  check("切换 Mcode 项目只隔离 workspaceState，globalState 仍保留",
    different.kind==="executed"&&different.result.includes('"global":1')&&
    different.result.includes('"workspace":0'),different);
  await manager.stop(51,scoped.sessionId);
  await rejects("无效工作区启动失败也必须解除启动互斥锁",
    ()=>manager!.start(51,id,undefined,path.join(dir,"workspace-does-not-exist")));
  const afterInvalid=await manager.start(51,id,undefined,workspace);
  check("启动错误后正常扩展仍能再次启动",afterInvalid.kind==="started");
  if(afterInvalid.kind==="started")await manager.stop(51,afterInvalid.sessionId);
  const upgradedManifest=JSON.parse(pkg.toString("utf8")) as Record<string,unknown>;
  upgradedManifest.version="1.1.0";
  const upgradeVsix=path.join(dir,"updated.vsix");
  writeFileSync(upgradeVsix,zip([
    {name:"extension/package.json",bytes:Buffer.from(JSON.stringify(upgradedManifest))},
    {name:"extension/extension.js",bytes:main},
    {name:"extension/docs/info.txt",bytes:Buffer.from("new version")}
  ]));
  const oldId=id,oldConfig=readFileSync(path.join(store,"installed",id,"storage","preferences.json"),"utf8");
  const preflight=await manager.inspect(51,upgradeVsix);
  check("原位升级先预检新的 VSIX、显示旧版与目标版本",
    preflight.kind==="inspected"&&preflight.upgradeFrom==="1.0.0"&&preflight.newVersion==="1.1.0");
  if(preflight.kind!=="inspected")throw Error("upgrade preflight failed");
  check("升级预检不能直接覆盖旧版本",manager.list()[0].version==="1.0.0");
  await rejects("升级许可票据只允许原窗口本人使用",
    ()=>manager!.install(52,preflight.ticket,true));
  const upgradeDone=manager.install(51,preflight.ticket,true);
  check("真正升级保留安装 ID、版本提升且不自动启动",
    upgradeDone.kind==="upgraded"&&upgradeDone.item.id===oldId&&
    manager.list()[0].version==="1.1.0"&&manager.list()[0].running===false);
  check("升级过程保留此前真实扩展配置和 globalState/workspaceState",
    readFileSync(path.join(store,"installed",id,"storage","preferences.json"),"utf8")===oldConfig&&
    existsSync(path.join(store,"installed",id,"storage","global-state.json")));
  await rejects("禁止同版本伪装为升级来反复覆盖扩展",
    ()=>manager!.inspect(51,upgradeVsix));
  const postUpgrade=await manager.start(51,id,undefined,workspace);
  if(postUpgrade.kind!=="started")throw Error("new VSIX failed to start");
  const stateAfterUpgrade=await manager.execute(51,postUpgrade.sessionId,"mcodeSmoke.stateRead");
  check("真实新版 Theia 进程读回旧版扩展状态",
    stateAfterUpgrade.kind==="executed"&&stateAfterUpgrade.result.includes('"global":1')&&
    stateAfterUpgrade.result.includes('"workspace":1'),stateAfterUpgrade);
  await rejects("升级时已运行的扩展禁止替换",
    ()=>manager!.inspect(51,upgradeVsix));
  await manager.stop(51,postUpgrade.sessionId);
  await rejects("旧版本 VSIX 不能降级覆盖已有扩展",
    ()=>manager!.inspect(51,vsix));
  // Simulate power loss immediately after moving the old installation into
  // a recovery backup but before the new stage can be renamed into place.
  const crashBackup=path.join(store,"staging","backup-00000000-0000-4000-8000-000000000001");
  renameSync(path.join(store,"installed",id),crashBackup);
  manager=new TheiaInstalledRegistry(store,theia);
  check("模拟升级中断后启动自动恢复上一个完整安装和用户数据",
    manager.list().length===1&&manager.list()[0].version==="1.1.0"&&
    existsSync(path.join(store,"installed",id,"storage","global-state.json"))&&
    !existsSync(crashBackup));

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
  let deliverEditor:((request:TheiaMonacoEditRequest)=>void)|null=null;
  let editorRequestCount=0;
  const runtimeMessages:TheiaRuntimeMessage[]=[];
  const quickInputs:TheiaQuickInputRequest[]=[];
  const statusEntries:TheiaStatusEntry[]=[];
  const diagnosticEntries:TheiaDiagnosticsEvent[]=[];
  const acknowledgements:Promise<unknown>[]=[];
  const wc=Object.assign(new EventEmitter(),{id:99,mainFrame,isDestroyed:()=>false,
    send:(channel:string,message:TheiaMonacoEditRequest|TheiaRuntimeMessage|TheiaQuickInputRequest|TheiaStatusEntry|TheiaDiagnosticsEvent)=>{
      if(channel===IPC.MODULE_THEIA_EDITOR_APPLY&&message.channel===IPC.MODULE_THEIA_EDITOR_APPLY){
        editorRequestCount++;
        deliverEditor?.(message);
      }else if(channel===IPC.MODULE_THEIA_DIAGNOSTICS&&message.channel===IPC.MODULE_THEIA_DIAGNOSTICS){
        diagnosticEntries.push(message);
      }else if(channel===IPC.MODULE_THEIA_STATUS_ENTRY&&message.channel===IPC.MODULE_THEIA_STATUS_ENTRY){
        statusEntries.push(message);
      }else if(channel===IPC.MODULE_THEIA_QUICK_INPUT&&message.channel===IPC.MODULE_THEIA_QUICK_INPUT){
        quickInputs.push(message);
        acknowledgements.push(invoke!(actor,{op:"quickRespond",sessionId:message.sessionId,
          requestId:message.requestId,choice:message.kind==="input"?"mcode-input":[1]}));
      }else if(channel===IPC.MODULE_THEIA_RUNTIME_MESSAGE&&message.channel===IPC.MODULE_THEIA_RUNTIME_MESSAGE){
        runtimeMessages.push(message);
        if(message.actions.length>0){
          acknowledgements.push(invoke!(actor,{
            op:"messageRespond",sessionId:message.sessionId,requestId:message.requestId,choice:1
          }));
        }
      }
    },
  });
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
  const ipcLive=await invoke(actor,{op:"start",id:ipcAdded.item.id,workspacePath:workspace}) as
    {kind:string;sessionId:string;commands:string[]};
  check("IPC 手动启动真实 Theia 子进程",ipcLive.kind==="started"&&ipcLive.commands.includes("mcodeSmoke.spawnEcho"));
  const diagnosticsResult=await invoke(actor,{op:"execute",sessionId:ipcLive.sessionId,
    commandId:"mcodeSmoke.setDiagnostics"}) as {kind:string;result:string};
  check("真实 VS Code 诊断 collection 发布给 Mcode Monaco 标记通道",
    diagnosticsResult.kind==="executed"&&diagnosticsResult.result==="true"&&
    diagnosticEntries.some(event=>event.markers.some(m=>m.message==="Mcode extension diagnostic"&&m.severity===4)),
    diagnosticsResult);
  await new Promise(resolve=>setTimeout(resolve,80));
  check("真实 VS Code 扩展状态栏条目进入 Mcode native status",
    statusEntries.some(x=>x.text==="Mcode F032"&&x.command==="mcodeSmoke.spawnEcho"));

  const quickResult=await invoke(actor,{op:"execute",sessionId:ipcLive.sessionId,commandId:"mcodeSmoke.quickPick"}) as
    {kind:string;result:string};
  check("真实 Theia showQuickPick 使用 Mcode UI 并返回选中项",
    quickResult.kind==="executed"&&quickResult.result==='"Beta"'&&
    quickInputs.some(x=>x.kind==="pick"&&x.items?.[1]?.label==="Beta"),quickResult);
  const inputResult=await invoke(actor,{op:"execute",sessionId:ipcLive.sessionId,commandId:"mcodeSmoke.inputBox"}) as
    {kind:string;result:string};
  check("真实 Theia showInputBox 使用 Mcode UI 并返回输入文本",
    inputResult.kind==="executed"&&inputResult.result==='"mcode-input"'&&
    quickInputs.some(x=>x.kind==="input"&&x.title==="Enter a name"),inputResult);
  const modalReply=await invoke(actor,{op:"execute",sessionId:ipcLive.sessionId,commandId:"mcodeSmoke.askChoice"}) as
    {kind:string;result:string};
  await Promise.all(acknowledgements);
  check("真实 Theia vscode.window.showInformationMessage 进入原生对话并返回用户选择",
    modalReply.kind==="executed"&&modalReply.result==='"Ignore"'&&
    runtimeMessages.some(msg=>msg.actions.join(",")==="Apply,Ignore"&&msg.modal&&msg.detail==="Mcode native prompt"));
  const toastReply=await invoke(actor,{op:"execute",sessionId:ipcLive.sessionId,commandId:"mcodeSmoke.notifyWarning"}) as
    {kind:string;result:string};
  check("真实 Theia warning 通知到达 Mcode 而非被吞掉",
    toastReply.kind==="executed"&&runtimeMessages.some(msg=>msg.kind==="warning"&&msg.message==="Mcode extension warning"&&msg.actions.length===0));

  // Synthetic Monaco owner exercises the *same renderer adapter* registered by real EditPane.
  // No real user files: the real Theia child calls vscode.window.activeTextEditor.edit,
  // main forwards via its sender-scoped broker, renderer confirms after applying undoable edits.
  let editorText="abcdef and more";
  const editorFile=path.join(dir,"monaco-test.txt");
  const undoMarks:number[]=[];
  const model={
    getValue:()=>editorText,
    getLanguageId:()=>"plaintext",
    isDisposed:()=>false,
  };
  const fakeEditor={
    getModel:()=>model,
    getSelection:()=>({startLineNumber:1,startColumn:2,endLineNumber:1,endColumn:4}),
    getRawOptions:()=>({readOnly:false}),
    pushUndoStop:()=>{undoMarks.push(editorText.length);return true;},
    executeEdits:(_source:string,operations:Array<{range:{startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number};text:string}>)=>{
      for(const {range,text} of operations){
        if(range.startLineNumber!==1||range.endLineNumber!==1)return false;
        editorText=editorText.slice(0,range.startColumn-1)+text+editorText.slice(range.endColumn-1);
      }
      return true;
    },
  };
  const unregisterMonaco=registerTheiaMonacoOwner(()=>({editor:fakeEditor,model,filePath:editorFile} as never));
  const unsubscribe=subscribeTheiaMonacoEdits({
    invoke: input=>invoke(actor,input) as Promise<import("@contracts/ipc/modules.js").TheiaInstalledResult>,
    subscribe:handler=>{deliverEditor=handler;return ()=>{deliverEditor=null;};},
  });
  const editInvoke=(input:import("@contracts/ipc/modules.js").TheiaInstalledInput)=>
    invoke(actor,input) as Promise<import("@contracts/ipc/modules.js").TheiaInstalledResult>;
  const editorResult=await executeTheiaWithMonaco(editInvoke,ipcLive.sessionId,"mcodeSmoke.editActive",["EDITED"]);
  check("真实 Theia TextEditor.edit 经 Electron IPC broker 交给 Monaco owner",editorResult.kind==="executed"&&editorResult.result==="true",editorResult);
  check("编辑使用 Monaco 的 executeEdits 修改真正的模型文本",editorText.startsWith("EDITED")&&editorRequestCount>=1,{editorText,editorRequestCount});
  check("Monaco 撤销组由原生编辑器生成而非直写磁盘",undoMarks.length===2);
  const beforeOverlap=editorText;
  await rejects("Theia 原生拒绝重叠编辑，不能绕过 Monaco",()=>executeTheiaWithMonaco(editInvoke,ipcLive.sessionId,"mcodeSmoke.overlapEdit"));
  check("重叠编辑拒绝后 Monaco 内容未变化",editorText===beforeOverlap);
  check("错误文件不允许修改 Monaco 模型",!applyTheiaMonacoEdit({
    filePath:path.join(dir,"other.txt"),version:1,beforeText:editorText,afterText:"x",edits:[{range:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:1},text:"x",rangeOffset:0,rangeLength:0}],undoStopBefore:true,undoStopAfter:true,
  }));
  unsubscribe();unregisterMonaco();
  const noOwner=await executeTheiaWithMonaco(editInvoke,ipcLive.sessionId,"mcodeSmoke.editActive",["NOPE"]);
  check("真实编辑器卸载后扩展不能修改旧模型",noOwner.kind==="executed"&&noOwner.result==="false"&&editorText===beforeOverlap);

  const ipcRunningList=await invoke(actor,{op:"list"}) as {kind:string;items:Array<{activeSession?:{sessionId:string;commands:string[]}}>} ;
  check("真实 IPC list 返回当前窗口可执行的注册命令",
    ipcRunningList.items[0]?.activeSession?.sessionId===ipcLive.sessionId&&
    ipcRunningList.items[0]?.activeSession?.commands.includes("mcodeSmoke.spawnEcho")===true);
  const ipcOutput=await invoke(actor,{op:"execute",sessionId:ipcLive.sessionId,commandId:"mcodeSmoke.spawnEcho"}) as
    {kind:string;result:string};
  check("IPC 扩展命令结果正常返回",ipcOutput.kind==="executed"&&ipcOutput.result.includes('"echo":"pong"'));
  await invoke(actor,{op:"stop",sessionId:ipcLive.sessionId});
  check("停止扩展会清除该会话发布的所有 Monaco 诊断",
    diagnosticEntries.some(event=>event.sessionId===ipcLive.sessionId&&event.collectionId==="*"&&event.removed));
  check("扩展停止时清空已贡献的 Mcode 状态栏条目",
    statusEntries.some(x=>x.sessionId===ipcLive.sessionId&&x.id==="*"&&x.removed===true));
  await invoke(actor,{op:"remove",id:ipcAdded.item.id});
  check("IPC 卸载后恢复空列表",(await invoke(actor,{op:"list"}) as {items:unknown[]}).items.length===0);
  wc.emit("destroyed");
  await rejects("销毁窗口后旧 IPC sender 不可重新安装",()=>invoke(actor,{op:"inspect",path:vsix}));
}finally{
  if(manager)await manager.disposeAll();
  rmSync(dir,{recursive:true,force:true});
}
console.log("NOT-COVERED: Electron U1 actual Monaco window/native message dialog, packaged Theia runtime, continuous document delta, status bar/quick pick/webviews/debugger, shared host, runtime sandbox, auto-start intentionally disabled");
console.log("theia-installed-smoke: "+pass+"/"+(pass+fail)+" 通过");
process.exitCode=fail?1:0;
