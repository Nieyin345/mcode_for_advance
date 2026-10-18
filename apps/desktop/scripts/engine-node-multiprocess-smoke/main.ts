/** ARC-006 Gate E: real independent OS Node processes must not silently overwrite engine-nodes.json.
 * Uses only a fresh mkdtemp fixture and child Node workers; never opens user project / Node-RED. */
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineNodeRegistry } from "@main/workflowEngines/engineNodeRegistry.js";

const meta=(name:string)=>({
 name,version:"1.0.0",source:"fixture",sha256:createHash("sha256").update(name).digest("hex"),
 license:"MIT",capabilities:[],approvedByUser:true,
});
const registry=(path:string)=>new EngineNodeRegistry({dataDir:path,engineId:"node-red"});
let tests=0,failures=0;
function check(s:string,c:boolean,detail?:unknown):void{
 tests++;console.log((c?"  ok   ":"  FAIL ")+s+(c?"":" "+JSON.stringify(detail)));if(!c)failures++;
}
async function main():Promise<void>{
 const temp=await mkdtemp(join(tmpdir(),"mcode-nodes-cross-process-"));
 try {
  const r=registry(temp);const seed=await r.recordInstall(meta("node-red-contrib-seed"));
  check("一条批准记录的初始磁盘正控",seed.ok);
  for(let round=0;round<2;round++){
   const count=9;
   const names=Array.from({length:count},(_,i)=>"node-red-contrib-os-"+round+"-"+i);
   const workers:ChildProcess[]=[];
   const waitReady:Promise<void>[]=[];
   const waitResult:Promise<{ok:boolean;reason?:string}>[]=[];
   try {
    for(const name of names){
     const child=fork(process.argv[1]!,["--worker",temp,name],{execArgv:[],stdio:["ignore","pipe","pipe","ipc"]});
     workers.push(child);
     let readyResolve!:(v:void)=>void,readyReject!:(error:Error)=>void;
     waitReady.push(new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}));
     let resultResolve!:(v:{ok:boolean;reason?:string})=>void,resultReject!:(error:Error)=>void;
     waitResult.push(new Promise((resolve,reject)=>{resultResolve=resolve;resultReject=reject;}));
     child.on("message",(msg:unknown)=>{
       if(msg==="ready") readyResolve();
       else if(typeof msg==="object"&&msg!==null&&"result" in msg){
         resultResolve((msg as {result:{ok:boolean;reason?:string}}).result);
       }
     });
     child.on("error",(err)=>{readyReject(err);resultReject(err);});
     child.on("exit",(code)=>{
       if(code!==0){
         const err=new Error("Worker "+name+" exit "+code);
         readyReject(err);resultReject(err);
       }
     });
    }
    await Promise.race([Promise.all(waitReady),new Promise((_,reject)=>setTimeout(()=>reject(Error("worker startup timed out")),20000))]);
    for(const child of workers) child.send("go");
    const results=await Promise.race([
     Promise.all(waitResult),
     new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("worker write timed out")),22000)),
    ]);
    check("第"+(round+1)+"批 9 个独立 OS 进程各自认为保存成功",results.every(x=>x.ok),results);
    const state=await r.readState();
    const expected=1+(round+1)*count;
    check("第"+(round+1)+"批真实磁盘清单全部 "+expected+" 条均保留且无同名",
      state.kind==="ok"&&state.entries.length===expected&&
      names.every(n=>state.entries.some(x=>x.name===n))&&
      new Set(state.entries.map(x=>x.name)).size===state.entries.length,
      state.kind==="ok"?state.entries.map(x=>x.name):state);
   }finally{for(const child of workers)if(!child.killed)child.kill();}
  }
  // Deliberately simulate a prior crashed owner. Never reclaim/delete its lock.
  const lock=join(temp,"engine-nodes.json.lock");
  await mkdir(lock);
  await writeFile(join(lock,"SENTINEL"),"OTHER_OS_PROCESS_LOCK_CONTENT");
  let refused=false;let reason="";
  try{
    const result=await r.recordInstall(meta("node-red-contrib-blocked"));
    refused=!result.ok;reason=result.ok?"":result.reason;
  }catch(error){refused=true;reason=String(error);}
  check("旧锁尚存在时不能绕过另一个 OS 进程的修改事务",refused && /lock|占用|锁|忙|超时|EEXIST/i.test(reason),reason);
  check("拒绝写不销毁其他进程的 lock 内容",
     (await readFile(join(lock,"SENTINEL"),"utf8"))==="OTHER_OS_PROCESS_LOCK_CONTENT");
  const state=await r.readState();
  check("旧锁拒绝路径不会凭空登记一个未批准新包",state.kind==="ok"&&!state.entries.some(x=>x.name==="node-red-contrib-blocked"));
  await rm(lock,{recursive:true});
  const written=await r.recordInstall(meta("node-red-contrib-after-lock"));
  check("用户人工清理旧锁后可恢复正常更新",written.ok,written);
  const trailing=(await readdir(temp)).filter(x=>x.includes(".lock"));
  check("本次更新不遗留任何自有锁目录",trailing.length===0,trailing);
 }finally{await rm(temp,{recursive:true,force:true});}
 console.log("engine-node-multiprocess-smoke:"+(tests-failures)+"/"+tests);
 if(failures)process.exitCode=1;
}
if(process.argv[2]==="--worker"){
 const path=process.argv[3]!,name=process.argv[4]!;
 process.on("message",async(message:unknown)=>{
  if(message!=="go")return;
  try{
   const r=await registry(path).recordInstall(meta(name));
   process.send?.({result:r});
   setTimeout(()=>process.exit(0),15);
  }catch(error){
   process.send?.({result:{ok:false,reason:error instanceof Error?error.message:String(error)}});
   setTimeout(()=>process.exit(0),15);
  }
 });
 process.send?.("ready");
}else{
 await main();
}
