/**
 * ARC-006 MERGE-0: exercise the real Mcode adapter on the exact Node-RED
 * nodes[]/wires[] shape emitted by upstream editor-client/runtime. No fake
 * workflow engine, no user disk, and no native editor sidecar assumed.
 */
import assert from "node:assert/strict";
import { flowToWorkflowDoc, migrateWorkflowDoc, type NodeRedFlow, type NodeRedNode } from "@main/workflowEngines/flowMigration.js";

let count=0;
function check(name:string, run:()=>void):void {
  run();
  console.log("  ok "+name);
  count++;
}
function nativeNode(id:string, nodeId:string, targets:string[]=[]):NodeRedNode {
  return {id,type:"function",name:nodeId,wires:[targets],
    "x-mcode":{nodeId,type:"mcode.test",title:nodeId,params:{},
      position:{x:12,y:34}}};
}
function fixture(order:"normal"|"reversed"="normal"):NodeRedFlow {
  const tab={id:"tab01",type:"tab",label:"Native editor",
    "x-mcode":{docId:"merged-workflow",name:"Pre migration"}} as unknown as NodeRedNode;
  const first=nativeNode("a1","a_b",["dest1"]);
  const second=nativeNode("a2","a",["dest2"]);
  const dst1=nativeNode("dest1","c");
  const dst2=nativeNode("dest2","b_c");
  return {id:"native-flow",label:"Native editor",
    nodes:[tab,...(order==="normal"?[first,second]:[second,first]),dst1,dst2]};
}
check("native Node-RED wires with different source/target pairs never reuse edge IDs",()=>{
  const doc=flowToWorkflowDoc(fixture());
  assert.equal(doc.edges.length,2);
  assert.equal(new Set(doc.edges.map(e=>e.id)).size,2,
    "different edges collide after legacy e_${from}_${to} string concatenation");
  assert.deepEqual(new Set(doc.edges.map(e=>JSON.stringify([e.from,e.to]))),
    new Set(['["a_b","c"]','["a","b_c"]']));
});
check("identity of colliding edges is stable across editor node-order changes",()=>{
 const one=flowToWorkflowDoc(fixture("normal"));
 const two=flowToWorkflowDoc(fixture("reversed"));
 const ids=(flow:typeof one)=>Object.fromEntries(flow.edges.map(e=>[JSON.stringify([e.from,e.to]),e.id]));
 assert.deepEqual(ids(one),ids(two));
});
check("existing ordinary native-edge fallback ID remains backward compatible",()=>{
 const flow:NodeRedFlow={id:"normal",label:"doc",nodes:[
  {id:"tab",type:"tab",label:"doc","x-mcode":{docId:"normal",name:"doc"}} as unknown as NodeRedNode,
  nativeNode("source","alpha",["target"]),
  nativeNode("target","beta")],
 };
 assert.equal(flowToWorkflowDoc(flow).edges[0].id,"e_alpha_beta");
});
check("roundtrip adapter never mutates native editor arrays",()=>{
 const flow=fixture();
 const snapshot=JSON.stringify(flow);
 flowToWorkflowDoc(flow);
 assert.equal(JSON.stringify(flow),snapshot);
});
check("native editor duplicate-node preserves a unique WorkflowDoc identity for each cloned node",()=>{
 const tab={id:"t",type:"tab",label:"doc","x-mcode":{docId:"doc",name:"doc"}} as unknown as NodeRedNode;
 // Node-RED copies unknown node attributes when duplicating a node, so the
 // new native node id is distinct but the old x-mcode.nodeId is identical.
 const original=nativeNode("n_original","original",["end"]);
 const clone=nativeNode("native-copy-3","original",["end"]);
 const destination=nativeNode("end","destination");
 const flow:NodeRedFlow={id:"doc",label:"doc",nodes:[tab,original,clone,destination]};
 const doc=flowToWorkflowDoc(flow);
 assert.equal(doc.nodes.length,3);
 assert.equal(new Set(doc.nodes.map(n=>n.id)).size,3,"clones must not silently share the old Mcode node ID");
 assert.equal(doc.edges.length,2);
 assert.equal(new Set(doc.edges.map(e=>e.from)).size,2,"connections must point at the two distinct recovered clones");
});
check("native duplicated-node identities do not flip when editor reorders nodes",()=>{
 const tab={id:"t",type:"tab",label:"doc","x-mcode":{docId:"doc",name:"doc"}} as unknown as NodeRedNode;
 const original=nativeNode("n_original","original",["end"]);
 const clone=nativeNode("native-copy-3","original",["end"]);
 const destination=nativeNode("end","destination");
 const idByTitle=(nodes:NodeRedNode[])=>{
  const restored=flowToWorkflowDoc({id:"doc",label:"doc",nodes:[tab,...nodes,destination]});
  const expected=restored.edges.map(e=>e.from).sort();
  return expected;
 };
 assert.deepEqual(idByTitle([original,clone]),idByTitle([clone,original]));
});
check("editor duplicating a migrated native node keeps the original Mcode identity",()=>{
 const doc={id:"migrated",name:"Migrated",nodes:[
   {id:"stable-orig",type:"custom.node",title:"Original",params:{},position:{x:22,y:45}},
 ],edges:[],builtin:false,updatedAt:1} as unknown as import("@contracts/workflow").WorkflowDoc;
 const migrated=migrateWorkflowDoc(doc);
 const original=migrated.flow.nodes.find(n=>n.type!=="tab");
 assert.ok(original);
 const cloned=structuredClone(original);
 cloned.id="native-clone-unique";
 cloned.name="Copied via native Node-RED";
 const native:NodeRedFlow={...migrated.flow,nodes:[...migrated.flow.nodes,cloned],links:undefined};
 const restored=flowToWorkflowDoc(native);
 assert.equal(restored.nodes.length,2);
 assert.equal(new Set(restored.nodes.map(n=>n.id)).size,2);
 assert.equal(restored.nodes.find(n=>n.title==="Original")?.id,"stable-orig",
   "original migrated node keeps its previously approved identity");
 assert.equal(restored.nodes.find(n=>n.title==="Copied via native Node-RED")?.id?.startsWith("mcode_copy_"),true);
});
check("duplicated legacy edge metadata IDs are not silently reused",()=>{
 const flow=fixture();
 // Simulate a previously duplicated/copied sidecar identity from an imported
 // file while the native editor's live wires remain the source of truth.
 flow.links=[
 {id:"link-one",source:"a1",sourcePort:0,target:"dest1",targetPort:0,
   "x-mcode-edge":{edgeId:"shared-legacy-id"}},
 {id:"link-two",source:"a2",sourcePort:0,target:"dest2",targetPort:0,
   "x-mcode-edge":{edgeId:"shared-legacy-id"}}];
 const restored=flowToWorkflowDoc(flow);
 assert.equal(new Set(restored.edges.map(e=>e.id)).size,2);
});
check("native GET /flows preserves unedited edge label and note without Mcode-only links sidecar",()=>{
 const doc={id:"notes-doc",name:"Notes",nodes:[
   {id:"left",type:"custom.node",title:"Source",params:{},position:{x:10,y:15}},
   {id:"right",type:"custom.node",title:"Target",params:{},position:{x:20,y:35}},
   {id:"third",type:"custom.node",title:"Other",params:{},position:{x:70,y:80}},
 ],edges:[{id:"approved-edge-identity",from:"left",to:"right",
   label:"Review",note:"Leave the annotation attached"}],builtin:false,updatedAt:1} as unknown as import("@contracts/workflow").WorkflowDoc;
 const migrated=migrateWorkflowDoc(doc).flow;
 const native:NodeRedFlow={...migrated,links:undefined,nodes:structuredClone(migrated.nodes)};
 const restored=flowToWorkflowDoc(native);
 assert.equal(restored.edges.length,1);
 assert.equal(restored.edges[0].id,"approved-edge-identity");
 assert.equal(restored.edges[0].label,"Review");
 assert.equal(restored.edges[0].note,"Leave the annotation attached");
});
check("stale native connection metadata cannot apply old note to a newly rewired target",()=>{
 const doc={id:"rewire-doc",name:"Rewire",nodes:[
  {id:"source",type:"custom.node",title:"Source",params:{},position:{x:10,y:15}},
  {id:"old",type:"custom.node",title:"Old",params:{},position:{x:20,y:35}},
  {id:"new",type:"custom.node",title:"New",params:{},position:{x:70,y:80}},
 ],edges:[{id:"previous-note",from:"source",to:"old",label:"Old label",note:"OLD"}],
 builtin:false,updatedAt:1} as unknown as import("@contracts/workflow").WorkflowDoc;
 const migrated=migrateWorkflowDoc(doc).flow;
 const native:NodeRedFlow={...migrated,links:undefined,nodes:structuredClone(migrated.nodes)};
 const src=native.nodes.find(n=>n["x-mcode"]?.nodeId==="source")!;
 const target=native.nodes.find(n=>n["x-mcode"]?.nodeId==="new")!;
 src.wires=[[target.id]];
 const restored=flowToWorkflowDoc(native);
 assert.equal(restored.edges.length,1);
 assert.equal(restored.edges[0].to,"new");
 assert.notEqual(restored.edges[0].id,"previous-note");
 assert.equal(restored.edges[0].note,undefined);
 assert.equal(restored.edges[0].label,undefined);
});
check("native duplicate-node cannot inherit original edge annotation through copied x-mcode",()=>{
 const doc={id:"clone-notes-doc",name:"Clone",nodes:[
  {id:"origin",type:"custom.node",title:"Origin",params:{},position:{x:10,y:20}},
  {id:"target",type:"custom.node",title:"Target",params:{},position:{x:40,y:60}},
 ],edges:[{id:"orig-edge",from:"origin",to:"target",label:"Approved",note:"DO-NOT-COPY"}],
 builtin:false,updatedAt:1} as unknown as import("@contracts/workflow").WorkflowDoc;
 const migrated=migrateWorkflowDoc(doc).flow;
 const original=migrated.nodes.find(n=>n["x-mcode"]?.nodeId==="origin")!;
 const clone=structuredClone(original);
 clone.id="native-clone-with-copied-meta";
 const native:NodeRedFlow={...migrated,links:undefined,
  nodes:[...structuredClone(migrated.nodes),clone]};
 const restored=flowToWorkflowDoc(native);
 assert.equal(restored.edges.length,2);
 assert.equal(new Set(restored.edges.map(e=>e.id)).size,2);
 const annotated=restored.edges.filter(e=>e.note==="DO-NOT-COPY");
 assert.equal(annotated.length,1,"only the original native source may retain its old annotation");
 assert.equal(annotated[0].id,"orig-edge");
 assert.equal(restored.edges.find(e=>e.id!=="orig-edge")?.note,undefined);
});
check("copying a native write-authorized Agent node cannot inherit its original write approval",()=>{
 const flow:NodeRedFlow={id:"perm",label:"Permissions",nodes:[
  {id:"t",type:"tab",label:"Permissions","x-mcode":{docId:"perm",name:"Permissions"}} as NodeRedNode,
  {id:"n_admin",type:"mcode-agent",name:"Original",instruction:"act",capability:"write",
   wires:[[]],"x-mcode":{nodeId:"admin",type:"mcode.agent",params:{instruction:"act",capability:"write"},
    capability:"write",position:{x:10,y:10}}},
  {id:"copy-native-id",type:"mcode-agent",name:"Copy",instruction:"act",capability:"write",
   wires:[[]],"x-mcode":{nodeId:"admin",type:"mcode.agent",params:{instruction:"act",capability:"write"},
    capability:"write",position:{x:20,y:10}}},
 ]};
 const restored=flowToWorkflowDoc(flow);
 const original=restored.nodes.find(n=>n.id==="admin")!;
 const clone=restored.nodes.find(n=>n.id!=="admin")!;
 assert.equal(restored.nodes.length,2);
 assert.equal(original.capability,"write","keep the original explicitly granted access");
 assert.equal(clone.capability,"read","new copied identity requires a fresh approval");
 assert.equal(clone.params["capability"],"read",
  "copied sidecar params must not silently restore elevated write permission");
});
check("native legacy command type replacement cannot silently execute stale Mcode command contract",()=>{
 const command:NodeRedNode={id:"n_job",type:"exec",name:"Job",command:"echo safe",
  wires:[[],[],[]],"x-mcode":{nodeId:"job",type:"mcode.command",
    params:{command:"echo safe"},position:{x:20,y:30}}};
 const tab={id:"t",type:"tab",label:"Legacy",
  "x-mcode":{docId:"legacy",name:"Legacy"}} as unknown as NodeRedNode;
 const flow:NodeRedFlow={id:"legacy",label:"Legacy",nodes:[tab,command]};
 assert.equal(flowToWorkflowDoc(flow).nodes[0].type,"mcode.command");
 command.type="function";
 command.func="return msg";
 assert.throws(()=>flowToWorkflowDoc(flow),/native.*type|类型.*不匹配|不一致/i,
  "stale x-mcode.command metadata must not masquerade as a new Function node");
});
check("native code switch from Function to exec cannot retain stale node-language contract",()=>{
 const code:NodeRedNode={id:"n_code",type:"function",name:"JS",func:"return msg;",
  wires:[[]],"x-mcode":{nodeId:"code",type:"mcode.code",
   params:{language:"node",code:"return msg;"},position:{x:3,y:4}}};
 const flow:NodeRedFlow={id:"legacy-code",label:"Legacy",nodes:[code]};
 assert.equal(flowToWorkflowDoc(flow).nodes[0].params["language"],"node");
 code.type="exec";code.command="echo unsafe";
 assert.throws(()=>flowToWorkflowDoc(flow),/native.*type|类型.*不匹配|不一致/i);
});
check("imported unknown native nodes without sidecar still keep their original native type",()=>{
 const flow:NodeRedFlow={id:"foreign",label:"External",nodes:[
  {id:"foreign-id",type:"my-third-party-node",name:"Vendor",wires:[[]]}
 ]};
 const restored=flowToWorkflowDoc(flow);
 assert.equal(restored.nodes[0].type,"my-third-party-node");
});
check("native title/position changes of an unchanged typed node are not rejected",()=>{
 const node:NodeRedNode={id:"n_job",type:"exec",name:"Renamed",command:"echo safe",x:100,y:200,
  wires:[[],[],[]],"x-mcode":{nodeId:"job",type:"mcode.command",
   params:{command:"echo safe"},position:{x:3,y:4}}};
 const restored=flowToWorkflowDoc({id:"doc",label:"Doc",nodes:[node]});
 assert.equal(restored.nodes[0].title,"Renamed");
 assert.deepEqual(restored.nodes[0].position,{x:100,y:200});
});
check("legacy Mcode unknown wrapper without nativeType remains readable as a non-executable placeholder",()=>{
 const old:NodeRedNode={id:"legacy",type:"mcode-unknown",name:"Missing plugin",wires:[[]],
  "x-mcode":{nodeId:"old",type:"mcode.command",params:{command:"not installed"},position:{x:1,y:2}}};
 const restored=flowToWorkflowDoc({id:"old",label:"Legacy",nodes:[old]});
 assert.equal(restored.nodes[0].id,"old");
 assert.equal(restored.nodes[0].type,"mcode.command");
 assert.equal(restored.nodes[0].params["command"],"not installed");
});
check("new nativeType marker detects type-changing a custom provider node after save",()=>{
 const doc={id:"marker",name:"Marker",nodes:[
  {id:"thirdparty",type:"vendor.node",title:"External",params:{},position:{x:10,y:10}},
 ],edges:[],builtin:false,updatedAt:1} as unknown as import("@contracts/workflow").WorkflowDoc;
 const migrated=migrateWorkflowDoc(doc).flow;
 const item=migrated.nodes.find(n=>n.type!=="tab")!;
 assert.equal(item["x-mcode"]?.nativeType,item.type);
 item.type="function";
 assert.throws(()=>flowToWorkflowDoc({...migrated,links:undefined}),/native.*type|类型.*不匹配|不一致/i);
});
check("copied native node remains distinct and unapproved when original node was deleted",()=>{
 const oldNative="n_privileged";
 const copied:NodeRedNode={id:"copied-lonely-native",type:"mcode-agent",name:"Orphan Copy",
  instruction:"operate",capability:"write",wires:[[]],
  "x-mcode":{nodeId:"privileged",nativeId:oldNative,nativeType:"mcode-agent",
    type:"mcode.agent",params:{instruction:"operate",capability:"write"},
    capability:"write",position:{x:3,y:4}}};
 const flow:NodeRedFlow={id:"orphan",label:"Orphan",nodes:[copied]};
 const round=flowToWorkflowDoc(flow);
 assert.equal(round.nodes.length,1);
 assert.notEqual(round.nodes[0].id,"privileged",
   "deleted original's canonical identity cannot be resurrected by its copy");
 assert.match(round.nodes[0].id,/^mcode_copy_/);
 assert.equal(round.nodes[0].capability,"read");
 assert.equal(round.nodes[0].params["capability"],"read");
});
check("legitimate original node with explicit recorded native ID retains its stable Mcode identity",()=>{
 const native:NodeRedNode={id:"old-with-hash-suffix",type:"mcode-agent",name:"Original",
  instruction:"review",capability:"read",wires:[[]],
  "x-mcode":{nodeId:"original",nativeId:"old-with-hash-suffix",nativeType:"mcode-agent",
   type:"mcode.agent",params:{instruction:"review"},position:{x:1,y:2}}};
 const restored=flowToWorkflowDoc({id:"doc",label:"Doc",nodes:[native]});
 assert.equal(restored.nodes[0].id,"original");
});
check("two copied privileged native nodes with deleted source both get fresh read-only identities",()=>{
 const common={nodeId:"approved",nativeId:"n_approved",nativeType:"mcode-agent",
   type:"mcode.agent",params:{instruction:"run",capability:"write"},capability:"write",
   position:{x:1,y:2}};
 const a:NodeRedNode={id:"copy-a",type:"mcode-agent",name:"Copy A",capability:"write",instruction:"run",
  wires:[[]],"x-mcode":structuredClone(common)};
 const b:NodeRedNode={id:"copy-b",type:"mcode-agent",name:"Copy B",capability:"write",instruction:"run",
  wires:[[]],"x-mcode":structuredClone(common)};
 const restored=flowToWorkflowDoc({id:"copy",label:"Copy",nodes:[a,b]});
 assert.equal(restored.nodes.length,2);
 assert.equal(new Set(restored.nodes.map(n=>n.id)).size,2);
 assert.ok(restored.nodes.every(n=>n.id.startsWith("mcode_copy_")));
 assert.ok(restored.nodes.every(n=>n.capability==="read" && n.params["capability"]==="read"));
 const reversed=flowToWorkflowDoc({id:"copy",label:"Copy",nodes:[b,a]});
 assert.deepEqual(new Set(restored.nodes.map(n=>n.id)),new Set(reversed.nodes.map(n=>n.id)));
});
console.log("flow-migration-identity-smoke:"+count+"/"+count);
