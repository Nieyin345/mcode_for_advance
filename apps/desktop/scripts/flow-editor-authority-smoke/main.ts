import {createHash} from "node:crypto";
import {migrateWorkflowDoc,flowToWorkflowDoc,roundTripMismatchPaths} from "../../src/main/workflowEngines/flowMigration.js";
import type {WorkflowDoc} from "@contracts/workflow";
let good=0,bad=0;function check(name:string,ok:boolean,extra=""){console.log((ok?"PASS ":"FAIL ")+name+" "+extra);ok?good++:bad++;}
const doc={id:"flow-fixture",name:"Original tab",nodes:[
{id:"source",type:"mcode.agent",title:"Before Name",params:{text:"hello"},position:{x:10.25,y:20.25}},
{id:"target",type:"mcode.agent",title:"Target",params:{},position:{x:60,y:90}},
{id:"other",type:"mcode.agent",title:"Other",params:{},position:{x:99,y:99}}
],edges:[{id:"edge-before",from:"source",to:"target",label:"keep",note:"original metadata"}],builtin:false,updatedAt:1} as unknown as WorkflowDoc;
const flow=migrateWorkflowDoc(doc).flow;
const first=flowToWorkflowDoc(flow);
check("untouched migration retains roundtrip known schema",roundTripMismatchPaths(doc,first).length===0);
const renamed=structuredClone(flow);
const src=renamed.nodes.find(n=>n["x-mcode"]?.nodeId==="source")!;
const target=renamed.nodes.find(n=>n["x-mcode"]?.nodeId==="target")!;
const other=renamed.nodes.find(n=>n["x-mcode"]?.nodeId==="other")!;
src.name="Changed in native Node-RED editor";src.x=160;src.y=250;
const tab=renamed.nodes.find(n=>n.type==="tab")!;tab.label="Tab changed in native canvas";
const result1=flowToWorkflowDoc(renamed);
const backSrc=result1.nodes.find(n=>n.id==="source")!;
check("native edited name overrides stale x-mcode.title",backSrc.title==="Changed in native Node-RED editor",backSrc.title);
check("native edited x/y override frozen x-mcode.position",backSrc.position.x===160&&backSrc.position.y===250,JSON.stringify(backSrc.position));
check("native tab rename overrides stale x-mcode.name",result1.name==="Tab changed in native canvas",result1.name);
check("without rewiring edge annotations survive x-mcode-edge metadata",result1.edges.length===1&&result1.edges[0].id==="edge-before"&&result1.edges[0].note==="original metadata");
const rewired=structuredClone(flow);
const s=rewired.nodes.find(n=>n["x-mcode"]?.nodeId==="source")!;
s.wires=[[other.id]]; // edit native wire but keep stale migration sidecar
const result2=flowToWorkflowDoc(rewired);
check("native rewiring replaces stale links sidecar",result2.edges.length===1&&result2.edges[0].to==="other",JSON.stringify(result2.edges));
const mixedDoc=structuredClone(doc) as WorkflowDoc;
mixedDoc.edges.push({id:"edge-stays",from:"target",to:"other",label:"carry",note:"unchanged edge annotation",["x-custom"]:{"source":"preserve"}} as never);
const mixed=migrateWorkflowDoc(mixedDoc).flow;
mixed.nodes.find(n=>n["x-mcode"]?.nodeId==="source")!.wires=[[
 mixed.nodes.find(n=>n["x-mcode"]?.nodeId==="other")!.id
]];
const readMixed=flowToWorkflowDoc(mixed);
const surviving=readMixed.edges.find(e=>e.from==="target"&&e.to==="other") as (typeof readMixed.edges)[number]&Record<string,unknown>|undefined;
check("other untouched edges retain original metadata when one wire changes",
 surviving?.id==="edge-stays" && surviving?.note==="unchanged edge annotation" &&
 (surviving["x-custom"] as {source?:string}|undefined)?.source==="preserve",JSON.stringify(readMixed.edges));
const deleted=structuredClone(flow);
deleted.nodes=deleted.nodes.filter(n=>n["x-mcode"]?.nodeId!=="target");
const ds=deleted.nodes.find(n=>n["x-mcode"]?.nodeId==="source")!;
ds.wires=[[]];
const result3=flowToWorkflowDoc(deleted);
check("deleted native target never resurrects stale ghost edge",result3.edges.length===0&&result3.nodes.length===2);
const malformedId="a+b";const folded="a_b";const hash=createHash("sha256").update(malformedId,"utf16le").digest("hex").slice(0,16);
const collidingDoc={...doc,edges:[],nodes:[
{id:malformedId,type:"mcode.agent",title:"one",params:{},position:{x:1,y:1}},
{id:folded,type:"mcode.agent",title:"two",params:{},position:{x:2,y:2}},
{id:folded+"_"+hash,type:"mcode.agent",title:"three",params:{},position:{x:3,y:3}}
]} as unknown as WorkflowDoc;
const normal=migrateWorkflowDoc(collidingDoc).flow;
const reversed=migrateWorkflowDoc({...collidingDoc,nodes:[...collidingDoc.nodes].reverse()}).flow;
const map=(f:typeof normal)=>Object.fromEntries(f.nodes.filter(n=>n.type!=="tab").map(n=>[n["x-mcode"]!.nodeId,n.id]));
check("second-level folded/hash collision must not change IDs when node order changes",JSON.stringify(Object.entries(map(normal)).sort())===JSON.stringify(Object.entries(map(reversed)).sort()),JSON.stringify(map(normal))+" vs "+JSON.stringify(map(reversed)));
console.log(`flow-editor-authority-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
