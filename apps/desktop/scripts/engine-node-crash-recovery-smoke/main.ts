/** ARC-006: conservative restore of interrupted package publication. All paths are private mkdtemp fixtures. */
import {mkdtemp,mkdir,rename,rm,writeFile,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {EngineNodeRegistry,stableDirectoryHash} from "@main/workflowEngines/engineNodeRegistry.js";
let count=0,bad=0;function ck(t:string,b:boolean,d?:unknown){count++;console.log((b?"  ok   ":"  FAIL ")+t+(b?"":" "+JSON.stringify(d)));if(!b)bad++;}
const root=await mkdtemp(join(tmpdir(),"mcode-crash-nodes-"));
const name="node-red-contrib-crash";
const text="original-valid-node";
const sha=stableDirectoryHash([{path:"index.js",bytes:Buffer.from(text)}])!;
const meta={name,version:"1.0.0",source:"fixture",sha256:sha,license:"MIT",capabilities:["resource.read"],approvedByUser:true};
const recovery=async (r:EngineNodeRegistry):Promise<{recovered:string[];blocked:Array<{name:string;reason:string}>}>=>{
  const api=r as unknown as {recoverCrashBackups?:()=>Promise<{recovered:string[];blocked:Array<{name:string;reason:string}>}>};
  return api.recoverCrashBackups ? api.recoverCrashBackups() : {recovered:[],blocked:[{name:"*",reason:"未实现 recoverCrashBackups"}]};
};
const prepare=async(data:string)=>{
  const r=new EngineNodeRegistry({dataDir:data,engineId:"node-red"});
  const src=join(data,"fixture");await mkdir(src,{recursive:true});await writeFile(join(src,"index.js"),text);
  const first=await r.installFromDirectory(meta,src);
  if(!first.ok)throw Error("fixture install failed: "+first.reason);
  return r;
};
try{
  // After process death exactly after move(old,backup), the active path is missing.
  const d=join(root,"missing"),r=await prepare(d);
  const backup=join(d,".engine-node-rollback-"+name+"-fixture123-abc123");
  await rename(r.packagePath(name),backup);
  const resumed=await recovery(new EngineNodeRegistry({dataDir:d,engineId:"node-red"}));
  ck("单份匹配且校验通过的旧包自动恢复",resumed.recovered.includes(name),resumed);
  ck("恢复后旧可执行体回到原路径",await readFile(join(r.packagePath(name),"index.js"),"utf8").catch(()=>null)===text);
  ck("恢复完成不留隐藏备份",(await readdir(d)).every(x=>!x.startsWith(".engine-node-rollback-")));
  ck("恢复不更改授权清单",(await r.readState()).kind==="ok");

  // New target may have been placed but commit not completed: never blindly overwrite or delete.
  const d2=join(root,"ambiguous"),r2=await prepare(d2);
  const backup2=join(d2,".engine-node-rollback-"+name+"-fixture123-abc123");
  await rename(r2.packagePath(name),backup2);
  await mkdir(r2.packagePath(name),{recursive:true});await writeFile(join(r2.packagePath(name),"index.js"),"unapproved-mutated-body");
  const conflict=await recovery(new EngineNodeRegistry({dataDir:d2,engineId:"node-red"}));
  ck("目标与备份并存时必须返回阻断诊断",conflict.blocked.length>0,conflict);
  ck("不能删除有争议的原执行体备份",await readFile(join(backup2,"index.js"),"utf8").catch(()=>null)===text);
  ck("不能静默保留或信任不一致的新包",await readFile(join(r2.packagePath(name),"index.js"),"utf8").catch(()=>null)==="unapproved-mutated-body");

  // Corrupted backup must not be blindly restored.
  const d3=join(root,"corrupt"),r3=await prepare(d3);
  const backup3=join(d3,".engine-node-rollback-"+name+"-fixture123-abc123");
  await rename(r3.packagePath(name),backup3);
  await writeFile(join(backup3,"index.js"),"tampered");
  const corrupted=await recovery(new EngineNodeRegistry({dataDir:d3,engineId:"node-red"}));
  ck("备份内容哈希错误时拒绝自动恢复",corrupted.blocked.length>0,corrupted);
  ck("哈希错误时保留原始可诊断备份",(await readFile(join(backup3,"index.js"),"utf8"))==="tampered");

  // Missing ledger must never be treated as permission to reconstruct a package.
  const d4=join(root,"unknown");await mkdir(d4,{recursive:true});
  const backup4=join(d4,".engine-node-rollback-unknown-node-fixture123-abc123");
  await mkdir(backup4);await writeFile(join(backup4,"index.js"),"unverified");
  const unknown=await recovery(new EngineNodeRegistry({dataDir:d4,engineId:"node-red"}));
  ck("清单无条目时孤儿包仅报告不能自动恢复",unknown.blocked.length>0,unknown);
  ck("未知来源备份不被删除",await readFile(join(backup4,"index.js"),"utf8").catch(()=>null)==="unverified");
} finally {await rm(root,{recursive:true,force:true});}
console.log("engine-node-crash-recovery-smoke:"+(count-bad)+"/"+count);
if(bad)process.exitCode=1;
