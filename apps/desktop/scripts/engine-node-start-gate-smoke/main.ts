/** ARC-006: engine must never start when on-disk plugin approval/recovery checks fail. */
import { registerWorkflowEngineHandlers } from "@main/ipc/workflowEngine.js";
import { IPC } from "@contracts/ipc";
import { clearRpcHandlers } from "@main/appControl/registry.js";
let n=0,fail=0;function check(s:string,b:boolean,d?:unknown){n++;console.log((b?"  ok   ":"  FAIL ")+s+(b?"":" "+JSON.stringify(d)));if(!b)fail++;}
const calls=new Map<string,(event:unknown,raw:unknown)=>unknown>();
const fakeIpc={handle(ch:string,fn:(event:unknown,raw:unknown)=>unknown){calls.set(ch,fn);}};
let started=0,validated=0,ready=false,specs=0;
const runtime={
  status:()=>({engineId:"node-red",state:"stopped",port:null,reason:null}),
  start:async()=>{started++;return {engineId:"node-red",state:"running",port:4123,reason:null};},
  stop:async()=>({engineId:"node-red",state:"stopped",port:null,reason:null}),
};
clearRpcHandlers();
registerWorkflowEngineHandlers(fakeIpc as never,{
  registry:{get:(id)=>id==="node-red"?runtime as never:null,ids:()=>["node-red"]},
  beforeStart:async()=>{validated++;if(!ready)throw Error("engine nodes need crash recovery before spawn");},
  launchSpec:()=>{specs++;return {command:"fixture",args:()=>[],dataDir:"fixture"};},
});
const start=async()=>await calls.get(IPC.WORKFLOW_ENGINE_START)!(null,{engineId:"node-red"}) as {ok:boolean;reason?:string};
const denied=await start();
check("恢复/审批账本异常时引擎启动必须拒绝",denied.ok===false && /crash recovery/.test(denied.reason??""),denied);
check("拒绝必须发生在构造启动参数和 spawn 之前",started===0&&specs===0,{started,specs});
check("启动门闸实际被调用",validated===1,validated);
ready=true;
const allowed=await start();
check("恢复闸门通过以后合法引擎可启动",allowed.ok===true,allowed);
check("恢复门闸通过的启动恰好执行一次",started===1&&specs===1&&validated===2,{started,specs,validated});
console.log("engine-node-start-gate-smoke:"+(n-fail)+"/"+n);if(fail)process.exitCode=1;
