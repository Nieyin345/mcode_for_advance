/** ARC-006 Gate E: unapproved executable cannot be installed or given network capability. No real user data. */
import { createHash } from "node:crypto";
import { mkdtemp,mkdir,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineNodeRegistry,stableDirectoryHash } from "@main/workflowEngines/engineNodeRegistry.js";
let n=0,failed=0;function check(s:string,c:boolean,detail?:unknown){n++;console.log((c?"  ok   ":"  FAIL ")+s+(c?"":" "+JSON.stringify(detail)));if(!c)failed++;}
const root=await mkdtemp(join(tmpdir(),"mcode-no-unapproved-node-"));
try{
  const bytes=Buffer.from("unapproved executable bytes");
  const bHash=createHash("sha256").update(bytes).digest("hex");
  const request={name:"node-red-contrib-no-consent",version:"1.0.0",source:"fixture",license:"MIT",capabilities:["network"],approvedByUser:false,sha256:bHash};
  const a=new EngineNodeRegistry({dataDir:join(root,"record"),engineId:"node-red"});
  const record=await a.recordInstall(request);
  check("未经用户批准不能登记 installed 状态",!record.ok,record);
  check("被拒的登记不得赋予网络能力",!(await a.allowsNetwork(request.name)));
  check("被拒的登记不得写入清单",(await a.readState()).kind==="absent");
  // 兼容历史旧库：旧版本可能已将 approvedByUser:false 记成 installed，读侧也须拒权。
  await mkdir(join(root,"legacy"),{recursive:true});
  const legacy=new EngineNodeRegistry({dataDir:join(root,"legacy"),engineId:"node-red"});
  await writeFile(join(root,"legacy","engine-nodes.json"),JSON.stringify({schema:"mcode.workflow-engine.nodes/v1",engineId:"node-red",entries:[{name:request.name,version:request.version,source:request.source,sha256:request.sha256,license:request.license,capabilities:["network"],approvedByUser:false,installedAt:1,state:"installed"}]}));
  check("旧存档即使 installed=true 也不能给未经批准包放网络能力",!(await legacy.allowsNetwork(request.name)));
  const b=new EngineNodeRegistry({dataDir:join(root,"bytes"),engineId:"node-red"});
  const byBytes=await b.installFromBytes(request,bytes);
  check("未经批准的字节包不允许安装",!byBytes.ok,byBytes);
  check("未批准字节包零落盘",await readFile(join(b.packagePath(request.name),"package.tgz")).then(()=>false,()=>true));
  check("未批准字节包没有清单",(await b.readState()).kind==="absent");
  const src=join(root,"src");await mkdir(src);await writeFile(join(src,"index.js"),"unapproved node");
  const dHash=stableDirectoryHash([{path:"index.js",bytes:Buffer.from("unapproved node")}])!;
  const c=new EngineNodeRegistry({dataDir:join(root,"directory"),engineId:"node-red"});
  const byDir=await c.installFromDirectory({...request,sha256:dHash},src);
  check("未经批准的目录包不允许安装",!byDir.ok,byDir);
  check("未批准目录包零落盘",await readFile(join(c.packagePath(request.name),"index.js")).then(()=>false,()=>true));
  check("未批准目录包没有清单",(await c.readState()).kind==="absent");
  const allowed=await c.installFromDirectory({...request,sha256:dHash,approvedByUser:true},src);
  check("受信审批已同意的目录安装不误拒",allowed.ok,allowed);
  check("明确审批后才能拥有网络能力",await c.allowsNetwork(request.name));
}finally{await rm(root,{recursive:true,force:true});}
console.log("engine-node-approval-guard-smoke:"+(n-failed)+"/"+n);
if(failed)process.exitCode=1;
