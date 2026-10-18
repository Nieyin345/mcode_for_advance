/** ARC-006: real readiness policy + production wiring contracts. No user data; mkdtemp only. */
import {mkdtemp,mkdir,readFile,readdir,rename,rm,writeFile} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {EngineNodeRegistry,ENGINE_NODE_REGISTRY_FILENAME,stableDirectoryHash} from "@main/workflowEngines/engineNodeRegistry.js";
import {ensureEngineNodeReady} from "@main/workflowEngines/engineNodeReadiness.js";
let total=0,fails=0;function check(t:string,v:boolean,detail?:unknown){total++;console.log((v?"  ok   ":"  FAIL ")+t+(v?"":" "+JSON.stringify(detail)));if(!v)fails++;}
const root=await mkdtemp(join(tmpdir(),"mcode-engine-readiness-"));
const pkg="node-red-contrib-readiness",data="one approved package";
const meta={name:pkg,version:"1.0.0",source:"fixture",sha256:stableDirectoryHash([{path:"index.js",bytes:Buffer.from(data)}])!,license:"MIT",capabilities:[],approvedByUser:true};
const create=async(base:string)=>{
  const registry=new EngineNodeRegistry({dataDir:base,engineId:"node-red"});
  const src=join(base,"src");await mkdir(src,{recursive:true});await writeFile(join(src,"index.js"),data);
  const inst=await registry.installFromDirectory(meta,src);
  if(!inst.ok)throw Error(inst.reason);
  return registry;
};
const denied=async(registry:EngineNodeRegistry):Promise<string|null>=>{
  try{await ensureEngineNodeReady(registry);return null;}catch(e){return String(e);}
};
try{
  const empty=new EngineNodeRegistry({dataDir:join(root,"empty"),engineId:"node-red"});
  check("无清单无插件时默认允许空引擎起跑",await denied(empty)===null);
  const corruptDir=join(root,"corrupt");await mkdir(corruptDir);await writeFile(join(corruptDir,ENGINE_NODE_REGISTRY_FILENAME),"{oops");
  const corrupt=new EngineNodeRegistry({dataDir:corruptDir,engineId:"node-red"});
  const c=await denied(corrupt);
  check("损坏清单阻止启动",typeof c==="string"&&/节点清单/.test(c),c);
  check("拒绝后坏清单字节原样保留",await readFile(join(corruptDir,ENGINE_NODE_REGISTRY_FILENAME),"utf8")==="{oops");
  const pendingDir=join(root,"pending"),p=await create(pendingDir);
  const ledger=join(pendingDir,ENGINE_NODE_REGISTRY_FILENAME);
  const old=JSON.parse(await readFile(ledger,"utf8")) as {entries:Array<{state:string}>};
  old.entries[0]!.state="pending-remove";
  await writeFile(ledger,JSON.stringify(old));
  check("前置：未完成撤权执行体物理文件仍存在",await readFile(join(p.packagePath(pkg),"index.js"),"utf8")===data);
  const resolved=await denied(new EngineNodeRegistry({dataDir:pendingDir,engineId:"node-red"}));
  check("正常撤权补偿完成后允许启动",resolved===null,resolved);
  check("恢复已撤权插件会删除可执行体而非单纯清账",await readFile(join(p.packagePath(pkg),"index.js")).then(()=>false,()=>true));
  check("清单也删除 pending-remove 条目",(await p.readState()).kind==="ok"&&(await p.readState()).entries.length===0);

  const ambiguousDir=join(root,"ambiguous"),a=await create(ambiguousDir);
  const backup=join(ambiguousDir,".engine-node-rollback-"+pkg+"-fixture123-abc123");
  await rename(a.packagePath(pkg),backup);
  await mkdir(a.packagePath(pkg),{recursive:true});
  await writeFile(join(a.packagePath(pkg),"index.js"),"unapproved rogue target");
  const ambiguous=await denied(new EngineNodeRegistry({dataDir:ambiguousDir,engineId:"node-red"}));
  check("旧包备份与新目标并存时拒绝起跑",!!ambiguous&&/人工核对/.test(ambiguous),ambiguous);
  check("歧义阻断路径不删除备份",await readFile(join(backup,"index.js"),"utf8")===data);
  check("歧义阻断路径不删除现有目标",await readFile(join(a.packagePath(pkg),"index.js"),"utf8")==="unapproved rogue target");

  const source=readFileSync(join(process.cwd(),"src/main/ipc/index.ts"),"utf8");
  check("生产 IPC 从共享就绪核引入实现",/import \{ ensureEngineNodeReady \} from/.test(source));
  check("生产实际调用共享就绪核",/ensureEngineNodeReady\(engineNodeRegistry\)/.test(source));
  check("生产 beforeStart 启动闸门接入",/beforeStart:[\s\S]{0,170}await ensureEngineNodesReady\(\)/.test(source));
  check("生产节点安装也先调用就绪闸门",/install: async[\s\S]{0,800}await ensureEngineNodesReady\(\)/.test(source));
} finally {await rm(root,{recursive:true,force:true});}
console.log("engine-node-readiness-smoke:"+(total-fails)+"/"+total);
if(fails)process.exitCode=1;
