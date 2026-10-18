/** ARC-006 Gate E: reject unregistered Node-RED nodes; never clobber stale manifest staging files.
 * All fixtures use private mkdtemp and never start Electron, real Node-RED, or user SDKs. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineNodeRegistry, ENGINE_NODE_REGISTRY_FILENAME } from "@main/workflowEngines/engineNodeRegistry.js";
import { ensureEngineNodeReady } from "@main/workflowEngines/engineNodeReadiness.js";

let count=0, failures=0;
function check(title:string, condition:boolean, detail?:unknown):void {
  count++;
  console.log((condition?"  ok   ":"  FAIL ")+title+(condition?"":" — "+JSON.stringify(detail)));
  if(!condition) failures++;
}
async function outcome(registry:EngineNodeRegistry):Promise<string|null> {
  try { await ensureEngineNodeReady(registry); return null; }
  catch(error) { return error instanceof Error ? error.message : String(error); }
}
const root=await mkdtemp(join(tmpdir(),"mcode-node-orphan-guard-"));
try {
  const dir=join(root,"engine");
  const r=new EngineNodeRegistry({dataDir:dir,engineId:"node-red"});
  check("空 dataDir 正控：未装第三方 Node-RED 插件允许预检",await outcome(r)===null);

  const modules=join(dir,"node_modules");
  const core=join(modules,"node-red");
  await mkdir(core,{recursive:true});
  await writeFile(join(core,"package.json"),JSON.stringify({name:"node-red",version:"5.0.8", "node-red":{nodes:{"core":"core.js"}}}));
  const dep=join(modules,"express");
  await mkdir(dep,{recursive:true});
  await writeFile(join(dep,"package.json"),JSON.stringify({name:"express",version:"5.0.0"}));
  const coreNodes=join(modules,"@node-red","nodes");
  await mkdir(coreNodes,{recursive:true});
  await writeFile(join(coreNodes,"package.json"),JSON.stringify({name:"@node-red/nodes","node-red":{nodes:{core:"core.js"}}}));
  check("Node-RED 核心、官方基础节点与普通 npm 依赖不误报社区插件",await outcome(r)===null);

  const rogue=join(modules,"node-red-contrib-rogue");
  await mkdir(rogue,{recursive:true});
  const rogueJson=JSON.stringify({name:"node-red-contrib-rogue",version:"1.0.0","node-red":{nodes:{rogue:"index.js"}}});
  await writeFile(join(rogue,"package.json"),rogueJson);
  await writeFile(join(rogue,"index.js"),"module.exports = () => 'rogue';");
  const first=await outcome(r);
  check("无安装审批清单时不允许运行 node-red-contrib-* 可执行节点",!!first && /未登记|未批准|未授权/.test(first),first);
  check("阻断时不得删除任何未登记旧文件",(await readFile(join(rogue,"index.js"),"utf8")).includes("rogue"));
  await rm(join(rogue,"package.json"));
  const noManifest=await outcome(r);
  check("社区 node-red-contrib 前缀即使删除 manifest 仍不放行",!!noManifest && /未登记|未批准/.test(noManifest),noManifest);

  // An arbitrary-named package (including scoped) can still register executable nodes via package.json.
  await rm(rogue,{recursive:true,force:true});
  const scoped=join(modules,"@evil-scope","innocent-name");
  await mkdir(scoped,{recursive:true});
  await writeFile(join(scoped,"package.json"),JSON.stringify({name:"@evil-scope/innocent-name","node-red":{nodes:{payload:"index.js"}}}));
  await writeFile(join(scoped,"index.js"),"module.exports=()=>42");
  const scopedDenied=await outcome(r);
  check("任意包名的 @scope Node-RED nodes 必须验证宿主清单",!!scopedDenied && /未登记|未批准|未授权/.test(scopedDenied),scopedDenied);
  await rm(scoped,{recursive:true,force:true});

  const generic=join(modules,"random-package");
  await mkdir(generic,{recursive:true});
  await writeFile(join(generic,"package.json"),JSON.stringify({name:"random-package","node-red":{nodes:{b:"b.js"}}}));
  const arbitraryDenied=await outcome(r);
  check("非 node-red-contrib 名称但声明 node-red.nodes 的包也拒启",!!arbitraryDenied && /未登记|未批准|未授权/.test(arbitraryDenied),arbitraryDenied);
  await rm(generic,{recursive:true,force:true});
  const corrupt=join(modules,"unknown-corrupt-package");
  await mkdir(corrupt,{recursive:true});
  await writeFile(join(corrupt,"package.json"),"{ broken json");
  const badManifest=await outcome(r);
  check("无法判定 npm 包声明的坏 JSON 必须 fail-closed",!!badManifest && /核实|声明/.test(badManifest),badManifest);
  await rm(corrupt,{recursive:true,force:true});

  const stale=join(dir,ENGINE_NODE_REGISTRY_FILENAME)+"."+process.pid+".tmp";
  await writeFile(stale,"OTHER_AGENT_PRIVATE_STAGE_SENTINEL");
  const valid=await r.recordInstall({
    name:"node-red-contrib-registered",version:"1.0.0",source:"fixture",license:"MIT",
    sha256:"a".repeat(64),capabilities:[],approvedByUser:true,
  });
  check("有效登记仍可更新独立 registry",valid.ok,valid);
  check("不能覆盖/破坏相同 PID 命名旧暂存文件",await readFile(stale,"utf8")==="OTHER_AGENT_PRIVATE_STAGE_SENTINEL");
  const ledger=JSON.parse(await readFile(join(dir,ENGINE_NODE_REGISTRY_FILENAME),"utf8")) as {entries:Array<{name:string}>};
  check("原子写清单的最终 JSON 正确落盘",ledger.entries.some(x=>x.name==="node-red-contrib-registered"),ledger);
  const leftovers=(await readdir(dir)).filter(x=>x.startsWith(ENGINE_NODE_REGISTRY_FILENAME+".") && x!==ENGINE_NODE_REGISTRY_FILENAME+"."+process.pid+".tmp");
  check("原子写成功不残留自身随机命名的 tmp 文件",leftovers.length===0,leftovers);
}finally{await rm(root,{recursive:true,force:true});}
console.log("engine-node-orphan-guard-smoke:"+(count-failures)+"/"+count);
if(failures)process.exitCode=1;
