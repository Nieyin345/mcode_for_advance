/**
 * FULL-2 regression: original Node-RED property forms are the live editable
 * source for mapped Mcode params. Exercise the production adapter, not a copy
 * of its mapping rules. No Electron, user files, or real engine mutation.
 */
import { strict as assert } from "node:assert";
import {
  flowToWorkflowDoc,
  migrateWorkflowDoc,
  type NodeRedFlow,
  type NodeRedNode,
} from "@main/workflowEngines/flowMigration.js";
import { branchNodeHtml, conversationNodeHtml, nodeRedCallNodeHtml, runNodeRedCallNode, triggerNodeHtml } from "@main/workflowEngines/mcodeNodeTypes.js";
import type { WorkflowDoc, WorkflowNode } from "@contracts/workflow";
import type { NodeTypeManifest, NodeRunnerKind } from "@contracts/nodeType";
import { MODULE_CAPABILITY_RUNNER_KIND } from "@contracts/moduleCapability";

let failures=0,total=0;
function check(name:string,cond:boolean|(()=>void),detail?:unknown):void {
 total++;
 if(typeof cond==="function") {
  try { cond(); console.log("  ok "+name); }
  catch(error) {
   failures++;
   const e=error as {message?:unknown;actual?:unknown;expected?:unknown};
   console.log("  FAIL "+name+" — "+JSON.stringify({
    message:typeof e?.message==="string"?e.message:String(error),
    actual:e?.actual,expected:e?.expected,
   }));
  }
  return;
 }
 if(cond) console.log("  ok "+name);
 else { failures++; console.log("  FAIL "+name+(detail===undefined?"":" — "+JSON.stringify(detail))); }
}
function eq(name:string,actual:unknown,expected:unknown):void {
 check(name,Object.is(actual,expected),{actual,expected});
}
function has(name:string,value:unknown,key:string):void {
 check(name,value!==null&&typeof value==="object"&&Object.prototype.hasOwnProperty.call(value,key),
   {value,key});
}
const kinds: Array<[string,NodeRunnerKind]>=[
 ["mcode.agent","prompt"],
 ["mcode.conversation","conversation"],
 ["mcode.branch","branch"],
 ["mcode.trigger","trigger"],
 ["mcode.module-capability",MODULE_CAPABILITY_RUNNER_KIND as NodeRunnerKind],
 ["mcode.node-red","node-red"],
 ["mcode.command","command"],
 ["mcode.code","code"],
 ["mcode.condition","condition"],
];
const TYPES:ReadonlyMap<string,NodeTypeManifest>=new Map(kinds.map(([id,kind])=>[
 id,{id,manifestVersion:1,name:id,runner:{kind}} as unknown as NodeTypeManifest
]));
function wn(id:string,type:string,params:Record<string,unknown>,capability?:string):WorkflowNode {
 return {id,type,title:id,params,position:{x:10,y:20},
   ...(capability!==undefined?{capability}:{}),
 } as unknown as WorkflowNode;
}
function doc(nodes:WorkflowNode[]):WorkflowDoc {
 return {id:"native-param-doc",name:"Native parameter regression",nodes,edges:[],builtin:false,updatedAt:1} as unknown as WorkflowDoc;
}
function fixture():WorkflowDoc {
 return doc([
  wn("agent","mcode.agent",{instruction:"Summarize the result",outputVar:"summary",customFlag:{keep:true}},"write"),
  wn("conversation","mcode.conversation",{instruction:"Continue in the current conversation"},"read"),
  wn("branch","mcode.branch",{decider:"model",outputVar:"route",note:"Choose one"}),
  wn("event-trigger","mcode.trigger",{triggerKind:"event",task:"Process event",cron:"",events:"tool.use"}),
  wn("module","mcode.module-capability",{moduleId:"core.files",contributionId:"inspect",path:"report.md"}),
  wn("node-red-call","mcode.node-red",{enginePath:"/api/flows",engineMethod:"PATCH",engineBody:"{}"}),
  wn("command","mcode.command",{command:"echo old",timeoutMs:1500,outputVars:[]}),
  wn("js-code","mcode.code",{language:"node",code:"return msg;",timeoutMs:5000}),
  wn("python-code","mcode.code",{language:"python",code:"print('old')",timeoutMs:2500,input:"{{event-trigger.payload}}"}),
  wn("unknown-language-code","mcode.code",{language:"ruby",code:"puts 'kept'"}),
  wn("schedule-trigger","mcode.trigger",{triggerKind:"schedule",cron:"0 9 * * *"}),
  wn("file-trigger","mcode.trigger",{triggerKind:"file",paths:"src/**/*.ts"}),
  wn("condition","mcode.condition",{expression:{logic:"and",rules:[{ref:"{{agent.summary}}",op:"exists"}]}}),
 ]);
}
function byId(flow:NodeRedFlow,id:string):NodeRedNode {
 const node=flow.nodes.find(n=>n["x-mcode"]?.nodeId===id);
 assert.ok(node,"missing native node "+id);
 return node;
}
function mcodeNode(restored:WorkflowDoc,id:string):WorkflowNode {
 const node=restored.nodes.find(n=>n.id===id);
 assert.ok(node,"missing restored node "+id);
 return node;
}
const original=fixture();
const migrated=migrateWorkflowDoc(original,{types:TYPES});
const flow=migrated.flow;

check("custom agent fields populate the native form, including declared capability",()=>{
 const n=byId(flow,"agent");
 assert.equal(n.instruction,"Summarize the result");
 assert.equal(n.capability,"write");
 assert.equal(n.outputVar,"summary");
});
check("conversation and branch forms receive the values users must edit",()=>{
 const c=byId(flow,"conversation"),b=byId(flow,"branch");
 assert.equal(c.instruction,"Continue in the current conversation");
 assert.equal(b.decider,"model");
 assert.equal(b.note,"Choose one");
 assert.equal(b.outputVar,"route");
});
check("event-trigger and host-bridge forms receive their native properties",()=>{
 const t=byId(flow,"event-trigger"),m=byId(flow,"module"),r=byId(flow,"node-red-call");
 assert.equal(t.triggerKind,"event"); assert.equal(t.task,"Process event");
 assert.equal(m.moduleId,"core.files"); assert.equal(m.contributionId,"inspect"); assert.equal(m.path,"report.md");
 assert.equal(r.enginePath,"/api/flows"); assert.equal(r.engineMethod,"PATCH"); assert.equal(r.engineBody,"{}");
});
check("native exec command and timeout are populated instead of deploying an empty command",()=>{
 const n=byId(flow,"command");
 assert.equal(n.command,"echo old");
 assert.equal(n.timer,"1.5");
 assert.equal(n.wires?.length,3,"the native exec node has stdout/stderr/return-code outputs");
 assert.equal(n.addpay,false);
 assert.equal(n.useSpawn,false);
});
check("native Function node receives the Mcode JavaScript source",()=>{
 const n=byId(flow,"js-code");
 assert.equal(n.type,"function");
 assert.equal(n.func,"return msg;");
 assert.equal(n.timeout,5,"Node-RED Function timeout is expressed in seconds");
});
check("native exec node receives non-JavaScript source and timeout",()=>{
 const n=byId(flow,"python-code");
 assert.equal(n.type,"exec");
 assert.equal(n.command,"python -c print('old')");
 assert.equal(n.timer,"2.5");
 assert.equal(n.wires?.length,3,"native exec has three output wire slots");
});
check("native inject and watch fields reflect the Mcode trigger values",()=>{
 const schedule=byId(flow,"schedule-trigger"),file=byId(flow,"file-trigger");
 assert.equal(schedule.type,"inject"); assert.equal(schedule.crontab,"0 9 * * *");
 assert.equal(file.type,"watch"); assert.equal(file.files,"src/**/*.ts");
});
check("unsupported code language fallback is explicitly lossy but does not silently change its declaration",()=>{
 const n=byId(flow,"unknown-language-code");
 assert.equal(n.type,"exec"); assert.equal(n.command,"python -c puts 'kept'");
 assert.ok(migrated.report.needsHumanDecision.some(issue=>issue.nodeId==="unknown-language-code"));
 const restoredUnknown=mcodeNode(flowToWorkflowDoc(flow),"unknown-language-code");
 assert.equal(restoredUnknown.params.language,"ruby");
 assert.equal(restoredUnknown.params.code,"puts 'kept'");
});
check("native Node-RED call form exposes every declared HTTP method including PATCH",()=>{
 assert.match(nodeRedCallNodeHtml(),/option value="PATCH"/);
});
const hostRequests: Array<Record<string,unknown>> = [];
for (const params of [
 { enginePath: "/api/work" },
 { enginePath: "/api/work", engineMethod: "" },
 { enginePath: "/api/work", engineMethod: "   " },
]) {
 await runNodeRedCallNode({payload:"test"}, {id:"nr-call-test","x-mcode":{params}}, {
  run: async (payload) => {
    hostRequests.push(payload as unknown as Record<string,unknown>);
    return {text:"ok",artifacts:[]};
  },
 });
}
check("new node-red-call runtime defaults missing/blank method to contract POST instead of GET",()=>{
 assert.deepEqual(hostRequests.map(r=>r.engineMethod),["POST","POST","POST"]);
});
check("new Node-RED HTTP call palette entries initialize engineMethod to POST",()=>{
 assert.ok(nodeRedCallNodeHtml().includes('engineMethod: { value: "POST" }'));
});
check("long Mcode parameters use multiline controls in native Node-RED forms",()=>{
 assert.match(conversationNodeHtml(),/textarea id="node-input-instruction"/);
 assert.match(branchNodeHtml(),/textarea id="node-input-note"/);
 assert.match(triggerNodeHtml(),/textarea id="node-input-task"/);
 assert.match(nodeRedCallNodeHtml(),/textarea id="node-input-engineBody"/);
});
check("unmappable code input-template is retained and explicitly reported as lossy",()=>{
 assert.ok(migrated.report.lossy.some(issue=>issue.nodeId==="python-code"&&issue.message.includes("input JSON")));
 assert.equal(mcodeNode(flowToWorkflowDoc(flow),"python-code").params.input,"{{event-trigger.payload}}");
});
check("code and command output-contract differences are explicit instead of silently claimed equivalent",()=>{
 for (const id of ["command","js-code","python-code"]) {
  assert.ok(migrated.report.lossy.some(issue=>issue.nodeId===id&&issue.message.includes("产出契约")));
 }
});
check("unmodified round-trip preserves sidecar-only and unknown Mcode parameters",()=>{
 const restored=flowToWorkflowDoc(flow);
 assert.deepEqual(mcodeNode(restored,"agent").params.customFlag,{keep:true});
 assert.equal(mcodeNode(restored,"agent").params.instruction,"Summarize the result");
 assert.deepEqual(mcodeNode(restored,"condition").params.expression,
  {logic:"and",rules:[{ref:"{{agent.summary}}",op:"exists"}]});
});

const edited=structuredClone(flow);
const agent=byId(edited,"agent"); agent.instruction=""; agent.capability="read"; agent.outputVar="";
const branch=byId(edited,"branch"); branch.decider="user"; branch.note=""; branch.outputVar="nextStep";
const event=byId(edited,"event-trigger"); event.task="Updated task"; event.cron="";
const moduleNode=byId(edited,"module"); moduleNode.path="";
const call=byId(edited,"node-red-call"); call.engineMethod="PATCH"; call.engineBody="";
const command=byId(edited,"command"); command.command=""; command.timer="3";
const js=byId(edited,"js-code"); js.func=""; js.timeout=1.25;
const py=byId(edited,"python-code"); py.command="python -c print('new')"; py.timer="9";
const schedule=byId(edited,"schedule-trigger"); schedule.crontab="0 10 * * *";
const watch=byId(edited,"file-trigger"); watch.files="tests/**/*.ts";
const restored=flowToWorkflowDoc(edited);
check("native form edits and intentional empty values override stale agent metadata",()=>{
 const n=mcodeNode(restored,"agent");
 assert.equal(n.params.instruction,"");
 assert.equal(n.capability,"read");
 assert.equal(n.params.outputVar,"");
});
check("branch custom form edits round-trip, including clearing an old note",()=>{
 const n=mcodeNode(restored,"branch");
 assert.equal(n.params.decider,"user"); assert.equal(n.params.note,""); assert.equal(n.params.outputVar,"nextStep");
});
check("custom trigger, module capability, and HTTP bridge edits round-trip",()=>{
 assert.equal(mcodeNode(restored,"event-trigger").params.task,"Updated task");
 assert.equal(mcodeNode(restored,"event-trigger").params.cron,"");
 assert.equal(mcodeNode(restored,"module").params.path,"");
 assert.equal(mcodeNode(restored,"node-red-call").params.engineMethod,"PATCH");
 assert.equal(mcodeNode(restored,"node-red-call").params.engineBody,"");
});
check("native exec command edits round-trip without stale command or timeout",()=>{
 const n=mcodeNode(restored,"command");
 assert.equal(n.params.command,""); assert.equal(n.params.timeoutMs,3000);
});
check("native Function edits round-trip, including an intentionally cleared source",()=>{
 const n=mcodeNode(restored,"js-code");
 assert.equal(n.params.code,"");
 assert.equal(n.params.timeoutMs,1250,"native Function timeout seconds must convert back to Mcode milliseconds");
});
check("native exec code and timeout edits round-trip through the known interpreter prefix and seconds conversion",()=>{
 const n=mcodeNode(restored,"python-code");
 assert.equal(n.params.code,"print('new')"); assert.equal(n.params.timeoutMs,9000);
});
check("native inject and watch edits round-trip to their Mcode trigger params",()=>{
 const s=mcodeNode(restored,"schedule-trigger"),w=mcodeNode(restored,"file-trigger");
 assert.equal(s.params.triggerKind,"schedule"); assert.equal(s.params.cron,"0 10 * * *");
 assert.equal(w.params.triggerKind,"file"); assert.equal(w.params.paths,"tests/**/*.ts");
});
check("native node identity and sidecar-only condition expression survive edits",()=>{
 assert.equal(mcodeNode(restored,"condition").params.expression &&
  JSON.stringify(mcodeNode(restored,"condition").params.expression),
  JSON.stringify({logic:"and",rules:[{ref:"{{agent.summary}}",op:"exists"}]}));
 assert.equal(mcodeNode(restored,"agent").id,"agent");
});


check("FULL-2 native read-only downgrade cannot retain a stale write capability inside params",()=>{
 const source=doc([wn("cap","mcode.agent",{instruction:"inspect",capability:"write"},"write")]);
 const migratedSource=migrateWorkflowDoc(source,{types:TYPES}).flow;
 const native=byId(migratedSource,"cap");
 native.capability="read";
 const recovered=mcodeNode(flowToWorkflowDoc({...migratedSource,links:undefined}),"cap");
 assert.equal(recovered.capability,"read");
 assert.equal(recovered.params.capability,"read","old sidecar must not keep a privileged write claim");
 const remigrated=migrateWorkflowDoc(doc([recovered]),{types:TYPES}).flow;
 assert.equal(byId(remigrated,"cap").capability,"read");
});
check("FULL-2 explicit read-only Mcode capability wins over stale params.write when exporting",()=>{
 const source=doc([wn("cap","mcode.agent",{instruction:"inspect",capability:"write"},"read")]);
 const native=byId(migrateWorkflowDoc(source,{types:TYPES}).flow,"cap");
 assert.equal(native.capability,"read");
});
check("FULL-2 untrusted node metadata cannot overwrite canonical id/type/params/capability/position",()=>{
 const flowWithUnknown=structuredClone(flow);
 const agent=byId(flowWithUnknown,"agent");
 agent.capability="read";
 (agent["x-mcode"] as unknown as Record<string,unknown>).unknown={
  id:"forged",type:"forged.type",title:"forged.title",
  params:{capability:"write",instruction:"forged"},capability:"write",
  position:{x:999,y:777},otherMeta:"retained",
 };
 (agent["x-mcode"] as unknown as Record<string,unknown>).unknownPosition={
  x:333,y:555,z:72,
 };
 const restoredNode=mcodeNode(flowToWorkflowDoc({...flowWithUnknown,links:undefined}),"agent") as unknown as Record<string,unknown>;
 assert.equal(restoredNode.id,"agent");
 assert.equal(restoredNode.type,"mcode.agent");
 assert.equal((restoredNode.params as Record<string,unknown>).instruction,"Summarize the result");
 assert.equal(restoredNode.capability,"read");
 assert.equal((restoredNode.position as {x:number;y:number}).x,10);
 assert.equal((restoredNode.position as {x:number;y:number}).y,20);
 assert.equal(restoredNode.otherMeta,"retained");
 assert.equal((restoredNode.position as Record<string,unknown>).z,72);
});
check("FULL-2 untrusted document metadata cannot override document identity, nodes, edges or builtin",()=>{
 const bad=structuredClone(flow);
 (bad["x-mcode"] as unknown as Record<string,unknown>).unknown={
  id:"another-document",name:"forged-name",nodes:[],edges:[],builtin:true,
  safeUnknown:"retained",
 };
 const restoredDoc=flowToWorkflowDoc(bad) as unknown as Record<string,unknown>;
 assert.equal(restoredDoc.id,"native-param-doc");
 assert.equal(restoredDoc.name,"Native parameter regression");
 assert.equal((restoredDoc.nodes as unknown[]).length,original.nodes.length);
 assert.equal(restoredDoc.builtin,false);
 assert.equal(restoredDoc.safeUnknown,"retained");
});
check("FULL-2 unknown edge annotations cannot redirect verified wires or overwrite approved edge id",()=>{
 const edgeDoc=doc([wn("left","mcode.agent",{instruction:"a"}),wn("right","mcode.conversation",{instruction:"b"})]);
 edgeDoc.edges=[{id:"approved-edge",from:"left",to:"right",label:"approved",note:"note"}] as WorkflowDoc["edges"];
 const linked=migrateWorkflowDoc(edgeDoc,{types:TYPES}).flow;
 const link=linked.links?.[0];
 assert.ok(link?.["x-mcode-edge"]);
 link["x-mcode-edge"]!.unknown={id:"forged",from:"intruder",to:"fake",label:"forged",note:"forged",safeExtra:"safe"};
 const recovered=flowToWorkflowDoc(linked);
 assert.equal(recovered.edges.length,1);
 assert.equal(recovered.edges[0].id,"approved-edge");
 assert.equal(recovered.edges[0].from,"left");
 assert.equal(recovered.edges[0].to,"right");
 assert.equal(recovered.edges[0].label,"approved");
 assert.equal(recovered.edges[0].note,"note");
 assert.equal((recovered.edges[0] as unknown as Record<string,unknown>).safeExtra,"safe");
 const nodesOnly=structuredClone(linked);
 nodesOnly.links=undefined;
 const src=byId(nodesOnly,"left");
 const annot=src["x-mcode"]?.edgeMeta?.[0];
 assert.ok(annot);
 annot.unknown={id:"forged",from:"intruder",to:"fake",label:"forged",safeExtra:"safe"};
 const restoredWithoutLinks=flowToWorkflowDoc(nodesOnly);
 assert.equal(restoredWithoutLinks.edges[0].from,"left");
 assert.equal(restoredWithoutLinks.edges[0].to,"right");
 assert.equal(restoredWithoutLinks.edges[0].id,"approved-edge");
 assert.equal(restoredWithoutLinks.edges[0].label,"approved");
});

console.log("flow-native-param-smoke:"+ (total-failures)+"/"+total);
if(failures) process.exitCode=1;
