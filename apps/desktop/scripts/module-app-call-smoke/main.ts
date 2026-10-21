import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ModuleHost } from "../../src/main/modules/ModuleHost.js";
import { fileCapabilities } from "../../src/main/modules/fileCapabilities.js";
import { configureJsOnlyEgressConsentReader, permissionedFailure } from "../../src/main/modules/permissionedProcessRunner.js";
import { EXAMPLE_MODULE, ModuleManifestSchema, type ModuleManifest } from "@contracts/modules";

let passed=0, failed=0;
async function check(name:string, run:()=>Promise<void>|void) {
  try {await run();passed++;console.log("PASS "+name);}
  catch(error){failed++;console.error("FAIL "+name,error);}
}
const testDir=mkdtempSync(join(process.cwd(),".tmp","t49-fixture-"));
const file=join(testDir,"sample.txt"), content="A real T49 file from a confined test fixture.";
writeFileSync(file,content,"utf8");
configureJsOnlyEgressConsentReader(()=>true);
let archive:string|null=null, approvals=0, dispatched=0, longStarted:()=>void=()=>{};
let blockLong=false, observedAbort=false;
const host=new ModuleHost({
  authorize:async()=>{},
  resolveResource:async r=>r.path,
  verifyProgram:async()=>({ok:true}),
  persist:async()=>{},
  readModulePermissions:()=>archive,
  persistModulePermissions:async value=>{archive=value;},
  requestApproval:async()=>{approvals++;throw Error("must not prompt for granted RPC");},
  invokeAppCall:async(_module,method,input,signal)=>{
    dispatched++;
    if(method==="file.readFile"){
      assert.equal((input as {filePath:string}).filePath,file);
      return {content:readFileSync(file,"utf8")};
    }
    if(method==="claude.sendTurn") {
      if(!blockLong)return {text:"Hello from the fake AI provider."};
      longStarted();
      await new Promise<void>(resolve=>{
        if(signal.aborted){observedAbort=true;return resolve();}
        signal.addEventListener("abort",()=>{observedAbort=true;resolve();},{once:true});
      });
      return {text:"late result"};
    }
    throw Error("unexpected unguarded method: "+method);
  },
});
for(const builtin of fileCapabilities(()=>true))host.register(builtin);
const base=EXAMPLE_MODULE.contributions[0]!;
const allowedSource='({run:async(resource)=>{const f=await mcode.api.call("file.readFile",{filePath:resource.path});const a=await mcode.api.call("claude.sendTurn",{sessionId:"fake",prompt:"hello"});return {bytes:f.content.length,answer:a.text};}})';
const sourceFor=(method:string):string=>'({run:async(resource)=>{await mcode.api.call("'+method+'",{projectPath:resource.projectPath,path:resource.path});return {ok:true};}})';
const grants=["files.read","resource.read","session.send","code.execute"] as const;
const manifest=(source:string,version="1.0.0",timeoutMs=8000):ModuleManifest=>ModuleManifestSchema.parse({
 ...EXAMPLE_MODULE,id:"user.t49-bridge",version,permissions:[...grants],
 contributions:[{...base,capability:"module.run"}],
 program:{source,timeoutMs},
});
const input=(id:string)=>({moduleId:"user.t49-bridge",contributionId:base.id,requestId:id,
 resource:{projectPath:testDir,path:file}});
try {
 await check("core.app.call is a registered action owned by the host",()=>{
   const cap=host.catalog().capabilities.find(x=>x.id==="core.app.call");
   assert.equal(cap?.kind,"action");
 });
 await check("extension calls file.readFile and claude.sendTurn twice over live NDJSON, without approval",async()=>{
   await host.install(manifest(allowedSource),grants);
   const response=await host.invoke(input("two-calls"));
   assert.equal(response.type,"result");
   if(response.type!=="result")throw Error("missing result");
   assert.equal(response.value.bytes,content.length);
   assert.equal(response.value.answer,"Hello from the fake AI provider.");
   assert.equal(dispatched,2);
   assert.equal(approvals,0);
 });
 await check("an ungranted method names its missing permission and never dispatches",async()=>{
   await host.install(manifest(sourceFor("git.push"),"1.0.1"),grants);
   await assert.rejects(host.invoke(input("ungranted")),/git.write/);
   assert.equal(dispatched,2);
 });
 await check("a blocked method is never delegated even with broad installed grants",async()=>{
   await host.install(manifest(sourceFor("claude.approve"),"1.0.2"),grants);
   await assert.rejects(host.invoke(input("blocked")),/不可委托|blocked/);
   assert.equal(dispatched,2);
 });
 await check("Node permission denies child_process inside the child",async()=>{
   await host.install(manifest('({run:async()=>{require("node:child_process").execSync("echo illegal");return {ok:true};}})',"1.0.3"),grants);
   await assert.rejects(host.invoke(input("child-denied")),/restricted|denied|permission|Access|ERR_ACCESS/i);
 });
 await check("network guard refuses HTTP egress from the permissioned child",async()=>{
   await host.install(manifest('({run:async()=>{require("node:http").get("http://127.0.0.1:1");return {ok:true};}})',"1.0.4"),grants);
   await assert.rejects(host.invoke(input("http-denied")),/network_access_denied|denied|permission/);
 });
 await check("RPC request count is capped at 128",async()=>{
   const before=dispatched;
   const src='({run:async(resource)=>{for(let i=0;i<129;i++)await mcode.api.call("file.readFile",{filePath:resource.path});return {ok:true};}})';
   await host.install(manifest(src,"1.0.5"),grants);
   await assert.rejects(host.invoke(input("rpc-count-limit")),/128 calls/);
   assert.equal(dispatched-before,128);
 });
 await check("RPC concurrency is capped at eight in-flight calls",async()=>{
   const before=dispatched;
   const src='({run:async()=>{await Promise.all(Array.from({length:9},()=>mcode.api.call("claude.sendTurn",{sessionId:"fake",prompt:"parallel"})));return {ok:true};}})';
   await host.install(manifest(src,"1.0.6"),grants);
   await assert.rejects(host.invoke(input("rpc-concurrency-limit")),/8 concurrent/);
   assert.equal(dispatched-before,8);
 });
 await check("a single RPC request above 64 KiB is refused before dispatch",async()=>{
   const before=dispatched;
   const src='({run:async()=>{await mcode.api.call("claude.sendTurn",{sessionId:"fake",prompt:"x".repeat(65500)});return {ok:true};}})';
   await host.install(manifest(src,"1.0.7"),grants);
   await assert.rejects(host.invoke(input("rpc-size-limit")),/64 KiB/);
   assert.equal(dispatched,before);
 });
 await check("extension stdout above 256 KiB fails closed",async()=>{
   const src='({run:async()=>{process.stdout.write("x".repeat(300000));return {ok:true};}})';
   await host.install(manifest(src,"1.0.8"),grants);
   await assert.rejects(host.invoke(input("output-size-limit")),error=>permissionedFailure(error)?.code==="isolated_crash");
 });
 await check("the existing program timeout still terminates the duplex child",async()=>{
   const src='({run:async()=>{await new Promise(()=>{});return {ok:true};}})';
   await host.install(manifest(src,"1.0.9",100),grants);
   await assert.rejects(host.invoke(input("timeout-limit")),error=>permissionedFailure(error)?.code==="isolated_timeout");
 });
 await check("AI guide pattern runs a generated file-summary extension",async()=>{
   const before=dispatched;
   const src='({run:async(resource)=>{const f=await mcode.api.call("file.readFile",{filePath:resource.path});const a=await mcode.api.call("claude.sendTurn",{sessionId:"fake",prompt:"Summarize this file in one sentence: "+f.content});return {bytes:f.content.length,summary:a.text};}})';
   await host.install(manifest(src,"1.0.10"),grants);
   const response=await host.invoke(input("ai-guide-generated"));
   assert.equal(response.type,"result");
   if(response.type!=="result")throw Error("missing AI guide result");
   assert.equal(response.value.bytes,content.length);
   assert.equal(response.value.summary,"Hello from the fake AI provider.");
   assert.equal(dispatched-before,2);
 });
 await check("revoking a grant aborts the child during a slow claude.sendTurn",async()=>{
   const src='({run:async()=>{const answer=await mcode.api.call("claude.sendTurn",{sessionId:"fake",prompt:"slow"});return {answer:answer.text};}})';
   await host.install(manifest(src,"1.0.11"),grants);
   blockLong=true;
   let ready!:()=>void;
   const begun=new Promise<void>(resolve=>{ready=resolve;});
   longStarted=ready;
   const running=host.invoke(input("slow-session")).then(()=>({ok:true as const,error:null}),error=>({ok:false as const,error}));
   await Promise.race([begun,new Promise<void>((_,reject)=>setTimeout(()=>reject(Error("long call did not reach fake provider")),4000))]);
   await host.setPermissions({moduleId:"user.t49-bridge",grantedPermissions:["files.read","resource.read","code.execute"]});
   const terminal=await running;
   assert.equal(terminal.ok,false);
   assert.equal(permissionedFailure(terminal.error)?.code,"isolated_cancelled");
   assert.equal(observedAbort,true);
 });
}finally {
 configureJsOnlyEgressConsentReader(null);
 rmSync(testDir,{recursive:true,force:true});
}
console.log("module-app-call-smoke: "+passed+" pass, "+failed+" fail");
if(failed)process.exitCode=1;
