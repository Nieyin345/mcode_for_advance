import { z } from "zod";
import { makeEngineBridge } from "../../src/main/mcp/engineBridge.js";
let pass=0,fail=0;
const check=(n:string,c:boolean)=>{console.log((c?"PASS ":"FAIL ")+n);if(c)pass++;else fail++;};
let invoked=0,approved=0;
const bridge=makeEngineBridge("fixture",()=>[{name:"write",description:"fixture write",inputSchema:{name:z.string()},handler:async()=>{invoked++;return {content:[{type:"text" as const,text:"ok"}]};}}],new Set<string>());
const options={autoApprove:false};
const sessionId="fixture-session";
const ctx=(requestApproval:()=>Promise<never>)=>({requestApproval}) as never;
let rejected=false;
let result:Awaited<ReturnType<typeof bridge.invokeGated>>|null=null;
try {result=await bridge.invokeGated("write",{name:"file"},sessionId,ctx(async()=>{throw new Error("fixture approval transport disconnected");}),options);}
catch {rejected=true;}
check("approval channel rejection yields structured ToolResult not promise rejection",!rejected&&result?.isError===true);
check("approval-channel exception never executes write handler",invoked===0);
const noApproval=await bridge.invokeGated("write",{name:"file"},sessionId,{} as never,options);
check("missing approval channel fails closed",noApproval.isError===true&&invoked===0);
const malformed=await bridge.invokeGated("write",{name:"file"},sessionId,{requestApproval:async()=>null} as never,options);
check("malformed null approval response also refuses execution",malformed.isError===true&&invoked===0);
const deny=await bridge.invokeGated("write",{name:"file"},sessionId,{requestApproval:async()=>({allow:false})} as never,options);
check("explicit user denial fails closed",deny.isError===true&&invoked===0);
const allow=await bridge.invokeGated("write",{name:"file"},sessionId,{requestApproval:async()=>{approved++;return {allow:true};}} as never,options);
check("approved write is executed once",allow.isError!==true&&invoked===1&&approved===1);
console.log(`engine-bridge-approval-failure-smoke: ${pass}/${pass+fail}`);
if(fail) process.exitCode=1;
