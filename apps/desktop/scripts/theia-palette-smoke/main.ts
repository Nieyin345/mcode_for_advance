/** F028: pure native palette adapter test; no Electron, no user data. */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { collectTheiaPaletteCommands } from "../../src/renderer/lib/theiaCommandBridge.js";
import { TheiaEditorApplyBroker } from "../../src/main/modules/theiaHost/editorApplyBroker.js";
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
console.log("theia-palette-smoke: "+(count-failed)+"/"+count+" 通过");
process.exitCode=failed?1:0;
