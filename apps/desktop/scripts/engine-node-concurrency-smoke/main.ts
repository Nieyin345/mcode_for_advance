/** ARC-006 Gate E: same-process multi-registry writes cannot silently lose an approved entry. *No user data.* */
import { mkdtemp,mkdir,readFile,writeFile,rename,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname } from "node:path";
import { createHash } from "node:crypto";
import { EngineNodeRegistry, type EngineNodeRegistryFs } from "@main/workflowEngines/engineNodeRegistry.js";
let t=0,f=0;function ck(s:string,c:boolean,d?:unknown){t++;console.log((c?"  ok   ":"  FAIL ")+s+(c?"":" "+JSON.stringify(d)));if(!c)f++;}
const root=await mkdtemp(join(tmpdir(),"mcode-nodes-parallel-"));
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const ports:EngineNodeRegistryFs={
 async readFile(p){ const txt=await readFile(p,"utf8");await delay(18);return txt; },
 async writeFile(p,s){ await delay(18);await mkdir(dirname(p),{recursive:true});const temp=p+".test-"+Math.random().toString(36).slice(2)+".tmp";await writeFile(temp,s,"utf8");await rename(temp,p); },
 async rename(a,b){await rename(a,b);},
 async mkdir(p){await mkdir(p,{recursive:true});},
 async remove(p){await rm(p,{recursive:true,force:true});},
 async writeBytes(p,bytes){await mkdir(dirname(p),{recursive:true});await writeFile(p,bytes);}
};
const meta=(name:string)=>({name,version:"1.0.0",source:"fixture",sha256:createHash("sha256").update(name).digest("hex"),license:"MIT",capabilities:[],approvedByUser:true});
try{
 const p=join(root,"record");
 const reg1=new EngineNodeRegistry({dataDir:p,engineId:"node-red",fs:ports});
 const reg2=new EngineNodeRegistry({dataDir:p,engineId:"node-red",fs:ports});
 const seed=await reg1.recordInstall(meta("node-red-contrib-seed"));
 ck("初始记录可写",seed.ok,seed);
 const r=await Promise.all([reg1.recordInstall(meta("node-red-contrib-alpha")),reg2.recordInstall(meta("node-red-contrib-beta"))]);
 ck("两笔独立用户批准请求都显式成功",r.every(x=>x.ok),r);
 const st=await reg1.readState();
 ck("并发写入没有丢失任何一笔有效记录",st.kind==="ok"&&st.entries.length===3&&["node-red-contrib-seed","node-red-contrib-alpha","node-red-contrib-beta"].every(name=>st.entries.some(x=>x.name===name)),st);
 // Fresh startup must not inherit ambiguous duplicate identities from corrupted trusted ledger.
 const duplicateDir=join(root,"duplicate");await mkdir(duplicateDir,{recursive:true});
 const x={...meta("node-red-contrib-duplicate"),installedAt:1,state:"installed"};
 await writeFile(join(duplicateDir,"engine-nodes.json"),JSON.stringify({schema:"mcode.workflow-engine.nodes/v1",engineId:"node-red",entries:[x,{...x,sha256:"f".repeat(64),installedAt:2}]}));
 const d=new EngineNodeRegistry({dataDir:duplicateDir,engineId:"node-red"});
 ck("受信清单有同名不同哈希记录时必须判 corrupt",(await d.readState()).kind==="corrupt");
 const no=await d.recordInstall(meta("node-red-contrib-new"));
 ck("同名冲突的旧清单不可写回覆盖",!no.ok,no);
 const two=await Promise.all([reg1.recordInstall(meta("node-red-contrib-gamma")),reg2.recordInstall(meta("node-red-contrib-delta"))]);
 ck("第二轮并发记录依旧成功",two.every(x=>x.ok),two);
 const after=await reg1.readState();
 ck("第二轮并发增量不覆写任何已有包",after.kind==="ok"&&after.entries.length===5,after);

 // 两个独立 registry 对同一用户数据根同时发布真可执行包，必须保留各自字节与登记。
 const installRoot=join(root,"installed");
 const i1=new EngineNodeRegistry({dataDir:installRoot,engineId:"node-red",fs:ports});
 const i2=new EngineNodeRegistry({dataDir:installRoot,engineId:"node-red",fs:ports});
 const a=Buffer.from("valid isolated archive alpha"),b=Buffer.from("valid isolated archive beta");
 const pack=(name:string,bytes:Buffer)=>({...meta(name),sha256:createHash("sha256").update(bytes).digest("hex")});
 const parallel=await Promise.all([
   i1.installFromBytes(pack("node-red-contrib-alpha",a),a),
   i2.installFromBytes(pack("node-red-contrib-beta",b),b),
 ]);
 ck("两个同目录并发真实包发布都完成且没有死锁",parallel.every(x=>x.ok),parallel);
 const deployed=await i1.readState();
 ck("真实并发发布同一清单保留双记录",deployed.kind==="ok"&&deployed.entries.length===2,deployed);
 ck("并发安装 alpha 原始字节完整",(await readFile(join(i1.packagePath("node-red-contrib-alpha"),"package.tgz"))).equals(a));
 ck("并发安装 beta 原始字节完整",(await readFile(join(i2.packagePath("node-red-contrib-beta"),"package.tgz"))).equals(b));
 // 卸载与另一个记录更新同时发生，不允许删除成功的插件重新出现在清单中。
 const mixed=await Promise.all([
   i1.uninstall("node-red-contrib-alpha"),
   i2.recordInstall(meta("node-red-contrib-new-approved")),
 ]);
 ck("卸载与另一笔安装登记并发都明确成功",mixed[0].ok&&mixed[1].ok,mixed);
 const final=await i1.readState();
 ck("卸载并发后被撤权的旧包不可复活，合法新包仍在",
   final.kind==="ok"&&final.entries.length===2&&
   !final.entries.some(x=>x.name==="node-red-contrib-alpha")&&
   final.entries.some(x=>x.name==="node-red-contrib-new-approved"),final);
} finally {await rm(root,{recursive:true,force:true});}
console.log("engine-node-concurrency-smoke:"+(t-f)+"/"+t);if(f)process.exitCode=1;
