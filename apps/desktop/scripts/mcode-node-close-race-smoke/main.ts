import {
  registerMcodeNodePack,
  MCODE_CONVERSATION_NODE_TYPE,
  MCODE_MODULE_CAPABILITY_NODE_TYPE,
  MCODE_NODE_RED_CALL_NODE_TYPE,
  MCODE_BRANCH_NODE_TYPE,
  MCODE_TRIGGER_NODE_TYPE,
} from "@main/workflowEngines/mcodeNodeTypes.js";

let total=0,failed=0;
function check(label:string, ok:boolean, value?:unknown) {
 total++; if(!ok)failed++;
 console.log((ok?"  ok   ":"  FAIL ")+label+(ok?"":" "+JSON.stringify(value)));
}
function deferred<T>() {
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(r=>{resolve=r;});
 return {promise,resolve};
}
const ctors=new Map<string,(this:FakeNode,config:unknown)=>void>();
type FakeNode = {
 on:(event:string, cb:(...args:unknown[])=>void)=>void;
 error:(...args:unknown[])=>void;
 send:(msg:unknown)=>void;
 wires:string[][];
};
const RED={
 nodes:{
  registerType(type:string, ctor:(this:FakeNode,config:unknown)=>void){ctors.set(type,ctor);},
  createNode(node:FakeNode,config:{wires?:string[][]}){node.wires=config.wires??[[]];},
 },
 log:{info(){}}
} as never;
const pending={
 conversation:deferred<{text:string;artifacts:Array<Record<string,unknown>>}>(),
 module:deferred<{text:string;artifacts:Array<Record<string,unknown>>}>(),
 call:deferred<{text:string;artifacts:Array<Record<string,unknown>>}>(),
 branch:deferred<{port:number}>(),
};
let triggerEmit:((msg:Record<string,unknown>)=>void)|null=null;
let disposes=0;
registerMcodeNodePack(RED,()=>({
 agent:{run:async()=>({text:"ok",artifacts:[]})},
 conversation:{run:()=>pending.conversation.promise},
 branch:{decide:()=>pending.branch.promise},
 trigger:{subscribe:(_p:unknown,emit:(msg:Record<string,unknown>)=>void)=>{triggerEmit=emit;return ()=>{disposes++;};}},
 moduleCapability:{run:()=>pending.module.promise},
 nodeRedCall:{run:()=>pending.call.promise},
}) as never);
function create(type:string, config:Record<string,unknown>={}) {
 const listeners=new Map<string,Array<(...args:unknown[])=>void>>();
 const sent:unknown[]=[];
 const errors:unknown[]=[];
 const dones:unknown[]=[];
 const node:FakeNode={
  wires:[[]],
  on(event,fn){const list=listeners.get(event)??[];list.push(fn);listeners.set(event,list);},
  send(msg){sent.push(msg);},
  error(err){errors.push(err);},
 };
 const ctor=ctors.get(type);
 if(!ctor)throw new Error("not registered "+type);
 ctor.call(node,{id:"n1",wires:[["dest1"],["dest2"]],...config});
 return {
  sent,errors,dones,
  fire(msg:Record<string,unknown>={payload:"hello"}) {
   for(const fn of listeners.get("input")??[]) fn(msg,(result:unknown)=>sent.push(result),(err?:unknown)=>dones.push(err));
  },
  close() {for(const fn of listeners.get("close")??[])fn();}
 };
}
const tick=()=>new Promise<void>(r=>setImmediate(r));
const payload={text:"host-result",artifacts:[]};
const conversation=create(MCODE_CONVERSATION_NODE_TYPE);
conversation.fire();conversation.close();pending.conversation.resolve(payload);await tick();
check("★ closed conversation node must not publish late Host result",conversation.sent.length===0,conversation.sent);
check("closed conversation completes the pending input after Host settles",conversation.dones.length===1,conversation.dones);
const moduleNode=create(MCODE_MODULE_CAPABILITY_NODE_TYPE);
moduleNode.fire();moduleNode.close();pending.module.resolve(payload);await tick();
check("★ closed module node must not publish late Host result",moduleNode.sent.length===0,moduleNode.sent);
const httpNode=create(MCODE_NODE_RED_CALL_NODE_TYPE);
httpNode.fire();httpNode.close();pending.call.resolve({...payload});await tick();
check("★ closed Node-RED call node must not publish late Host result",httpNode.sent.length===0,httpNode.sent);
const branch=create(MCODE_BRANCH_NODE_TYPE);
branch.fire();branch.close();pending.branch.resolve({port:1});await tick();
check("★ closed branch node must not send into former outputs",branch.sent.length===0,branch.sent);
const trigger=create(MCODE_TRIGGER_NODE_TYPE);
const emit = triggerEmit as unknown as (msg:Record<string,unknown>)=>void;
if(typeof emit!=="function")throw new Error("missing trigger subscription");
emit({payload:"before-close"});
check("live trigger still sends native Node-RED message",trigger.sent.length===1,trigger.sent);
trigger.close();
emit({payload:"after-close"});
check("★ closed trigger ignores late queued event",trigger.sent.length===1,trigger.sent);
trigger.close();
check("trigger disposer only called once even after repeated close",disposes===1,disposes);
console.log(`mcode-node-close-race-smoke:${total-failed}/${total} PASS`);
if(failed)process.exitCode=1;
