/** MC-035 OS capability/fail-closed regression and malicious-bootstrap probes. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  diagnoseEgressIsolation, verifyPermissionedProgram,
  runPermissionedProcess, permissionedFailure,
} from "../../src/main/modules/permissionedProcessRunner.js";

let total = 0, failed = 0;
function check(name: string, expected: unknown, actual: unknown) {
  total++;
  if (!Object.is(expected,actual)) failed++;
  console.log((Object.is(expected,actual)?"  ok   ":"  FAIL ") +name+
    " expected="+JSON.stringify(expected)+" actual="+JSON.stringify(actual));
}
const diagnostic = await diagnoseEgressIsolation();
console.log("os-egress-capability: "+JSON.stringify(diagnostic));
if (process.platform === "win32") {
  check("Windows never claims unsupported AppContainer/WFP isolation",false,diagnostic.supported);
} else {
  check("non-Windows capability probe returns explicit support or failure",true,
    diagnostic.supported || /egress_isolation_unavailable/.test(diagnostic.detail));
}
const verify = await verifyPermissionedProgram('({ inspect: async () => ({text:"UNTRUSTED_EXECUTED"}) })',["inspect"]);
if (process.platform === "win32" || !diagnostic.supported) {
  check("failed OS capability probe must reject factory installation",true,
    !verify.ok && /egress_isolation_unavailable/.test(verify.reason));
  const attempt = await runPermissionedProcess({
    source:'({inspect:async()=>({text:"UNTRUSTED_EXECUTED"})})',
    capability:"inspect",resource:{path:"not-a-real-file",projectPath:"."},
    allowWrite:false,timeoutMs:2500,signal:new AbortController().signal,
  }).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
  check("failed OS capability probe must reject invocation BEFORE factory",true,
    !attempt.ok && permissionedFailure(attempt.error)?.code==="isolated_denied" &&
    /egress_isolation_unavailable/.test(String(attempt.error)));
} else {
  check("verified OS sandbox accepts a benign factory",true,verify.ok);
  const result = await runPermissionedProcess({
    source:'({inspect:async()=>({text:"allowed-inside-OS-sandbox"})})',
    capability:"inspect",resource:{path:"not-a-real-file",projectPath:"."},
    allowWrite:false,timeoutMs:3000,signal:new AbortController().signal,
  }).then(value=>value.text,error=>String(error));
  check("real isolated process runs benign extension","allowed-inside-OS-sandbox",result);
}

// Extract the exact production bootstrap; do not create a fake or copy of the guard.
const source = readFileSync(resolve(process.cwd(),"src/main/modules/permissionedProcessRunner.ts"),"utf8");
const begin = source.indexOf("const NETWORK_GUARD = String.raw`");
const open = source.indexOf("`",begin);
const end = source.indexOf("`;",open+1);
if (begin<0 || end<0) throw Error("Cannot find real NETWORK_GUARD source");
const guard=source.slice(open+1,end);
const env={...process.env,ELECTRON_RUN_AS_NODE:"1",NODE_OPTIONS:""};
function child(script:string) {
  return spawnSync(process.execPath,["--permission","-e",script],{
    encoding:"utf8",timeout:3000,env,maxBuffer:65536,
  });
}
const setupFailure=child(
  'Object.defineProperty(require("node:net"),"connect",{writable:false,configurable:false});\n'+
  guard+'\nconsole.log("UNTRUSTED_EXECUTED");',
);
check("failed guard setup exits nonzero",true,setupFailure.status!==0);
check("failed guard setup diagnostics reach stderr",true,/network_guard_setup_failed/.test(setupFailure.stderr));
check("failed guard setup never executes extension",false,/UNTRUSTED_EXECUTED/.test(setupFailure.stdout));
const bypass=child('Object.defineProperty(require("node:net"),"connect",{writable:false});\n'+
  'console.log("UNTRUSTED_EXECUTED");');
check("mutation control: without guard code the extension WOULD run",true,
  bypass.status===0 && bypass.stdout.includes("UNTRUSTED_EXECUTED"));
const tampered=child(guard+
  '\nrequire("node:net").connect=function unsafe(){};'+
  '\ntry{mcodeNetworkGuardSelfCheck();console.log("CHECK_PASSED");}catch(e){'+
  'console.error("network_guard_integrity_failed: "+String(e));process.exitCode=78;}');
check("post-install guard invariant detects tampering",true,
  tampered.status===78 && /network_guard_integrity_failed/.test(tampered.stderr) &&
  !tampered.stdout.includes("CHECK_PASSED"));

// Five independent production-child methods, not a raw node --permission proxy.
const probe=spawnSync(process.execPath,
  [resolve(process.cwd(),"scripts/mc035-egress-probe/probe-a.mjs")],
  {encoding:"utf8",timeout:35000,env,maxBuffer:65536,cwd:process.cwd()});
check("five-method harness itself exits zero",0,probe.status);
const names=["net.connect","dns.lookup","worker_threads","process.binding(tcp_wrap)","fetch"];
for(const name of names){
  const line=probe.stdout.split(/\r?\n/).find(l=>l.startsWith("method="+name+" result="));
  const actual=line?.slice(("method="+name+" result=").length)??"missing";
  check("5-way denied egress: "+name,"blocked",actual);
}
console.log("mc035-egress-isolation-smoke: "+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
