/** MC-037: independent OS Node processes must not lose successfully registered skill markets.
 * All file writes are strictly inside mkdtemp and HOME redirected by run.sh. */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSkillMarket, skillMarketsCorrupt } from "@main/lib/skillMarket.js";

type Result={ok:boolean;error?:string;name?:string};
async function workerMode():Promise<void>{
 const input=process.argv[3]!,name=process.argv[4]!;
 process.on("message",async(message:unknown)=>{
  if(message!=="go")return;
  try{
   const result=await addSkillMarket({kind:"local",ref:input,name});
   process.send?.({result});
  }catch(error){
   process.send?.({result:{ok:false,error:String(error)}});
  }
 });
 process.send?.("ready");
}
async function parentMode():Promise<void>{
 const root=await mkdtemp(join(tmpdir(),"mcode-market-cross-process-"));
 let checks=0;
 const test=(name:string,ok:boolean,detail?:unknown):void=>{
   checks++;console.log((ok?"  ok   ":"  FAIL ")+name+(ok?"":" "+JSON.stringify(detail)));
   assert.ok(ok,name);
 };
 try{
  const recordsRoot=join(root,"records");
  const count=8;
  const children:ChildProcess[]=[];
  const results:Promise<Result>[]=[];
  const ready:Promise<void>[]=[];
  try{
   for(let i=0;i<count;i++){
    const name="market-os-"+i;
    const dir=join(root,"catalog-"+i);
    await mkdir(dir);
    await writeFile(join(dir,"SKILL.md"),"---\nname: fixture-"+i+"\ndescription: Fixture\n---\n");
    const child=fork(process.argv[1]!,["--worker",dir,name],{
      env:{...process.env,MCODE_SKILL_MARKETS_DIR:recordsRoot},
      execArgv:[],stdio:["ignore","ignore","pipe","ipc"]
    });
    children.push(child);
    let onReady!:()=>void,rejectReady!:(err:Error)=>void;
    ready.push(new Promise<void>((resolve,reject)=>{onReady=resolve;rejectReady=reject;}));
    let onResult!:(result:Result)=>void,rejectResult!:(err:Error)=>void;
    results.push(new Promise<Result>((resolve,reject)=>{onResult=resolve;rejectResult=reject;}));
    let stderr="";
    child.stderr?.on("data",(bytes:Buffer)=>{stderr+=bytes.toString("utf8");});
    child.on("message",(msg:unknown)=>{
      if(msg==="ready")onReady();
      if(typeof msg==="object" && msg!==null && "result" in msg) onResult((msg as {result:Result}).result);
    });
    child.on("error",(err)=>{rejectReady(err);rejectResult(err);});
    child.on("exit",(code)=>{
      if(code!==0){const e=new Error(name+" exited "+code+" "+stderr);rejectReady(e);rejectResult(e);}
    });
   }
   await Promise.race([Promise.all(ready),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("workers never ready")),25000))]);
   for(const child of children)child.send("go");
   const responses=await Promise.race([Promise.all(results),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("workers timed out")),35000))]);
   test("八个独立 Node OS 进程注册市场均成功",responses.every(x=>x.ok),responses);
   const raw=await readFile(join(recordsRoot,"markets.json"),"utf8");
   const parsed=JSON.parse(raw) as {markets:Array<{name:string}>};
   test("独立进程提交的八条来源没有丢失",parsed.markets.length===count && Array.from({length:count},(_,i)=>"market-os-"+i).every(n=>parsed.markets.some(x=>x.name===n)),parsed.markets.map(x=>x.name));
   test("并发写入后完整 JSON 并无重复市场名",new Set(parsed.markets.map(x=>x.name)).size===count);
   test("没有遗留固定进程号 / UUID 临时文件",(await readdir(recordsRoot)).filter(n=>n.startsWith("markets.json.tmp-")).length===0);
  }finally{for(const child of children)if(child.exitCode===null)child.kill();}
  process.env.MCODE_SKILL_MARKETS_DIR=recordsRoot;
  const sentinelLock=join(recordsRoot,".markets-write.lock");
  await mkdir(sentinelLock);
  await writeFile(join(sentinelLock,"owner-sentinel"),"ANOTHER_PROCESS");
  const dir=join(root,"after-lock");
  await mkdir(dir);
  await writeFile(join(dir,"SKILL.md"),"---\nname: after-lock\ndescription: fixture\n---\n");
  const refused=await addSkillMarket({kind:"local",ref:dir,name:"after-lock"});
  test("上次异常的持久锁未解除时 fail closed",!refused.ok && /锁|占用|人工/.test(refused.error??""),refused);
  test("拒绝写入不删除其他进程的锁哨兵",(await readFile(join(sentinelLock,"owner-sentinel"),"utf8"))==="ANOTHER_PROCESS");
  const before=JSON.parse(await readFile(join(recordsRoot,"markets.json"),"utf8")) as {markets:Array<{name:string}>};
  test("拒写没有偷偷登记市场",!before.markets.some(x=>x.name==="after-lock"));
  await rm(sentinelLock,{recursive:true});
  const added=await addSkillMarket({kind:"local",ref:dir,name:"after-lock"});
  test("人工核对后解除锁可恢复合法登记",added.ok,added);
  test("写完自己的锁目录已释放",(await readdir(recordsRoot)).filter(n=>n===".markets-write.lock").length===0);
  test("市场清单仍可正确解析",skillMarketsCorrupt()===null);
  // A junction at the configured market root used to redirect all atomic
  // writes into a different subtree without showing a permission prompt.
  const external=join(root,"external-data-root");
  const alias=join(root,"market-root-junction");
  await mkdir(external);
  const original=Buffer.from("UNRELATED-DATA-MUST-BE-UNCHANGED");
  await writeFile(join(external,"owner-sentinel"),original);
  let linked=true;
  try{await symlink(external,alias,process.platform==="win32"?"junction":"dir");}
  catch(error){linked=false;console.log("  SKIP directory junction unavailable: "+String(error));}
  if(linked){
   process.env.MCODE_SKILL_MARKETS_DIR=alias;
   const result=await addSkillMarket({kind:"local",ref:dir,name:"junction-escape"});
   test("整个技能市场数据根为外部 Junction 时记录写入拒绝",
     !result.ok&&/链接|link|目录|root|junction|symbolic/i.test(result.error??""),result);
   const listed=await readdir(external);
   test("拒绝外链市场根不生成外部 markets.json",!listed.includes("markets.json"),listed);
   test("拒绝外链市场根不改写外部哨兵",
     (await readFile(join(external,"owner-sentinel"))).equals(original));
   process.env.MCODE_SKILL_MARKETS_DIR=recordsRoot;
  }
 }finally{await rm(root,{recursive:true,force:true});}
 console.log("market-multiprocess-smoke:"+checks+"/"+checks);
}
if(process.argv[2]==="--worker"){await workerMode();}else{await parentMode();}
