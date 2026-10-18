/** ARC-006 Gate E: reinstallation failing to persist the manifest must restore an already-installed executable. */
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EngineNodeRegistry, ENGINE_NODE_REGISTRY_FILENAME, stableDirectoryHash, type EngineNodeRegistryFs } from "@main/workflowEngines/engineNodeRegistry.js";

let total=0,failed=0;
function check(label:string,ok:boolean,details?:unknown):void {
 total++;console.log((ok?"  ok   ":"  FAIL ")+label+(ok?"":" "+JSON.stringify(details)));
 if(!ok)failed++;
}
const root=await mkdtemp(join(tmpdir(),"mcode-node-reinstall-rollback-"));
const pkg="node-red-contrib-reinstall";
const metaBase={name:pkg,version:"1.2.3",source:"fixture",license:"MIT",capabilities:[],approvedByUser:true};
const bytes=Buffer.from("existing-verified-binary");
const byteHash=createHash("sha256").update(bytes).digest("hex");
const newFs=():EngineNodeRegistryFs=>({
  async readFile(path){return readFile(path,"utf8");},
  async writeFile(path,text){
    if (path.endsWith(ENGINE_NODE_REGISTRY_FILENAME))throw new Error("EIO: simulated manifest failure");
    await mkdir(dirname(path),{recursive:true});await writeFile(path,text);
  },
  async rename(from,to){await rename(from,to);},
  async mkdir(path){await mkdir(path,{recursive:true});},
  async remove(path){await rm(path,{recursive:true,force:true});},
  async writeBytes(path,data){await mkdir(dirname(path),{recursive:true});await writeFile(path,data);},
  async readTree(path){
    const names=await readdir(path);const files=[];
    for(const name of names)files.push({path:name,bytes:new Uint8Array(await readFile(join(path,name)))});
    return files;
  },
});
const getResult=async(action:()=>Promise<{ok:boolean;reason?:string}>):Promise<{ok:boolean;reason?:string}>=>{
 try{return await action();}catch(e){return {ok:false,reason:"THREW: "+String(e)};}
};
try{
 const d=join(root,"bytes"), reg=new EngineNodeRegistry({dataDir:d,engineId:"node-red"});
 const meta={...metaBase,sha256:byteHash};
 const first=await reg.installFromBytes(meta,bytes);
 check("前置：首次字节安装成功",first.ok,first);
 const pkgPath=join(reg.packagePath(pkg),"package.tgz");
 await writeFile(join(reg.packagePath(pkg),"previous-preserved-sentinel.txt"),"old executable directory sentinel");
 const old=await readFile(pkgPath).catch(()=>null);
 const manifest=await readFile(join(d,ENGINE_NODE_REGISTRY_FILENAME),"utf8");
 const failing=new EngineNodeRegistry({dataDir:d,engineId:"node-red",fs:newFs()});
 const result=await getResult(()=>failing.installFromBytes(meta,bytes));
 check("写清单失败的故障注入确实命中清单写口",!result.ok && /EIO: simulated manifest failure/.test(result.reason ?? ""),result);
 check("写清单失败时字节重装返回显式失败",!result.ok,result);
 const after=await readFile(pkgPath).catch(()=>null);
 check("写清单失败时旧 tarball 字节仍完整",old!==null && after!==null && Buffer.compare(old,after)===0);
 check("写账失败前已存在的额外字节不得因重装被删",await readFile(join(reg.packagePath(pkg),"previous-preserved-sentinel.txt"),"utf8").catch(()=>null)==="old executable directory sentinel");
 check("Manifest 写错必须返回结果而非抛异常",!result.reason?.startsWith("THREW:"),result);
 check("失败的字节重装不改旧清单",await readFile(join(d,ENGINE_NODE_REGISTRY_FILENAME),"utf8")===manifest);
 const entries=await readdir(join(d,"node_modules"));
 check("失败的字节重装不留下 staging/rollback",entries.every(x=>!x.startsWith(".staging-")&&!x.startsWith(".rollback-")),{entries});
 check("写盘失败还原后 dataDir 下没有孤儿备份",(await readdir(d)).every(x=>!x.startsWith(".engine-node-rollback-")));
 const healthyReinstall=await reg.installFromBytes(meta,bytes);
 check("写盘恢复后同哈希正常重装成功",healthyReinstall.ok,healthyReinstall);
 check("成功重装后原文件被新文件替代",await readFile(join(reg.packagePath(pkg),"previous-preserved-sentinel.txt"),"utf8").catch(()=>null)===null);
 check("正常重装不会遗留旧执行体备份",(await readdir(d)).every(x=>!x.startsWith(".engine-node-rollback-")));

 const d2=join(root,"directory"), reg2=new EngineNodeRegistry({dataDir:d2,engineId:"node-red"});
 const src=join(root,"source");await mkdir(src,{recursive:true});
 await writeFile(join(src,"index.js"),"original-node-implementation");
 const srcData=Buffer.from("original-node-implementation");
 const hash=stableDirectoryHash([{path:"index.js",bytes:srcData}]);
 if(!hash)throw Error("bad source");
 const m2={...metaBase,sha256:hash};
 const first2=await reg2.installFromDirectory(m2,src);
 check("前置：首次目录安装成功",first2.ok,first2);
 const pkgFile=join(reg2.packagePath(pkg),"index.js");
 await writeFile(join(reg2.packagePath(pkg),"previous-preserved-sentinel.txt"),"directory sentinel");
 const original=await readFile(pkgFile,"utf8");
 const manifest2=await readFile(join(d2,ENGINE_NODE_REGISTRY_FILENAME),"utf8");
 const failing2=new EngineNodeRegistry({dataDir:d2,engineId:"node-red",fs:newFs()});
 const result2=await getResult(()=>failing2.installFromDirectory(m2,src));
 check("目录重装的故障注入确实命中清单写口",!result2.ok && /EIO: simulated manifest failure/.test(result2.reason ?? ""),result2);
 check("目录重装写账失败时返回显式失败",!result2.ok,result2);
 check("目录重装写账失败时旧可执行体完整",await readFile(pkgFile,"utf8").catch(()=>null)===original);
 check("目录重装失败不删旧包的其它字节",await readFile(join(reg2.packagePath(pkg),"previous-preserved-sentinel.txt"),"utf8").catch(()=>null)==="directory sentinel");
 check("目录重装 Manifest 失败返回结果不抛异常",!result2.reason?.startsWith("THREW:"),result2);
 check("目录重装失败不改清单",await readFile(join(d2,ENGINE_NODE_REGISTRY_FILENAME),"utf8")===manifest2);
 const entries2=await readdir(join(d2,"node_modules"));
 check("目录重装失败不留下 staging/rollback",entries2.every(x=>!x.startsWith(".staging-")&&!x.startsWith(".rollback-")),{entries2});
 check("写账失败的目录备份已在原位恢复",(await readdir(d2)).every(x=>!x.startsWith(".engine-node-rollback-")));
 const healthyDir=await reg2.installFromDirectory(m2,src);
 check("目录包在故障解除后可以正常重装",healthyDir.ok,healthyDir);
 check("目录正常重装后无隐藏旧备份",(await readdir(d2)).every(x=>!x.startsWith(".engine-node-rollback-")));
}finally{await rm(root,{recursive:true,force:true});}
console.log("engine-node-reinstall-rollback-smoke:"+(total-failed)+"/"+total);
if(failed)process.exitCode=1;
