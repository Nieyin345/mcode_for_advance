/**
 * Original Node-RED 20-inject.js executed in a bounded in-process harness.
 * No Electron, no user flows, no timers actually run. Test the actual upstream
 * once/repeat/cron branches rather than infer behavior only from JSON shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { migrateWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { createConditionTriggerBridge } from "@main/workflowEngines/conditionHostPorts.js";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
let total=0, failed=0;
const check=(name:string,pass:boolean,detail?:unknown)=>{
  total++;
  if(pass) console.log("  ok   "+name);
  else {failed++;console.error("  FAIL "+name,detail);}
};
const manifest=builtinManifestById("mcode.trigger") as NodeTypeManifest;
if(!manifest) throw Error("Production trigger manifest missing");
const doc={
  id:"manual-regression",name:"manual only",builtin:false,updatedAt:1,
  nodes:[{id:"trigger-1",type:"mcode.trigger",title:"Click to run",params:{triggerKind:"manual",task:"do only when clicked"},position:{x:30,y:20}}],
  edges:[],
} as WorkflowDoc;
const flow=migrateWorkflowDoc(doc,{types:new Map([["mcode.trigger",manifest]])});
const config=flow.flow.nodes.find(n=>n["x-mcode"]?.nodeId==="trigger-1") as Record<string,unknown>;
check("真实迁移器生成 inject 节点",config?.["type"]==="inject");
check("手动触发器不允许在部署时 once 自启",config?.["once"]===false);
let scheduled=0;
const timeouts: Array<()=>void>=[];
const jobs: Array<()=>void>=[];
const sent: unknown[]=[];
const errors: unknown[]=[];
const instances=new Map<string,Record<string,unknown>>();
const routes=new Map<string,(req:any,res:any)=>void>();
let injectCtor: ((this:any,config:any)=>void)|null=null;
const RED={
  _: (name:string, args?:{error?:string})=>name + (args?.error ? ": " + args.error : ""),
  settings:{},
  nodes:{
    createNode(node:any,n:any){
      const events=new EventEmitter();
      node.id=n.id;
      node.on=(name:string, fn:Function)=>events.on(name,fn.bind(node));
      node.emit=events.emit.bind(events);
      node.receive=(msg:object={})=>events.emit("input",msg,(output:unknown)=>sent.push(output),()=>{});
      node.send=(output:unknown)=>sent.push(output);
      node.error=(err:unknown)=>{errors.push(String(err));};
      node.debug=()=>{};
      instances.set(n.id,node);
    },
    registerType(name:string,ctor:(this:any,c:any)=>void){if(name==="inject")injectCtor=ctor;},
    getNode(id:string){return instances.get(id)??null;},
  },
  util:{
    evaluateNodeProperty(val:unknown, _type:string,_node:unknown,_msg:object,done:(e:null,v:unknown)=>void){done(null,val);},
    setMessageProperty(msg:Record<string,unknown>,key:string,val:unknown){
      const parts=key.split(".");
      let current:Record<string,unknown>=msg;
      for(const part of parts.slice(0,-1)){
        if(!current[part] || typeof current[part]!=="object")current[part]={};
        current=current[part] as Record<string,unknown>;
      }
      current[parts[parts.length-1]!]=val;
    },
    prepareJSONataExpression(){throw Error("not needed for manual");},
  },
  auth:{needsPermission(permission:string){if(permission!=="inject.write")throw Error("Unexpected permission");return ()=>{};}},
  httpAdmin:{post(path:string,_auth:unknown,handler:(req:any,res:any)=>void){routes.set(path,handler);}},
};
const src=readFileSync(join(process.cwd(),"..","..","node-red/packages/node_modules/@node-red/nodes/core/common/20-inject.js"),"utf8");
const module={exports:undefined as any};
new Function("module","require","setTimeout","setInterval",src)(
  module,(name:string)=>{
    if(name==="cronosjs")return {scheduleTask:(_spec:string,cb:()=>void)=>{jobs.push(cb);return {stop(){}};}};
    throw Error("Unexpected upstream require "+name);
  },
  (fn:()=>void)=>{scheduled++;timeouts.push(fn);return scheduled;},
  ()=>{scheduled++;return scheduled;}
);
module.exports(RED);
check("加载真上游 Node-RED Inject 并注册节点",typeof injectCtor==="function");
(injectCtor as unknown as (this:unknown,c:unknown)=>void).call({},config);
check("部署后无 once 定时器、无周期任务/cron",scheduled===0&&jobs.length===0,
  {scheduled,jobs:jobs.length});
check("部署后没有任何下游执行",sent.length===0,sent);
const route=routes.get("/inject/:id");
check("原生 POST /inject/:id 路由存在，仍经过 inject.write 权限",typeof route==="function");
let httpStatus=0;
route?.({params:{id:config["id"]}},{
  sendStatus(status:number){httpStatus=status;},
});
check("明确点击原生 Inject 后能派发一次",httpStatus===200&&sent.length===1,
  {httpStatus,sent,errors});

// W25: Native custom-UI pre-run fields must be resolved by the SAME Host
// condition service as HookEvent tickets. Only an opaque ticket crosses Inject.
const expression={logic:"and",rules:[{ref:"{{trigger.input.doi}}",op:"equal",value:"10.1000/mcode"}]};
const conditionalDoc={...doc,nodes:[...doc.nodes,{
  id:"condition-1",type:"mcode.condition",title:"Condition",
  params:{expression},position:{x:120,y:20},
}],edges:[{id:"link",from:"trigger-1",to:"condition-1"}]} as WorkflowDoc;
const conditionManifest=builtinManifestById("mcode.condition");
if(!conditionManifest)throw Error("Condition manifest missing");
const manualMigration=migrateWorkflowDoc(conditionalDoc,{types:new Map([
  ["mcode.trigger",manifest],["mcode.condition",conditionManifest],
])});
check("手动输入引用在迁移报告中要求从 Mcode 自定义 UI 发起",
  manualMigration.report.needsHumanDecision.some(issue=>issue.message.includes("【需从 Mcode 自定义 UI 运行】"))
  && !manualMigration.report.lossy.some(issue=>issue.message.includes("【迁移后不能执行】")
    && issue.message.includes("trigger.input.doi")));
const tab=config["z"] as string;
const agentCalls:string[]=[];
const bridge=createConditionTriggerBridge({
  execute:async (operation,payload)=>{
    if(operation!=="agent.run"&&operation!=="conversation.run")throw Error("Unexpected Host operation");
    agentCalls.push(String(payload["instruction"]));
    return {text:"completed",artifacts:[]};
  },
  subscribe:()=>()=>{},
},{getDoc:id=>id===doc.id?conditionalDoc:null,
  resolveWorkflow:id=>id===tab?doc.id:null});
const issued=bridge.issueManual(doc.id,{
  kind:"event",event:"library.item.imported","input.doi":"10.1000/mcode",
});
const oldCount=sent.length;
route?.({params:{id:config["id"]},body:{__user_inject_props__:[
  {p:"mcode.triggerTicket",v:issued.ticket,vt:"str"},
]}},{sendStatus(status:number){httpStatus=status;}});
const injected=sent[sent.length-1] as Record<string,unknown>;
const ticket=(injected?.["mcode"] as Record<string,unknown>|undefined)?.["triggerTicket"];
check("真 Node-RED /inject/:id 能把单次 Host ticket 放在嵌套 mcode 路径",
  sent.length===oldCount+1&&ticket===issued.ticket&&httpStatus===200,{ticket,httpStatus});
const matched=await bridge.services.execute("condition.evaluate",{
  tabId:tab,nodeId:"condition-1",expression,results:[],triggerTicket:ticket,
}) as {matched:boolean};
check("自定义 UI 输入经真原生 Inject → Host 旧条件求值器识别 DOI",
  matched.matched===true,matched);
await bridge.services.execute("agent.run",{
  tabId:tab,nodeId:"agent-1",instruction:"Find {{trigger.input.doi}}",
  params:{},triggerTicket:ticket,
});
check("Agent 原生节点提示词使用同一份 Host 验证过的 DOI 插值",
  agentCalls.length===1&&agentCalls[0]==="Find 10.1000/mcode",agentCalls);
let forgedAgentRefused=false;
try {
  await bridge.services.execute("agent.run",{
    tabId:tab,nodeId:"agent-1",instruction:"Find {{trigger.input.doi}}",
    params:{},triggerTicket:"not-real",input:{doi:"forged"},
  });
} catch(error) {forgedAgentRefused=error instanceof Error&&error.message.includes("trigger.input.doi");}
check("原生 Agent 不接受伪造输入，提示词不会偷偷保留占位符",
  forgedAgentRefused&&agentCalls.length===1);
let unauthenticated=false;
try{
  await bridge.services.execute("condition.evaluate",{
    tabId:tab,nodeId:"condition-1",expression,results:[],
    triggerTicket:"attacker-supplied",payload:{"input.doi":"10.1000/mcode"},
  });
}catch(err){unauthenticated=err instanceof Error&&err.message.includes("trigger.input.doi");}
check("假 DOI 和自报 ticket 都不能触发旧条件成功分支",unauthenticated);
issued.revoke();
let revoked=false;
try{
  await bridge.services.execute("condition.evaluate",{
    tabId:tab,nodeId:"condition-1",expression,results:[],triggerTicket:ticket,
  });
}catch(err){revoked=err instanceof Error&&err.message.includes("trigger.input.doi");}
check("调用失败/取消后撤销临时票据，不可重放",revoked);
const second=instances.get(config["id"] as string);
(second?.["close"] as (()=>void)|undefined)?.();
check("结束时没有隐藏定时器待触发",timeouts.length===0&&jobs.length===0);
console.log("mcode-manual-inject-smoke: "+(total-failed)+"/"+total);
if(failed)process.exitCode=1;
