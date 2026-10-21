/**
 * T51 E1 — app_guide extensions, preflight validator, consent card and 3 templates.
 * Only ephemeral workspace data; installer persistence is captured in memory.
 * Windows test opts into JS-only egress guard in THIS PROCESS ONLY.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleHost } from "@main/modules/ModuleHost.js";
import { fileCapabilities, resolveModuleResource } from "@main/modules/fileCapabilities.js";
import { verifyPermissionedProgram, configureJsOnlyEgressConsentReader } from "@main/modules/permissionedProcessRunner.js";
import { buildGuideDetail, type GuideSources } from "@main/appControl/guide.js";
import { validateExtension } from "@main/appControl/extensionValidate.js";
import { invokeAppTool, appMcpTools, extensionInstallApprovalSummary, APP_READONLY_TOOLS, gateAppAction } from "@main/appControl/tools.js";
import { policyFor } from "@main/appControl/policy.js";
import { isAppToolName } from "@main/appControl/engineTools.js";
import type { ProviderContext } from "@contracts/provider";

configureJsOnlyEgressConsentReader(() => true);
let total=0, failed=0;
function check(name:string,good:boolean,detail?:unknown) {
  total++;if(!good)failed++;
  console.log((good?"  ok   ":"  FAIL ")+name+(good?"":" "+JSON.stringify(detail)));
}
function get(name:string) {
  return JSON.parse(readFileSync(join(process.cwd(),"resources","presets","extensions",name+".json"),"utf8"));
}
const manifest = get("line-counter");
const sources = {catalog:[],domainLabels:{},published:[],modules:null,policy:()=>({level:"read"})} as unknown as GuideSources;
const guide = buildGuideDetail("extensions", sources);
const overviewGuide=await invokeAppTool("app_guide",{},"t51",{} as ProviderContext);
check("指南主题在无扩展安装时也存在",overviewGuide.content.some(b=>b.type==="text" && b.text?.includes("- extensions:")));
check("指南 a-e 五项完整",["## a)","## b)","## c)","## d)","## e)"].every(p=>guide?.body.includes(p)));
check("指南列真实权限和模板",Boolean(guide?.body.includes("files.read") && guide.body.includes("module.count") && guide.body.includes("ModuleResult")));
check("指南解释工厂及运行时差异",Boolean(guide?.body.includes("exports.count") && guide.body.includes("program.source")));
const liveGuide = await invokeAppTool("app_guide",{topic:"extensions"},"t51",{} as ProviderContext);
check("app_guide 统一工具入口返回 extensions 五项",liveGuide.content.some(b=>b.type==="text" && ["## a)","## b)","## c)","## d)","## e)"].every(s=>b.text?.includes(s))));
// The production module service owns the egress consent reader; re-enable only
// the headless test-process downgrade after guideFor has loaded that service.
configureJsOnlyEgressConsentReader(() => true);

const fakeVerify = async () => ({ok:true as const});
check("合法 manifest 结构通过", (await validateExtension(manifest,undefined,fakeVerify)).installable);
const unknownPerm = await validateExtension({...manifest,permissions:["files.read","unsafe.exploit"]},undefined,fakeVerify);
check("未知权限明确点名",!unknownPerm.installable && unknownPerm.issues.some(p=>p.includes("权限 unsafe.exploit 不存在")),unknownPerm);
const wrongJs = await validateExtension(manifest,"({ count: async ( => ({})) })",fakeVerify);
check("语法错返回求值失败",!wrongJs.installable && wrongJs.issues.some(p=>p.includes("求值失败")),wrongJs);
const undeclared = await validateExtension({...manifest,program:{source:'({count: async () => { await mcode.api.call("file.writeFile", {}); return { lines: 1 }; }})'}},undefined,fakeVerify);
check("静态提醒未声明权限",undeclared.warnings.some(x=>x.includes("files.write")),undeclared);
check("贡献槽位非法拦截",!(await validateExtension({...manifest,contributions:[{...manifest.contributions[0],slot:"wrong.slot"}]},undefined,fakeVerify)).installable);
check("扩展校验器是 MCP 可发现只读工具",appMcpTools().some(t=>t.name==="extension_validate")&&isAppToolName("extension_validate")&&APP_READONLY_TOOLS.has("extension_validate"));
const tool = await invokeAppTool("extension_validate",{manifest:{...manifest,permissions:["files.read","unsafe.exploit"]}},"test",{} as ProviderContext);
check("extension_validate 在统一入口返回不可安装及权限错误",tool.content.some(b=>b.type==="text" && b.text?.includes("不可安装") && b.text?.includes("unsafe.exploit")));
const summary=extensionInstallApprovalSummary({manifest:{...manifest,program:{source:'({count: async () => mcode.api.call("file.readFile", {})})'}}});
check("审批说明列出权限与静态 API",summary.includes("files.read")&&summary.includes("file.readFile")&&summary.includes("取消"));
let approvalDescription = "";
const denied = await gateAppAction({requestApproval:async(req)=>{approvalDescription=req.description ?? "";return {allow:false};}} as ProviderContext,"danger","modules.install",{manifest},"安装扩展"+summary);
const approvalSource = readFileSync(join(process.cwd(),"src","main","appControl","tools.ts"),"utf8");
check("安装仍属 danger 且审批说明在真实 dispatch 接入",policyFor("modules.install").level==="danger" && denied!==null && approvalDescription.includes("files.read") && approvalSource.includes("extensionInstallApprovalSummary(args.input)"));

const temp = await mkdtemp(join(tmpdir(),"mcode-t51-"));
let grant: string | null = null, persisted=0;
try {
  const path=join(temp,"test.md");
  await writeFile(path,"one\ntwo\nthree","utf8");
  const called: Array<{method:string;input:unknown;moduleId:string}> = [];
  const host=new ModuleHost({
    authorize:async(resource)=>{await resolveModuleResource(resource,p=>p===temp);},
    resolveResource:resource=>resolveModuleResource(resource,p=>p===temp),
    verifyProgram:(source,caps,timeout)=>verifyPermissionedProgram(source,caps,timeout??10000),
    persist:async()=>{persisted++;},
    invokeAppCall:async(moduleId,method,input)=>{
      called.push({moduleId,method,input});
      if(method==="project.list") return {projects:[{id:"test-project",path:temp}]};
      if(method==="claude.startSession") return {session:{id:"summary-session"}};
      if(method==="claude.sendTurn") return {session:{id:"summary-session"}};
      throw Error("非预期 RPC: "+method);
    },
    readModulePermissions:()=>grant,
    persistModulePermissions:async(text)=>{grant=text;},
  });
  for(const cap of fileCapabilities(p=>p===temp))host.register(cap);
  for(const name of ["hello-world","line-counter","ai-summarizer"]) {
    const data=get(name);
    const diagnosis=await validateExtension(data);
    check(name+" 经真实隔离核验可安装",diagnosis.installable,diagnosis);
    if(!diagnosis.installable)continue;
    await host.install(data,data.permissions);
    const reply=await host.invoke({moduleId:data.id,contributionId:data.contributions[0].id,resource:{projectPath:temp,path},requestId:"run-"+name});
    const result=reply.type==="result"?reply.value:{};
    check(name+" 安装后子进程调用返回 ModuleResult",reply.type==="result",reply);
    if(name==="hello-world")check("hello-world 返回文件名",result.filename==="test.md",result);
    if(name==="line-counter")check("line-counter 返回行数",result.lines===3,result);
    if(name==="ai-summarizer")check("ai-summarizer 经宿主 RPC 在新会话发送摘要请求",result.sent===true && result.sessionId==="summary-session" && called.map(c=>c.method).join(",")==="project.list,claude.startSession,claude.sendTurn" && called.every(c=>c.moduleId===data.id) && JSON.stringify(called[2]?.input).includes("three"),{result,called});
  }
  check("三个模板都实际通过宿主安装持久化入口",persisted===3,persisted);
} finally {
  await rm(temp,{recursive:true,force:true});
  configureJsOnlyEgressConsentReader(null);
}
console.log("extension-authoring-smoke:"+String(total-failed)+"/"+total+" 通过");
if(failed)process.exitCode=1;
