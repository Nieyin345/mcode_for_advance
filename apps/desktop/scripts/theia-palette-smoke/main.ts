/** F028: pure native palette adapter test; no Electron, no user data. */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { collectTheiaPaletteCommands } from "../../src/renderer/lib/theiaCommandBridge.js";
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
  return {kind:"executed",result:"pong"};
};
const notify=(msg:{kind:"info"|"error";title:string;body?:string})=>{messages.push(msg);};
const result=collectTheiaPaletteCommands([base],invoke,notify);
check("运行中真实扩展的两个注册命令进入 Mcode 原生命令列表",result.length===2,result.length);
check("Theia 命令与 Mcode command palette 共用 CommandDef 结构",result[0]?.group==="view"&&result[0]?.label.includes("demo.extension"));
check("同时能按扩展与命令名搜索",result[0]?.keywords?.includes("demo.extension")===true&&result[0]?.keywords?.includes("demo.run")===true);
await result[0]!.perform({} as never);
check("原生面板执行走安装后相同的 IPC execute 通道",calls.length===1&&calls[0]?.op==="execute"&&calls[0].commandId==="demo.run");
check("成功结果使用 Mcode 现有反馈通道",messages.length===1&&messages[0]?.kind==="info"&&messages[0]?.body==="pong");
shouldReject=true;
await result[0]!.perform({} as never);
check("宿主停止后旧面板命令失败被捕获且报告",messages.at(-1)?.kind==="error"&&messages.at(-1)?.body?.includes("session has stopped")===true);
check("没有多执行或未注册命令被制造",calls.length===2);
const skip=(patch:Partial<TheiaInstalledEntry>):TheiaInstalledEntry=>({...base,...patch});
check("禁用扩展不会进入搜索",collectTheiaPaletteCommands([skip({enabled:false})],invoke,notify).length===0);
check("损坏扩展不会进入搜索",collectTheiaPaletteCommands([skip({corrupted:true})],invoke,notify).length===0);
check("停止扩展不会进入搜索",collectTheiaPaletteCommands([skip({running:false})],invoke,notify).length===0);
check("另一窗口无 owner session 无法加载命令",collectTheiaPaletteCommands([skip({activeSession:undefined})],invoke,notify).length===0);
check("重复命令不会污染命令面板",collectTheiaPaletteCommands([skip({activeSession:{...base.activeSession!,commands:["demo.run","demo.run"]}})],invoke,notify).length===1);
check("非法过长的命令 ID 不会出现在面板",collectTheiaPaletteCommands([skip({activeSession:{...base.activeSession!,commands:["x".repeat(300)]}})],invoke,notify).length===0);
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
console.log("theia-palette-smoke: "+(count-failed)+"/"+count+" 通过");
process.exitCode=failed?1:0;
