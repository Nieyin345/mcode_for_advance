import {installEngineNode} from "../../src/main/workflowEngines/engineNodeInstallRoute.js";
import type {EngineNodeRegistry} from "../../src/main/workflowEngines/engineNodeRegistry.js";
let pass=0,fail=0;
const test=(name:string,yes:boolean,detail:unknown)=>{console.log((yes?"PASS ":"FAIL ")+name+" "+JSON.stringify(detail));yes?pass++:fail++;};
const evil=Object.create(null);
const meta={name:"node-red-contrib-fixture",version:"1.0.0",source:"fixture://vendor",sha256:"a".repeat(64),license:"MIT",capabilities:["network"]};
let reads=0,installs=0;
const make=(handlers:{readState?:()=>Promise<unknown>;installFromDirectory?:()=>Promise<unknown>}={}):EngineNodeRegistry=>({
async readState(){reads++;return handlers.readState?await handlers.readState():{kind:"absent"};},
async installFromDirectory(){installs++;return handlers.installFromDirectory?await handlers.installFromDirectory():{ok:true,entry:{name:meta.name,sha256:meta.sha256}};}
} as unknown as EngineNodeRegistry);
const run=(registry:EngineNodeRegistry,approval:()=>Promise<boolean>)=>installEngineNode({registry,sourceDir:"/fixture/source",meta,approval});
{
const registry=make();let result:unknown=null,escaped=false;
try{result=await run(registry,async()=>{throw evil;});}catch{escaped=true;}
test("hostile approval error stays a typed denial, never an escaped TypeError",!escaped&&(result as {code?:string}|null)?.code==="approval_denied",result);
test("hostile approval never writes executable node files",installs===0,installs);
}
{
const registry=make({readState:async()=>{throw evil;}});
let result:unknown=null,escaped=false;let approvals=0;
try{result=await run(registry,async()=>{approvals++;return true;});}catch{escaped=true;}
test("unreadable registry metadata fails closed before asking approval",!escaped&&(result as {code?:string}|null)?.code==="invalid",result);
test("unreadable registry never prompts human or installs",approvals===0&&installs===0,{approvals,installs});
}
{
const registry=make({installFromDirectory:async()=>{throw evil;}});
let result:unknown=null,escaped=false;
try{result=await run(registry,async()=>true);}catch{escaped=true;}
test("registry install throwing fails closed with explicit failure code",!escaped&&(result as {code?:string}|null)?.code==="install_failed",result);
}
{
const before=installs;const registry=make();const result=await run(registry,async()=>true);
test("valid human approval still installs through native registry",result.ok===true&&installs===before+1,result);
}
{
const before=installs;const registry=make();const result=await run(registry,async()=>false);
test("negative human approval denies and never installs",result.ok===false&&result.code==="approval_denied"&&installs===before,result);
}
// A package already in pending-remove was explicitly revoked. Even the same
// hash cannot be reinstalled while cleanup is underway, regardless of a
// stale card's affirmative response.
{
  let approvals=0, installed=0;
  const state={kind:"ok",entries:[{name:meta.name,sha256:meta.sha256,state:"pending-remove",approvedByUser:true}]};
  const registry={
    readState:async()=>state,
    installFromDirectory:async()=>{installed++;return {ok:true,entry:{name:meta.name}};},
  } as unknown as EngineNodeRegistry;
  const result=await run(registry,async()=>{approvals++;return true;});
  test("★ revoked pending-remove package refuses reinstallation",!result.ok,result);
  test("★ pending-remove never opens a stale install approval or writes",approvals===0&&installed===0,{approvals,installed});
}
// The user reviewed a particular registry state. While that card was open,
// another writer installed a different executable under the same name.
{
  let state:unknown={kind:"absent",entries:[]},installed=0,asked=0;
  const registry={
    readState:async()=>state,
    installFromDirectory:async()=>{installed++;return {ok:true,entry:{name:meta.name}};},
  } as unknown as EngineNodeRegistry;
  const result=await run(registry,async()=>{
    asked++;
    state={kind:"ok",entries:[{name:meta.name,sha256:"b".repeat(64),state:"installed",approvedByUser:true}]};
    return true;
  });
  test("★ approval bound to old absent registry rejects concurrent replacement",!result.ok,{result,asked});
  test("★ changed registry prevents writing even after stale positive click",asked===1&&installed===0,{asked,installed});
}
// Revocation may happen while the approval promise is pending. A positive
// response obtained before revocation must never resurrect the same hash.
{
  let state:unknown={kind:"ok",entries:[{name:meta.name,sha256:meta.sha256,state:"installed",approvedByUser:true}]};
  let writes=0;
  const registry={
    readState:async()=>state,
    installFromDirectory:async()=>{writes++;return {ok:true,entry:{name:meta.name}};},
  } as unknown as EngineNodeRegistry;
  const result=await run(registry,async()=>{
    state={kind:"ok",entries:[{name:meta.name,sha256:meta.sha256,state:"pending-remove",approvedByUser:true}]};
    return true;
  });
  test("★ revocation during approval invalidates prior decision",!result.ok,result);
  test("★ stale approval cannot reactivate revoked package",writes===0,writes);
}
// The version/hash can stay identical while recorded capabilities or
// approval state change. A stale consent card cannot authorize that record.
{
  let state:unknown={kind:"ok",entries:[{name:meta.name,sha256:meta.sha256,version:"1.0.0",capabilities:["network"],state:"installed",approvedByUser:true}]};
  let installed=0;
  const registry={
    readState:async()=>state,
    installFromDirectory:async()=>{installed++;return {ok:true,entry:{name:meta.name}};},
  } as unknown as EngineNodeRegistry;
  const result=await run(registry,async()=>{
    state={kind:"ok",entries:[{name:meta.name,sha256:meta.sha256,version:"1.0.0",capabilities:["resource.write"],state:"installed",approvedByUser:true}]};
    return true;
  });
  test("★ same-hash changed capabilities invalidate old human consent",!result.ok&&installed===0,{result,installed});
}
// Reading trust a second time can fail while the UI is waiting; never
// downgrade that failure to an absent registry or a successful installation.
{
  let read=0,installed=0;
  const registry={
    readState:async()=>{read++;if(read===2)throw Object.create(null);return {kind:"absent",entries:[]};},
    installFromDirectory:async()=>{installed++;return {ok:true,entry:{name:meta.name}};},
  } as unknown as EngineNodeRegistry;
  const result=await run(registry,async()=>true);
  test("★ approval-time registry read failure must fail closed",!result.ok&&installed===0,{result,read,installed});
}
// An executable package manifest is not a free-form data document. Oversized
// strings and capability floods must be denied BEFORE allocating a renderer
// approval card; even when the eventual registry would reject these values.
for(const [label,variant] of [
  ["oversized source", {...meta,source:"s".repeat(8192)}],
  ["oversized capability list", {...meta,capabilities:Array.from({length:129},()=> "network")}],
  ["oversized capability name", {...meta,capabilities:["n".repeat(512)]}],
] as const){
  let approvals=0,installed=0;
  const registry={
    readState:async()=>({kind:"absent",entries:[]}),
    installFromDirectory:async()=>{installed++;return {ok:true,entry:{name:meta.name}};},
  } as unknown as EngineNodeRegistry;
  const result=await installEngineNode({registry,sourceDir:"/fixture/source",meta:variant,approval:async()=>{approvals++;return true;}});
  test("★ "+label+" is rejected before allocating install approval card",!result.ok&&result.code==="invalid"&&approvals===0&&installed===0,{result,approvals,installed});
}
// Positive regression: a stable, already-installed same-hash package is
// still allowed through explicit fresh human approval. This verifies the
// snapshot guard isn't merely denying ALL legitimate reinstall operations.
{
  const stable={kind:"ok",entries:[{name:meta.name,sha256:meta.sha256,version:"1.0.0",state:"installed",approvedByUser:true,capabilities:["network"]}]};
  let reads=0,approved=0,installed=0;
  const registry={
    readState:async()=>{reads++;return stable;},
    installFromDirectory:async()=>{installed++;return {ok:true,entry:{name:meta.name}};},
  } as unknown as EngineNodeRegistry;
  const result=await run(registry,async()=>{approved++;return true;});
  test("★ unchanged approved same-hash reinstall remains possible after a fresh human click",
    result.ok===true&&approved===1&&reads===2&&installed===1,{result,approved,reads,installed});
}
console.log(`node-install-approval-error-smoke: ${pass}/${pass+fail}`);if(fail)process.exitCode=1;