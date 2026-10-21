/** MC-035 OS capability/fail-closed regression and malicious-bootstrap probes. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, linkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { configureEgressConsentStoragePath, getJsOnlyEgressConsent, setJsOnlyEgressConsent } from "../../src/main/modules/egressConsent.js";
import {
  diagnoseEgressIsolation, verifyPermissionedProgram,
  runPermissionedProcess, permissionedFailure, egressMode, requireNetworkExtensionSupport,
  configureJsOnlyEgressConsentReader,
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
check("Linux no-network still selects verified OS isolation","os-sandbox",egressMode("linux",false));
check("macOS no-network still selects verified OS isolation","os-sandbox",egressMode("darwin",false));
check("Explicit approval bypasses network guard on all platforms","explicitly-approved",egressMode("win32",true));
if (process.platform === "win32") {
  check("Windows never claims unsupported AppContainer/WFP isolation",false,diagnostic.supported);
  check("Windows no-network chooses only JS guard","js-guard-only",egressMode("win32",false));
  let rejection="";
  try {requireNetworkExtensionSupport();}catch(e){rejection=String(e);}
  check("Declared network permission is rejected on unsupported Windows",true,
    /egress_isolation_unavailable.*Windows.*OS 网络沙箱/.test(rejection));
} else {
  check("non-Windows capability probe returns explicit support or failure",true,
    diagnostic.supported || /egress_isolation_unavailable/.test(diagnostic.detail));
}
const benignSource='({ inspect: async () => ({text:"UNTRUSTED_EXECUTED"}) })';
const consentDir=mkdtempSync(join(tmpdir(),"mc035-user-consent-"));
const consentPath=join(consentDir,"ui-modules","js-only-egress-consent.json");
configureEgressConsentStoragePath(consentPath);
configureJsOnlyEgressConsentReader(getJsOnlyEgressConsent);
check("new consent store is disabled by default",false,getJsOnlyEgressConsent());
const deniedByDefault=await verifyPermissionedProgram(benignSource,["inspect"]);
if (process.platform === "win32") {
  check("Windows without persisted consent rejects install before eval",true,
    !deniedByDefault.ok && /egress_isolation_unavailable/.test(deniedByDefault.reason));
  const deniedInvocation=await runPermissionedProcess({
    source:benignSource,capability:"inspect",
    resource:{path:"not-a-real-file",projectPath:"."},
    allowWrite:false,timeoutMs:4000,signal:new AbortController().signal,
  }).then(()=>null,error=>error);
  check("Windows default-deny rejects execution with isolated_denied",true,
    permissionedFailure(deniedInvocation)?.code==="isolated_denied"
    && /egress_isolation_unavailable/.test(String(deniedInvocation)));
  await setJsOnlyEgressConsent(true);
  check("explicit user risk approval is durably recorded",true,getJsOnlyEgressConsent());
  // Re-install the reader simulates a fresh service instance reading the file.
  configureJsOnlyEgressConsentReader(getJsOnlyEgressConsent);
  check("saved consent persists across reader recreation",true,getJsOnlyEgressConsent());
  const verify=await verifyPermissionedProgram(benignSource,["inspect"]);
  check("Windows JS-guard-only factory verification succeeds only after consent",true,verify.ok);
  const attempt = await runPermissionedProcess({
    source:'({inspect:async()=>({text:"normal"})})',
    capability:"inspect",resource:{path:"not-a-real-file",projectPath:"."},
    allowWrite:false,timeoutMs:4000,signal:new AbortController().signal,
  }).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
  check("Windows benign extension executes with explicit JS-only diagnostic",true,
    attempt.ok && attempt.value?.text==="normal" &&
    attempt.value?._mcodeEgressIsolation==="js-guard-only; OS egress isolation unavailable");
  const blocked = await runPermissionedProcess({
    source:'({inspect:async()=>{try{require("node:net").connect(9,"127.0.0.1");return {text:"CONNECTED"}}catch(e){return {text:String(e.message)}}}})',
    capability:"inspect",resource:{path:"not-a-real-file",projectPath:"."},
    allowWrite:false,timeoutMs:4000,signal:new AbortController().signal,
  }).then(value=>value,error=>({text:String(error)}));
  check("Windows no-network execution enforces production NETWORK_GUARD",true,
    String(blocked.text).includes("network_access_denied") &&
    "_mcodeEgressIsolation" in blocked &&
    blocked._mcodeEgressIsolation==="js-guard-only; OS egress isolation unavailable");
  await setJsOnlyEgressConsent(false);
  check("disable switch revokes persisted approval",false,getJsOnlyEgressConsent());
  const revoked=await verifyPermissionedProgram(benignSource,["inspect"]);
  check("revoking consent immediately rejects new installs",true,
    !revoked.ok && /egress_isolation_unavailable/.test(revoked.reason));
  writeFileSync(consentPath,"{corrupt","utf8");
  check("corrupt consent archive cannot silently grant execution",false,getJsOnlyEgressConsent());
  await setJsOnlyEgressConsent(true);
  check("explicit reapproval writes a valid archive",true,getJsOnlyEgressConsent());
  const other=join(consentDir,"external-consent.json");
  writeFileSync(other,'{"version":1,"enabled":true}',"utf8");
  // Link substitution must NOT smuggle in somebody else's approval record.
  rmSync(consentPath);
  linkSync(other,consentPath);
  check("hardlinked approval archive is rejected",false,getJsOnlyEgressConsent());
} else if (!diagnostic.supported) {
  check("failed OS capability probe must reject factory installation",true,
    !deniedByDefault.ok && /egress_isolation_unavailable/.test(deniedByDefault.reason));
  const attempt = await runPermissionedProcess({
    source:'({inspect:async()=>({text:"UNTRUSTED_EXECUTED"})})',
    capability:"inspect",resource:{path:"not-a-real-file",projectPath:"."},
    allowWrite:false,timeoutMs:2500,signal:new AbortController().signal,
  }).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
  check("failed OS capability probe must reject invocation BEFORE factory",true,
    !attempt.ok && permissionedFailure(attempt.error)?.code==="isolated_denied" &&
    /egress_isolation_unavailable/.test(String(attempt.error)));
} else {
  check("verified OS sandbox accepts a benign factory",true,deniedByDefault.ok);
  const result = await runPermissionedProcess({
    source:'({inspect:async()=>({text:"allowed-inside-OS-sandbox"})})',
    capability:"inspect",resource:{path:"not-a-real-file",projectPath:"."},
    allowWrite:false,timeoutMs:3000,signal:new AbortController().signal,
  }).then(value=>value.text,error=>String(error));
  check("real isolated process runs benign extension","allowed-inside-OS-sandbox",result);
}

configureJsOnlyEgressConsentReader(null);
configureEgressConsentStoragePath(null);
rmSync(consentDir,{recursive:true,force:true});

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
