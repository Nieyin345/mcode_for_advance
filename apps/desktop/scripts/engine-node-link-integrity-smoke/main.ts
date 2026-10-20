/** ARC-006 Gate E: real NTFS/POSIX hardlinks/junctions in executable plugin trees.
 * All fixture files are in an isolated mkdtemp; never read/write a user's Node-RED data. */
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineNodeRegistry, stableDirectoryHash } from "@main/workflowEngines/engineNodeRegistry.js";
import { ensureEngineNodeReady } from "@main/workflowEngines/engineNodeReadiness.js";

let total=0,failed=0;
function check(title:string, good:boolean, detail?:unknown):void {
 total++;console.log((good?"  ok   ":"  FAIL ")+title+(good?"":" "+JSON.stringify(detail)));if(!good)failed++;
}
async function status(registry:EngineNodeRegistry):Promise<string|null>{
 try{await ensureEngineNodeReady(registry);return null;}catch(e){return e instanceof Error?e.message:String(e);}
}
const root=await mkdtemp(join(tmpdir(),"mcode-engine-node-links-"));
try{
 const dataDir=join(root,"engine");
 const source=join(root,"approved-source");
 const bytes=Buffer.from("module.exports=function(RED){RED.nodes.registerType('fixture',function(){});};\n");
 const name="node-red-contrib-link-check";
 const hash=stableDirectoryHash([{path:"index.js",bytes}])!;
 const meta={name,version:"1.0.0",source:"isolated-fixture",license:"MIT",sha256:hash,capabilities:[] as string[],approvedByUser:true};
 await mkdir(source,{recursive:true});
 await writeFile(join(source,"index.js"),bytes);
 const registry=new EngineNodeRegistry({dataDir,engineId:"node-red"});
 const installed=await registry.installFromDirectory(meta,source);
 check("原生普通文件的已批准包可正常安装",installed.ok,installed);
 check("原生普通目录/普通脚本完整性正控通过",(await status(registry))===null);
 const outside=join(root,"outside-original.js");
 await writeFile(outside,bytes);
 const target=join(registry.packagePath(name),"index.js");
 await rm(target);
 await link(outside,target);
 const linkInfo=await lstat(target);
 check("隔离盘上实际创建了文件硬链接（nlink>=2）",linkInfo.isFile()&&linkInfo.nlink>=2,{nlink:linkInfo.nlink});
 const bad=await status(registry);
 check("即便外部硬链接字节与批准 sha256 完全一致也必须阻止启动",bad!==null&&/链接|link|普通|完整性|读取/.test(bad),bad);
 check("拒启动不会删除或改写 dataDir 外部硬链接原件",(await readFile(outside)).equals(bytes));
 // A hardlinked source should not be silently copied into a trusted plugin installation.
 const hardSource=join(root,"hardlinked-source");
 await mkdir(hardSource);
 await link(outside,join(hardSource,"index.js"));
 const newRegistry=new EngineNodeRegistry({dataDir:join(root,"second-engine"),engineId:"node-red"});
 const denied=await newRegistry.installFromDirectory({...meta,name:"node-red-contrib-source-link"},hardSource);
 check("安装源文件为硬链接时 fail-closed，不能当作普通包体",!denied.ok&&/链接|link|文件类型|普通|读取/.test(denied.reason),denied);
 const noState=await newRegistry.readState();
 check("拒绝外部硬链接源不会登记真人已批准的插件记录",noState.kind==="absent");
 // Optional: Windows junction usually works without elevated symlink privileges.
 await rm(target);
 await writeFile(target,bytes);
 const alternate=join(root,"approved-target-directory");
 await mkdir(alternate);
 await writeFile(join(alternate,"index.js"),bytes);
 const targetDir=registry.packagePath(name);
 await rm(targetDir,{recursive:true,force:true});
 let available=true;
 try {await symlink(alternate,targetDir,process.platform==="win32"?"junction":"dir");}
 catch(e) {available=false;console.log("  SKIP directory symlink/junction: "+String(e));}
 if(available){
   const symlinkInfo=await lstat(targetDir);
   check("实际创建的是目录符号链接/junction",symlinkInfo.isSymbolicLink());
   const linkBlocked=await status(registry);
   check("已批准包的根目录是 symlink/junction 时不允许信任相同字节",linkBlocked!==null&&/链接|link|目录|完整性|读取/.test(linkBlocked),linkBlocked);
   check("拒绝根目录链接不更改其数据目录外部源文件",(await readFile(join(alternate,"index.js"))).equals(bytes));
 }
 // The plugin root itself may be ordinary while the *container* node_modules is
 // a junction to an external directory. lstat(packageRoot) alone does not catch it.
 const externalModules=join(root,"external-node-modules");
 const siblingDir=join(externalModules,name);
 await mkdir(siblingDir,{recursive:true});
 await writeFile(join(siblingDir,"index.js"),bytes);
 const linkedData=join(root,"container-symlink-engine");
 await mkdir(linkedData);
 const nmLink=join(linkedData,"node_modules");
 let nmAvailable=true;
 try{await symlink(externalModules,nmLink,process.platform==="win32"?"junction":"dir");}
 catch(e){nmAvailable=false;console.log("  SKIP node_modules symlink/junction: "+String(e));}
 if(nmAvailable){
   const linkedRegistry=new EngineNodeRegistry({dataDir:linkedData,engineId:"node-red"});
   const noLedgerBlocked=await status(linkedRegistry);
   check("未安装任何受批插件时也不允许 node_modules 容器绕出 dataDir",
     noLedgerBlocked!==null&&/node_modules|链接|link|目录/.test(noLedgerBlocked),noLedgerBlocked);
   // A read-only start gate previously rejected a junction but an install/write
   // transaction could still follow it and write a new package OUTSIDE dataDir.
   const externalRecord=join(externalModules,"node-red-contrib-external-write");
   const tarball=Buffer.from("isolated package bytes for write path test");
   const tarMeta={...meta,name:"node-red-contrib-external-write",
     sha256:createHash("sha256").update(tarball).digest("hex")};
   let written=false;let writeError="";
   try {
     const result=await linkedRegistry.installFromBytes(tarMeta,tarball);
     written=result.ok;writeError=result.ok?"":result.reason;
   }catch(e){writeError=String(e);}
   check("安装事务不能越过 node_modules junction 写入外部目录",
     !written&&/链接|link|目录|拒绝/.test(writeError),writeError);
   let escaped=false;
   try{await lstat(externalRecord);escaped=true;}catch{ /* expected missing */ }
   check("拒绝安装不会在外部 node_modules 产生新包体",!escaped);

   // Keep a positive approved ledger fixture for the *read* preflight regression:
   // the test writes only its own synthetic ledger, not a real user's records.
   await writeFile(join(linkedData,"engine-nodes.json"),JSON.stringify({
     schema:"mcode.workflow-engine.nodes/v1",engineId:"node-red",
     entries:[{...meta,installedAt:1,state:"installed"}],
   }));
   const blocked=await status(linkedRegistry);
   check("node_modules 容器为外链 junction 时即使批准包根目录普通也必须拒启",
     blocked!==null&&/链接|link|目录|完整性|读取/.test(blocked),blocked);
   check("node_modules 外链拒启不能改动外部包体",(await readFile(join(siblingDir,"index.js"))).equals(bytes));
 }
 // The *dataDir itself* may be an external junction, even if child paths are
 // normal directories and files. An approved record must never be published there.
 const outsideDataDir=join(root,"outside-data-root");
 await mkdir(outsideDataDir,{recursive:true});
 const dataLink=join(root,"data-root-junction");
 let dataLinkAvailable=true;
 try{await symlink(outsideDataDir,dataLink,process.platform==="win32"?"junction":"dir");}
 catch(e){dataLinkAvailable=false;console.log("  SKIP dataDir junction: "+String(e));}
 if(dataLinkAvailable){
   const alias=new EngineNodeRegistry({dataDir:dataLink,engineId:"node-red"});
   let wrote=false;let reason="";
   try{
     const result=await alias.recordInstall({...meta,name:"node-red-contrib-dataroot"});
     wrote=result.ok;reason=result.ok?"":result.reason;
   }catch(e){reason=String(e);}
   check("整个 dataDir 指向外部 junction 时任何批准记录写入必须拒绝",
     !wrote&&/目录|链接|link|拒绝/.test(reason),reason);
   let outsideLedger=false;
   try{await lstat(join(outsideDataDir,"engine-nodes.json"));outsideLedger=true;}catch{/* absent */}
   check("dataDir 外链拒绝路径不能在外部根生成新清单",!outsideLedger);
 }
 // npm scopes are a second level of parent directory that can be linked.
 const scopedRoot=join(root,"scoped-write-engine");
 const scopedOut=join(root,"external-scoped-parent");
 await mkdir(join(scopedRoot,"node_modules"),{recursive:true});
 await mkdir(scopedOut);
 let scopeLinkAvailable=true;
 try{await symlink(scopedOut,join(scopedRoot,"node_modules","@external"),
   process.platform==="win32"?"junction":"dir");}
 catch(e){scopeLinkAvailable=false;console.log("  SKIP npm scope junction: "+String(e));}
 if(scopeLinkAvailable){
   const scopedRegistry=new EngineNodeRegistry({dataDir:scopedRoot,engineId:"node-red"});
   let wrote=false;let reason="";
   try{
     const result=await scopedRegistry.installFromBytes({...meta,name:"@external/unapproved",
       sha256:createHash("sha256").update(bytes).digest("hex")},bytes);
     wrote=result.ok;reason=result.ok?"":result.reason;
   }catch(e){reason=String(e);}
   check("npm scope 父目录为外链时不允许安装到外部位置",
     !wrote&&/链接|link|目录|拒绝/.test(reason),reason);
   let escaped=false;
   try{await lstat(join(scopedOut,"unapproved"));escaped=true;}catch{/* absent */}
   check("拒绝 scoped 安装不在外部目录留下可执行包",!escaped);
   // A revoked scoped plugin in a preexisting ledger must not cause rm()
   // to follow the linked @scope parent and erase an unrelated external file.
   const externalPackage=join(scopedOut,"unapproved");
   await mkdir(externalPackage,{recursive:true});
   await writeFile(join(externalPackage,"index.js"),bytes);
   await writeFile(join(scopedRoot,"engine-nodes.json"),JSON.stringify({
     schema:"mcode.workflow-engine.nodes/v1",engineId:"node-red",
     entries:[{...meta,name:"@external/unapproved",installedAt:1,state:"installed"}],
   }));
   let removed=false;let revokeReason="";
   try{
     const result=await scopedRegistry.revoke("@external/unapproved");
     removed=result.ok;revokeReason=result.ok?"":result.reason;
   }catch(e){revokeReason=String(e);}
   check("撤销外链 scoped 包拒绝删除 dataDir 外部文件",
     !removed&&/链接|link|目录|拒绝/.test(revokeReason),revokeReason);
   check("拒绝撤权不会删除 scope junction 外的原有脚本",
     (await readFile(join(externalPackage,"index.js"))).equals(bytes));
 }
 // Genuine scoped npm node packages should keep working when the scope is an
 // ordinary directory: the security guard must not accidentally outlaw all scopes.
 const safeScope=new EngineNodeRegistry({dataDir:join(root,"safe-scoped-engine"),engineId:"node-red"});
 const scopedBytes=Buffer.from("isolated valid scoped npm package");
 const safeMeta={...meta,name:"@trusted/normal-package",
   sha256:createHash("sha256").update(scopedBytes).digest("hex")};
 const scopedInstall=await safeScope.installFromBytes(safeMeta,scopedBytes);
 check("正常普通目录的 scoped 插件应允许成功安装",scopedInstall.ok,scopedInstall);
 if(scopedInstall.ok){
   check("scoped 插件发布出的字节与原批准 tarball 相同",
     (await readFile(join(safeScope.packagePath(safeMeta.name),"package.tgz"))).equals(scopedBytes));
   check("scoped 插件在启动前通过合法清单和完整性验证",await status(safeScope)===null);
 }
 // Nested executable hardlinks must be rejected too, not only root index.js.
 const nestedSource=join(root,"nested-source");
 await mkdir(join(nestedSource,"lib"),{recursive:true});
 await link(outside,join(nestedSource,"lib","entry.js"));
 const nestedReg=new EngineNodeRegistry({dataDir:join(root,"nested-engine"),engineId:"node-red"});
 const nestedHash=stableDirectoryHash([{path:"lib/entry.js",bytes}])!;
 const nestedResult=await nestedReg.installFromDirectory({...meta,name:"node-red-contrib-nested-link",sha256:nestedHash},nestedSource);
 check("嵌套子目录的 JS 硬链接同样拒绝安装且不登记",!nestedResult.ok,nestedResult);
}finally{await rm(root,{recursive:true,force:true});}
console.log("engine-node-link-integrity-smoke:"+(total-failed)+"/"+total);
if(failed)process.exitCode=1;
