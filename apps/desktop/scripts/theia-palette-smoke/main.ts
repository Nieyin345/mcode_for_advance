/** F028: pure native palette adapter test; no Electron, no user data. */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { collectTheiaPaletteCommands } from "../../src/renderer/lib/theiaCommandBridge.js";
import { TheiaEditorApplyBroker } from "../../src/main/modules/theiaHost/editorApplyBroker.js";
import { TheiaRuntimeMessageBroker } from "../../src/main/modules/theiaHost/runtimeMessageBroker.js";
import { TheiaQuickInputBroker } from "../../src/main/modules/theiaHost/quickInputBroker.js";
import {formattingEdits,documentSymbols,signatureHelp} from "../../src/main/modules/theiaHost/languageResults.js";
import type { TheiaInstalledEntry, TheiaInstalledInput, TheiaInstalledResult } from "@contracts/ipc/modules.js";

let count=0,failed=0;
function check(label:string,condition:boolean,extra?:unknown):void{
  count++;
  if(condition) console.log("  ok "+label);
  else{failed++;console.error("  FAIL "+label+" "+String(extra??""));}
}
const base: TheiaInstalledEntry={id:"9ffdd721-2416-4f1c-872d-273f0a1bdf2d",extensionId:"demo.extension",
  version:"1.0.0",enabled:true,installedAt:1,running:true,integrity:"not-checked",
  activeSession:{sessionId:"e2c390b4-a2f2-45e3-b160-764ad24c8e82",commands:["demo.run","demo.stop"]}};
const calls:TheiaInstalledInput[]=[];
const messages:Array<{kind:"info"|"error";title:string;body?:string}>=[];
let shouldReject=false;
const invoke=async(input:TheiaInstalledInput):Promise<TheiaInstalledResult>=>{
  calls.push(input);
  if(shouldReject)throw Error("session has stopped");
  if(input.op==="editorSync")return {kind:"editorSynced",active:input.editor!==null};
  return {kind:"executed",result:"pong"};
};
const notify=(msg:{kind:"info"|"error";title:string;body?:string})=>{messages.push(msg);};
const result=collectTheiaPaletteCommands([base],invoke,notify);
check("运行中真实扩展的两个注册命令进入 Mcode 原生命令列表",result.length===2,result.length);
check("Theia 命令与 Mcode command palette 共用 CommandDef 结构",result[0]?.group==="view"&&result[0]?.label.includes("demo.extension"));
check("同时能按扩展与命令名搜索",result[0]?.keywords?.includes("demo.extension")===true&&result[0]?.keywords?.includes("demo.run")===true);
await result[0]!.perform({} as never);
check("先同步 Mcode 真正的编辑器状态再执行扩展命令",calls.length===2&&calls[0]?.op==="editorSync"&&calls[1]?.op==="execute"&&calls[1].commandId==="demo.run");
check("成功结果使用 Mcode 现有反馈通道",messages.length===1&&messages[0]?.kind==="info"&&messages[0]?.body==="pong");
shouldReject=true;
await result[0]!.perform({} as never);
check("宿主停止后旧面板命令失败被捕获且报告",messages.at(-1)?.kind==="error"&&messages.at(-1)?.body?.includes("session has stopped")===true);
check("宿主拒绝同步后不会再执行旧命令",calls.length===3&&calls[2]?.op==="editorSync");
const skip=(patch:Partial<TheiaInstalledEntry>):TheiaInstalledEntry=>({...base,...patch});
check("禁用扩展不会进入搜索",collectTheiaPaletteCommands([skip({enabled:false})],invoke,notify).length===0);
check("损坏扩展不会进入搜索",collectTheiaPaletteCommands([skip({corrupted:true})],invoke,notify).length===0);
check("停止扩展不会进入搜索",collectTheiaPaletteCommands([skip({running:false})],invoke,notify).length===0);
check("另一窗口无 owner session 无法加载命令",collectTheiaPaletteCommands([skip({activeSession:undefined})],invoke,notify).length===0);
check("重复命令不会污染命令面板",collectTheiaPaletteCommands([skip({activeSession:{...base.activeSession!,commands:["demo.run","demo.run"]}})],invoke,notify).length===1);
check("非法过长的命令 ID 不会出现在面板",collectTheiaPaletteCommands([skip({activeSession:{...base.activeSession!,commands:["x".repeat(300)]}})],invoke,notify).length===0);
// Host callback must never be satisfied by another sender/session or a late response.
const broker=new TheiaEditorApplyBroker(30);
const txn={filePath:"C:/sandbox/example.txt",version:1,beforeText:"a",afterText:"b",
  edits:[{range:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:2},text:"b",rangeOffset:0,rangeLength:1}],
  undoStopBefore:true,undoStopAfter:true};
let requestId="";
const first=broker.request(101,base.activeSession!.sessionId,txn,message=>{requestId=message.requestId;});
check("发出编辑请求时事务进入有界待确认表",broker.size===1);
check("另一个窗口无法确认编辑事务",!broker.acknowledge(102,base.activeSession!.sessionId,requestId,true));
check("其他会话无法确认编辑事务",!broker.acknowledge(101,"00000000-0000-4000-a000-000000000000",requestId,true));
check("原窗口可确认自己拥有的事务",broker.acknowledge(101,base.activeSession!.sessionId,requestId,true)&&await first===true);
check("重复确认不能重放已执行编辑",!broker.acknowledge(101,base.activeSession!.sessionId,requestId,true));
const eventLoopKeepalive=setTimeout(()=>{},150); // broker timer intentionally unref() in production
const timed=await broker.request(101,base.activeSession!.sessionId,txn,()=>{});
clearTimeout(eventLoopKeepalive);
check("未挂载 Mcode 编辑器时超时默认拒绝",timed===false&&broker.size===0);
const pending=broker.request(101,base.activeSession!.sessionId,txn,()=>{});
broker.cancelSender(101);
check("窗口销毁立即拒绝仍待编辑的事务",await pending===false&&broker.size===0);

const messageBroker=new TheiaRuntimeMessageBroker(30);
let plainType="";
const noActions=await messageBroker.request(101,base.activeSession!.sessionId,base.extensionId,{
  type:1,message:"Watch for issues",actions:[],modal:false
},message=>{plainType=message.kind;});
check("非交互式 VS Code 警告进入 Mcode 提醒且不挂起扩展",plainType==="warning"&&noActions===undefined&&messageBroker.pendingCount===0);
let msgId="";
const pendingChoice=messageBroker.request(101,base.activeSession!.sessionId,base.extensionId,{
  type:2,message:"Choose",modal:true,detail:"Prompt",actions:["Apply","Ignore"]
},message=>{msgId=message.requestId;});
check("交互式扩展消息进入有界请求表",messageBroker.pendingCount===1);
check("另一窗口不可伪造 VS Code 通知选项",!messageBroker.respond(102,base.activeSession!.sessionId,msgId,0));
check("另一会话不可伪造 VS Code 通知选项",!messageBroker.respond(101,"00000000-0000-4000-a000-000000000000",msgId,0));
check("越界选项索引不能回给扩展",!messageBroker.respond(101,base.activeSession!.sessionId,msgId,2));
check("正确桌面窗口选项能准确回到扩展",messageBroker.respond(101,base.activeSession!.sessionId,msgId,1)&&await pendingChoice===1);
check("扩展消息的重复响应不可重放",!messageBroker.respond(101,base.activeSession!.sessionId,msgId,1));
const messageKeepalive=setTimeout(()=>{},150);
const timedMessage=await messageBroker.request(101,base.activeSession!.sessionId,base.extensionId,{
  type:0,message:"Timed out",modal:true,actions:["Proceed"]
},()=>{});
clearTimeout(messageKeepalive);
check("无人响应的扩展弹窗超时返回取消",timedMessage===undefined&&messageBroker.pendingCount===0);
const pendingDismiss=messageBroker.request(101,base.activeSession!.sessionId,base.extensionId,{
  type:2,message:"Pending",actions:["Yes"]
},()=>{});
messageBroker.cancelSender(101);
check("桌面窗口关闭时通知事务立即取消",await pendingDismiss===undefined&&messageBroker.pendingCount===0);
const quickBroker=new TheiaQuickInputBroker(40);
let quickId="";
const quickPending=quickBroker.request(101,base.activeSession!.sessionId,base.extensionId,{
  kind:"pick",canPickMany:false,items:[{label:"One"},{label:"Two"}]
},message=>{quickId=message.requestId;});
check("VS Code Quick Pick 请求通过可取消的 Mcode owner broker",quickBroker.size===1);
check("其他窗口无法代选扩展 Quick Pick",!quickBroker.respond(102,base.activeSession!.sessionId,quickId,[0]));
check("无效 Quick Pick 索引被拒绝",!quickBroker.respond(101,base.activeSession!.sessionId,quickId,[2]));
check("非多选 Quick Pick 不接受伪造多项结果",!quickBroker.respond(101,base.activeSession!.sessionId,quickId,[0,1]));
check("正确用户选择返回指定索引",
  quickBroker.respond(101,base.activeSession!.sessionId,quickId,[1])&&
  JSON.stringify(await quickPending)==="[1]");
check("Quick Pick 旧请求不能重复使用",!quickBroker.respond(101,base.activeSession!.sessionId,quickId,[1]));
const quickDismiss=quickBroker.request(101,base.activeSession!.sessionId,base.extensionId,{
  kind:"input",placeholder:"Name"
},()=>{});
quickBroker.cancelSender(101);
check("关闭窗口清除挂起的 VS Code 输入框",await quickDismiss===undefined&&quickBroker.size===0);
// The real desktop renderer supplies window.api. This smoke injects only a
// harmless native-API placeholder, never a browser or Electron instance.
Object.assign(globalThis,{window:{api:{}}});
const {receiveTheiaDiagnostics,registerTheiaDiagnosticMarkers}=
  await import("../../src/renderer/lib/theiaDiagnostics.js");
const fakeModel={isDisposed:()=>false};
const markerWrites:Array<{owner:string;count:number;message:string|undefined}>=[];
const mockMonaco={editor:{setModelMarkers:(_model:unknown,owner:string,markers:Array<{message:string}>)=>{
  markerWrites.push({owner,count:markers.length,message:markers[0]?.message});
}}};
const mockEditor={getModel:()=>fakeModel,onDidChangeModel:()=>({dispose:()=>{}})};
const removeMarkers=registerTheiaDiagnosticMarkers(mockEditor as never,mockMonaco as never,()=> "C:/sandbox/note.ts");
receiveTheiaDiagnostics({channel:"modules:theiaDiagnostics",sessionId:base.activeSession!.sessionId,
  collectionId:"diagnostics",resource:"file:///C:/sandbox/note.ts",
  markers:[{severity:4,startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:3,
    message:"native warning"}]});
check("扩展诊断发布到真正 Monaco marker owner",
  markerWrites.some(x=>x.owner.includes(base.activeSession!.sessionId)&&x.message==="native warning"));
receiveTheiaDiagnostics({channel:"modules:theiaDiagnostics",sessionId:base.activeSession!.sessionId,
  collectionId:"*",resource:"",markers:[],removed:true});
check("扩展停止后的诊断事件清空旧 Monaco 警告",
  markerWrites.at(-1)?.count===0);
removeMarkers();
check("扩展格式化只接受有效坐标和受限 TextEdit，不直接触及文件内容",
  formattingEdits([
    {range:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:4},text:"abc"},
    {range:{startLineNumber:3,startColumn:6,endLineNumber:1,endColumn:1},text:"invalid"},
    {range:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:2},text:"x".repeat(9000)}
  ]).length===1);
check("重叠的 VS Code 格式化编辑建议不会交给 Monaco 破坏撤销事务",
  formattingEdits([
    {range:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:5},text:"first"},
    {range:{startLineNumber:1,startColumn:2,endLineNumber:1,endColumn:6},text:"overlap"},
    {range:{startLineNumber:2,startColumn:1,endLineNumber:2,endColumn:2},text:"other"},
  ]).length===2);
check("扩展大纲必须包含有效 selectionRange，排除逆序范围",
  documentSymbols([
    {name:"valid",kind:12,range:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:8},
      selectionRange:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:4},children:[]},
    {name:"invalid",kind:12,range:{startLineNumber:9,startColumn:1,endLineNumber:1,endColumn:2}}
  ]).map(x=>x.name).join(",")==="valid");
check("不可信扩展签名结果裁剪无效活动索引和超量参数",
  signatureHelp({activeSignature:99,activeParameter:99,signatures:[
    {label:"f(arg)",parameters:[{label:[2,5],documentation:{value:"parameter"}}]}
  ]})?.signatures[0]?.parameters[0]?.label==="arg"&&
  signatureHelp({activeSignature:99,activeParameter:99,signatures:[
    {label:"f(arg)",parameters:[{label:"arg"}]}
  ]})?.activeSignature===0);
const codeRoot=process.env.MCODE_SMOKE_REPO_ROOT;
if(!codeRoot)throw Error("MCODE_SMOKE_REPO_ROOT missing");
const palette=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/components/layout/CommandPalette.tsx"),"utf8");
check("产品命令面板实际调用共享 Theia adapter",palette.includes("collectTheiaPaletteCommands(")&&palette.includes("...extensions,...theia"));
check("仅面板打开时查询，关闭取消迟到数据",palette.includes("if (!open) {setTheiaActive([]);return;}")&&palette.includes("return () => {current=false;};"));
check("不存在每次按键都全盘扫描已安装扩展的入口",!palette.includes('api.modules.theiaInstalled({op:"inspect"'));
const installSurface=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/components/modules/VsixInstallSection.tsx"),"utf8");
check("产品 VSIX 默认入口是持久化 Theia 而非并列三个运行器",
  installSurface.includes("<TheiaInstalledPanel />")&&installSurface.includes("<details")&&
  !installSurface.includes('data-testid="theia-vsix-preview"'));
check("旧 L1 兼容入口仍有真实限制告知和确认按钮",
  installSurface.includes('data-testid="module-vsix-limit-notice"')&&installSurface.includes("modules.installVsix"));
const lifecycleUi=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/components/modules/TheiaInstalledPanel.tsx"),"utf8");
check("切换离开扩展管理页不会调用 stop，已启动命令留在 Mcode",lifecycleUi.includes("离开这个页面不会停止")&&
  !lifecycleUi.includes('if(sessionId)void api.modules.theiaInstalled({op:"stop"'));
check("已启动多个扩展按各自会话渲染和停止",lifecycleUi.includes("item.activeSession")&&
  lifecycleUi.includes('sessionId:item.activeSession')===false&&lifecycleUi.includes('sessionId=item.activeSession?.sessionId'));
check("管理页面不进行自动启动和全局轮询",!lifecycleUi.includes('setInterval(')&&
  !lifecycleUi.includes('void api.modules.theiaInstalled({op:"start"'));
const runtimeHost=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/components/modules/TheiaRuntimeMessageHost.tsx"),"utf8");
const app=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/App.tsx"),"utf8");
check("扩展消息订阅挂在 Mcode 根 UI，而非随设置页卸载",app.includes("<TheiaRuntimeMessageHost />")&&runtimeHost.includes("api.on.theiaRuntimeMessage("));
check("普通扩展通知走 Mcode 全局 toast store",runtimeHost.includes("useToastStore.getState().push("));
check("扩展操作按钮由用户点击触发并通过正式 IPC 回执",runtimeHost.includes('op:"messageRespond"')&&runtimeHost.includes("onClick={()=>reply(msg,index)}"));
const nativeLanguage=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/lib/theiaLanguageProviders.ts"),"utf8");
const realLanguageEditor=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/components/ide/FileEditor.tsx"),"utf8");
check("真实 VS Code Hover/Completion Provider 映射到同一 Mcode Monaco",
  nativeLanguage.includes("monaco.languages.registerHoverProvider(")&&
  nativeLanguage.includes("monaco.languages.registerCompletionItemProvider(")&&
  realLanguageEditor.includes("registerTheiaLanguageProviders(editor_,monaco)"));
check("语言服务基于 Monaco 当前文本增量失效，不每次悬停都重传整个文档",
  nativeLanguage.includes("model.getVersionId()")&&nativeLanguage.includes("recent.get(sessionId)===revision")&&
  nativeLanguage.includes('op:"editorSync"')&&nativeLanguage.includes('op:"languageQuery"'));
check("语言 Provider 由原生贡献事件注册及释放，没有后台轮询",
  nativeLanguage.includes("api.on.theiaContributionChanged(")&&!nativeLanguage.includes("setInterval(")&&
  nativeLanguage.includes("for(const item of registered)item.dispose()"));
check("Mcode Monaco 注册真实扩展定义、引用、实现和类型定义四种导航 Provider",
  nativeLanguage.includes("registerDefinitionProvider(")&&nativeLanguage.includes("registerReferenceProvider(")&&
  nativeLanguage.includes("registerImplementationProvider(")&&nativeLanguage.includes("registerTypeDefinitionProvider("));
check("跨文件定义通过 Mcode 原生 openFileInIde 导航，同文件位置复用现有 Monaco model",
  nativeLanguage.includes("gotoLocation(nativePath(first.uri)")&&nativeLanguage.includes("?model.uri:"));
check("引用查询尊重 includeDeclaration 并且检查取消/模型版本",
  nativeLanguage.includes("context.includeDeclaration")&&nativeLanguage.includes("token.isCancellationRequested")&&
  nativeLanguage.includes("model.getVersionId()!==version"));
const languageHost=readFileSync(path.join(codeRoot,"apps/desktop/src/main/modules/theiaHost/host.ts"),"utf8");
check("Theia 主 RPC 记录四类语言导航贡献并转发到真实扩展 Provider",
  languageHost.includes("$registerDefinitionProvider:")&&languageHost.includes("$registerReferenceProvider:")&&
  languageHost.includes("$registerImplementationProvider:")&&languageHost.includes("$registerTypeDefinitionProvider:")&&
  languageHost.includes("ext.$provideDefinition(")&&languageHost.includes("ext.$provideReferences(")&&
  languageHost.includes("ext.$provideImplementation(")&&languageHost.includes("ext.$provideTypeDefinition("));
check("语言位置跨 IPC 前拒绝非 file URI、越界坐标和反向范围",
  languageHost.includes("function languageLocation(value: unknown)")&&
  languageHost.includes("input.scheme !== \"file\"")&&languageHost.includes("results.locations.length<100"));
check("三类新增语言能力使用 Mcode 原生 Monaco 符号/格式化/签名入口",
  nativeLanguage.includes("registerDocumentSymbolProvider(")&&
  nativeLanguage.includes("registerDocumentFormattingEditProvider(")&&
  nativeLanguage.includes("registerSignatureHelpProvider("));
check("格式化只返回 Monaco Edits 并保留模型版本拒绝迟到结果",
  nativeLanguage.includes('"formatting",model,token')&&
  nativeLanguage.includes("model.getVersionId()!==version"));
const nativeMenus=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/lib/theiaEditorMenus.ts"),"utf8");
const realEditor=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/components/ide/FileEditor.tsx"),"utf8");
check("VS Code editor/context 菜单实际进入 Monaco 原生菜单而非独立菜单 UI",
  realEditor.includes("registerTheiaEditorMenus(editor_)")&&nativeMenus.includes("instance.addAction({")&&
  nativeMenus.includes("contextMenuGroupId:"));
check("菜单更新由真实扩展贡献事件触发，不通过后台轮询",
  nativeMenus.includes("api.on.theiaContributionChanged(")&&!nativeMenus.includes("setInterval("));
const nativeInput=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/components/modules/TheiaQuickInputHost.tsx"),"utf8");
const nativeStatus=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/components/modules/TheiaStatusStrip.tsx"),"utf8");
check("Quick Pick 与输入框复用 Mcode 原生焦点管理及同一 IPC 回执",
  nativeInput.includes("useFocusTrap(")&&nativeInput.includes('op:"quickRespond"'));
check("状态栏原生呈现并可执行注册的扩展命令",
  nativeStatus.includes("api.on.theiaStatusEntry(")&&nativeStatus.includes("executeTheiaWithMonaco("));
const nativeWebview=readFileSync(path.join(codeRoot,
  "apps/desktop/src/renderer/components/modules/TheiaWebviewHost.tsx"),"utf8");
const nativeApp=readFileSync(path.join(codeRoot,"apps/desktop/src/renderer/App.tsx"),"utf8");
check("Webview 被挂载在 Mcode 根布局的受限 iframe 而不是注入宿主 DOM",
  nativeApp.includes("<TheiaWebviewHost />")&&nativeWebview.includes('sandbox="allow-scripts"')&&
  !nativeWebview.includes('sandbox="allow-scripts allow-same-origin"')&&
  nativeWebview.includes("srcDoc={documentFor(panel.html)}"));
check("Webview 限制网络资源，拒绝原生 Electron / Node 权限",
  nativeWebview.includes("default-src 'none'")&&nativeWebview.includes("connect-src 'none'")&&
  nativeWebview.includes("frame-src 'none'")&&!nativeWebview.includes("nodeIntegration"));
check("Webview 消息必须来源于当前拥有的 iframe 并通过受控 IPC 发送",
  nativeWebview.includes("?.contentWindow===event.source")&&nativeWebview.includes('op:"webviewMessage"'));
check("Webview 延迟到达消息有挂载后与加载后再次派发的处理路径",
  nativeWebview.includes("useEffect(()=>{\n    for(const panel of panels)")&&
  nativeWebview.includes("if(!ready.current.has(key)||!panel.pending.length)continue")&&
  nativeWebview.includes("setPanels(current=>[...current])"));
check("同一 Mcode 原生 PTY 通过既有终端服务注册，而非加载并列 node-pty",
  readFileSync(path.join(codeRoot,"apps/desktop/src/main/ipc/terminal.ts"),"utf8")
    .includes("registerTheiaNativePtyOps(")&&
  !readFileSync(path.join(codeRoot,"apps/desktop/src/main/modules/theiaHost/mcodeTerminalDriver.ts"),"utf8")
    .includes('import("node-pty")'));
console.log("theia-palette-smoke: "+(count-failed)+"/"+count+" 通过");
process.exitCode=failed?1:0;
