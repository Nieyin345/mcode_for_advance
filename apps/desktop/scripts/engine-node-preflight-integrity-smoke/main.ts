/** ARC-006 Gate E: before real Node-RED spawn, verify every approved executable against the disk. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EngineNodeRegistry, stableDirectoryHash } from "@main/workflowEngines/engineNodeRegistry.js";
import { ensureEngineNodeReady } from "@main/workflowEngines/engineNodeReadiness.js";

let checks=0, failures=0;
function check(name:string, ok:boolean, detail?:unknown):void {
  checks++;
  console.log((ok?"  ok   ":"  FAIL ")+name+(ok?"":" "+JSON.stringify(detail)));
  if(!ok)failures++;
}
async function startDenied(registry:EngineNodeRegistry):Promise<string | null> {
  try {await ensureEngineNodeReady(registry);return null;}
  catch(error){return error instanceof Error ? error.message : String(error);}
}
const root=await mkdtemp(join(tmpdir(),"mcode-node-preflight-"));
const name="node-red-contrib-verify";
try {
  const dir=join(root,"directory");
  const source=join(root,"source");
  await mkdir(source,{recursive:true});
  const old="module.exports = function(RED) { RED.nodes.registerType('safe', ()=>{}); };";
  await writeFile(join(source,"index.js"),old);
  const hash=stableDirectoryHash([{path:"index.js",bytes:Buffer.from(old)}])!;
  const base={name,version:"1.0.0",source:"isolated-fixture",license:"MIT",capabilities:[] as string[],approvedByUser:true,sha256:hash};
  const registry=new EngineNodeRegistry({dataDir:dir,engineId:"node-red"});
  const first=await registry.installFromDirectory(base,source);
  check("正控：经过批准的目录包确实已安装",first.ok,first);
  check("正控：真实完整包启动前验证通过",await startDenied(registry)===null);
  const target=join(registry.packagePath(name),"index.js");
  await writeFile(target,"module.exports = function(RED) { /* TAMPERED */ }");
  const afterEdit=await startDenied(registry);
  check("未经批准篡改已安装节点内容必须拒绝引擎启动",!!afterEdit && /哈希|不一致|完整性|篡改/.test(afterEdit),afterEdit);
  check("拒启动不可偷偷修复或覆盖被篡改源文件",(await readFile(target,"utf8")).includes("TAMPERED"));
  await rm(registry.packagePath(name),{recursive:true,force:true});
  const missing=await startDenied(registry);
  check("已批准记录对应的可执行包在盘上消失时拒启",!!missing && /不存在|读取|缺失|完整性/.test(missing),missing);
  await mkdir(registry.packagePath(name),{recursive:true});
  await writeFile(target,old);
  check("恢复原哈希后可重新启动",await startDenied(registry)===null);

  const archiveDir=join(root,"bytes");
  const archive=Buffer.from("isolated tarball content");
  const hashArchive=createHash("sha256").update(archive).digest("hex");
  const byteRegistry=new EngineNodeRegistry({dataDir:archiveDir,engineId:"node-red"});
  const installed=await byteRegistry.installFromBytes({...base,name:"node-red-contrib-bytes",sha256:hashArchive},archive);
  check("正控：已批准字节包安装成功",installed.ok,installed);
  check("正控：受信 tarball SHA 正确时通过",await startDenied(byteRegistry)===null);
  const archivePath=join(byteRegistry.packagePath("node-red-contrib-bytes"),"package.tgz");
  await writeFile(archivePath,"tampered tarball bytes");
  const byteFail=await startDenied(byteRegistry);
  check("已批准 tarball 被修改后必须拒绝启动",!!byteFail && /哈希|不一致|篡改|完整性/.test(byteFail),byteFail);

  const legacyDir=join(root,"legacy");
  await mkdir(legacyDir,{recursive:true});
  const state={
    schema:"mcode.workflow-engine.nodes/v1",engineId:"node-red",
    entries:[{...base,installedAt:1,state:"installed",approvedByUser:false}],
  };
  await writeFile(join(legacyDir,"engine-nodes.json"),JSON.stringify(state));
  const legacy=new EngineNodeRegistry({dataDir:legacyDir,engineId:"node-red"});
  const denied=await startDenied(legacy);
  check("历史 installed 但没有真人批准的条目不得在启动时默许执行",!!denied && /批准|未授权/.test(denied),denied);
} finally {
  await rm(root,{recursive:true,force:true});
}
console.log("engine-node-preflight-integrity-smoke: "+(checks-failures)+"/"+checks);
if(failures>0)process.exitCode=1;
