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
console.log(`node-install-approval-error-smoke: ${pass}/${pass+fail}`);if(fail)process.exitCode=1;