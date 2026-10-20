import {SceneTaskRegistry} from "../../src/main/orchestration/sceneTaskRegistry.js";
import type {TaskInvocation} from "@contracts/sceneTask.js";
let good=0,bad=0;const ok=(s:string,p:boolean,v?:unknown)=>{console.log((p?"PASS ":"FAIL ")+s+(p?"":" "+JSON.stringify(v)));p?good++:bad++;};
const root:TaskInvocation={sceneId:"fixture-scene",taskId:"root",parentTaskId:null,sessionId:null,originAgentId:"host-agent",providerId:"pi",triggerOrigin:"scene",allowedCapabilities:["read"],budgetAccountId:"host-budget",maxFanout:2,maxDepth:2,deadline:null};
const registry=new SceneTaskRegistry();
const initial=registry.createRootTask(root);
ok("valid host-owned root still admitted",initial.ok,initial);
for(const [label,inv] of [["null",null],["undefined",undefined],["malformed prototype-free record",Object.create(null)],["array",[]]] as const){
 let value:unknown=null,escaped=false;try{value=registry.createRootTask(inv as never);}catch{escaped=true;}
 ok(label+" root malformed data returns typed INVALID_TASK rather than crash",!escaped&&(value as {code?:string}|null)?.code==="INVALID_TASK",value);
}
for(const [label,inv] of [["null",null],["undefined",undefined],["array",[]]] as const){
 let value:unknown=null,escaped=false;try{value=registry.spawn("root",inv as never);}catch{escaped=true;}
 ok(label+" child malformed data returns typed INVALID_TASK",!escaped&&(value as {code?:string}|null)?.code==="INVALID_TASK",value);
}
const child=registry.spawn("root",{...root,taskId:"child",parentTaskId:"root"});
ok("valid child still admitted",child.ok,child);
ok("failed malformed calls leave ancestry unmodified",registry.childrenOf("root").join(",")==="child",registry.childrenOf("root"));
console.log(`scene-invocation-malformed-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
