/** ARC-006 Gate E: a corrupted/unreadable node ledger must never destroy an existing executable. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineNodeRegistry, ENGINE_NODE_REGISTRY_FILENAME, stableDirectoryHash } from "@main/workflowEngines/engineNodeRegistry.js";
import { installEngineNode } from "@main/workflowEngines/engineNodeInstallRoute.js";

let total=0, failures=0;
function check(label:string,ok:boolean,detail?:unknown):void {
  total++; console.log((ok?"  ok   ":"  FAIL ")+label+(ok?"":" "+JSON.stringify(detail)));
  if(!ok) failures++;
}
const dir=await mkdtemp(join(tmpdir(),"mcode-node-corrupt-preserve-"));
try {
  const bytes=Buffer.from("new-approved-package");
  const sha=createHash("sha256").update(bytes).digest("hex");
  const name="node-red-contrib-test-corrupt";
  const meta={name,version:"1.0.0",source:"fixture",sha256:sha,license:"MIT",capabilities:[],approvedByUser:true};
  const dataDir=join(dir,"bytes");
  const registry=new EngineNodeRegistry({dataDir,engineId:"node-red"});
  const prior=registry.packagePath(name);
  await mkdir(prior,{recursive:true});
  await writeFile(join(prior,"package.tgz"),"previously-installed-and-approved");
  await writeFile(join(dataDir,ENGINE_NODE_REGISTRY_FILENAME),"{bad-json");
  const original=await readFile(join(prior,"package.tgz"),"utf8");
  const result=await registry.installFromBytes(meta,bytes);
  check("坏账不得重新安装字节包",!result.ok,result);
  check("坏账被明确报告而不是当作不存在",!result.ok && /损坏|清单|读取/.test(result.reason),result);
  check("坏账拒绝时旧字节包仍在",await readFile(join(prior,"package.tgz"),"utf8").catch(()=>null)===original);
  check("坏清单逐字节保留",await readFile(join(dataDir,ENGINE_NODE_REGISTRY_FILENAME),"utf8")==="{bad-json");
  check("坏账拒绝时没有中间暂存目录",(await readdir(join(dataDir,"node_modules"))).every(x=>!x.startsWith(".staging-")));

  const d=join(dir,"directory");
  const r2=new EngineNodeRegistry({dataDir:d,engineId:"node-red"});
  const old=r2.packagePath(name);
  await mkdir(old,{recursive:true});
  await writeFile(join(old,"index.js"),"older-approved-body");
  await writeFile(join(d,ENGINE_NODE_REGISTRY_FILENAME),"{still-bad");
  const source=join(dir,"src");
  await mkdir(source,{recursive:true});
  await writeFile(join(source,"index.js"),"new-executable-body");
  const newBody=Buffer.from("new-executable-body");
  const hash=stableDirectoryHash([{path:"index.js",bytes:newBody}]);
  if(!hash)throw Error("test fixture invalid");
  const result2=await r2.installFromDirectory({...meta,sha256:hash},source);
  check("坏账不得重新安装目录包",!result2.ok,result2);
  check("坏账拒绝时旧目录包仍在",await readFile(join(old,"index.js"),"utf8").catch(()=>null)==="older-approved-body");
  check("目录安装拒绝不破坏清单",await readFile(join(d,ENGINE_NODE_REGISTRY_FILENAME),"utf8")==="{still-bad");
  check("坏账拒绝时目录包没有暂存",(await readdir(join(d,"node_modules"))).every(x=>!x.startsWith(".staging-")));

  // The user-facing route must not ask for approval when storage cannot safely accept a write.
  const routeDir=join(dir,"route");
  const rr=new EngineNodeRegistry({dataDir:routeDir,engineId:"node-red"});
  await mkdir(routeDir,{recursive:true});
  await writeFile(join(routeDir,ENGINE_NODE_REGISTRY_FILENAME),"{ledger-corrupt");
  let asked=0;
  const routed=await installEngineNode({registry:rr,sourceDir:source,meta:{name,version:"1.0.0",source:"fixture",sha256:hash,license:"MIT",capabilities:[]},approval:async()=>{asked++;return true;}});
  check("审批路由对坏账直接拒绝",!routed.ok && /损坏|清单/.test(routed.reason),routed);
  check("必失败的坏账安装不会打扰用户请求批准",asked===0,{asked});
} finally { await rm(dir,{recursive:true,force:true}); }
console.log("engine-node-corrupt-preservation-smoke:"+(total-failures)+"/"+total);
if(failures)process.exitCode=1;
