import {
  registerMcodeNodePack,
  runConversationNode,
  runModuleCapabilityNode,
  runNodeRedCallNode,
  runBranchNode,
  MCODE_CONVERSATION_NODE_TYPE,
  MCODE_MODULE_CAPABILITY_NODE_TYPE,
  MCODE_NODE_RED_CALL_NODE_TYPE,
  MCODE_BRANCH_NODE_TYPE,
  MCODE_TRIGGER_NODE_TYPE,
  triggerSubscribePayload,
  triggerMessage,
} from "@main/workflowEngines/mcodeNodeTypes.js";
import { createNodeInputLifecycle } from "@main/workflowEngines/mcodeNodePack.js";

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
conversation.fire();conversation.close();
check("★ conversation close settles pending input even if Host never responds",conversation.dones.length===1,conversation.dones);
conversation.close();
check("★ duplicate conversation close cannot finish input twice",conversation.dones.length===1,conversation.dones);
pending.conversation.resolve(payload);await tick();
check("★ closed conversation node must not publish late Host result",conversation.sent.length===0,conversation.sent);
check("closed conversation does not finish an input twice after late Host reply",conversation.dones.length===1,conversation.dones);
conversation.fire();
check("★ closed conversation input finishes with an error, never stays pending",conversation.dones.length===2&&conversation.dones[1] instanceof Error,conversation.dones);
const moduleNode=create(MCODE_MODULE_CAPABILITY_NODE_TYPE);
moduleNode.fire();moduleNode.fire();moduleNode.close();
check("★ module node settles two concurrent in-flight inputs at close",moduleNode.dones.length===2,moduleNode.dones);
pending.module.resolve(payload);await tick();
check("★ closed module node must not publish late Host result",moduleNode.sent.length===0,moduleNode.sent);
check("★ module Host late reply must not double-complete either input",moduleNode.dones.length===2,moduleNode.dones);
const httpNode=create(MCODE_NODE_RED_CALL_NODE_TYPE);
httpNode.fire();httpNode.close();
check("★ node-red-call settles pending input immediately on close",httpNode.dones.length===1,httpNode.dones);
pending.call.resolve({...payload});await tick();
check("★ closed Node-RED call node must not publish late Host result",httpNode.sent.length===0,httpNode.sent);
check("★ node-red-call late Host response cannot double-complete",httpNode.dones.length===1,httpNode.dones);
const branch=create(MCODE_BRANCH_NODE_TYPE);
branch.fire();branch.close();
check("★ branch close settles its pending Host decision before it returns",branch.dones.length===1,branch.dones);
pending.branch.resolve({port:1});await tick();
check("★ closed branch node must not send into former outputs",branch.sent.length===0,branch.sent);
check("★ late branch decision does not settle twice",branch.dones.length===1,branch.dones);
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
// Each Host node type also needs to guard the failure path, not just success.
// A rejected RPC after redeploy must not resurrect the old Catch/error side
// effect; an input delivered after close must never start a new Host action.
{
 const rejected=new Map<string,(error:Error)=>void>();
 const calls=new Map<string,number>();
 const neverUntilRejected=(name:string):Promise<never>=>{
  calls.set(name,(calls.get(name)??0)+1);
  return new Promise((_,reject)=>{rejected.set(name,reject);});
 };
 registerMcodeNodePack(RED,()=>({
  agent:{run:async()=>({text:"",artifacts:[]})},
  conversation:{run:()=>neverUntilRejected(MCODE_CONVERSATION_NODE_TYPE)},
  branch:{decide:()=>neverUntilRejected(MCODE_BRANCH_NODE_TYPE)},
  trigger:{subscribe:()=>()=>{}},
  moduleCapability:{run:()=>neverUntilRejected(MCODE_MODULE_CAPABILITY_NODE_TYPE)},
  nodeRedCall:{run:()=>neverUntilRejected(MCODE_NODE_RED_CALL_NODE_TYPE)},
 }) as never);
 for(const type of [MCODE_CONVERSATION_NODE_TYPE,MCODE_MODULE_CAPABILITY_NODE_TYPE,MCODE_NODE_RED_CALL_NODE_TYPE,MCODE_BRANCH_NODE_TYPE]){
  const n=create(type);
  n.fire();n.close();n.close();
  check("★ "+type+" close settles pending rejection once even before Host replies",n.dones.length===1,n.dones);
  rejected.get(type)!(new Error("late Host rejection"));
  await tick();
  check("★ "+type+" late rejection does not re-finish or report old error",
   n.dones.length===1&&n.errors.length===0&&n.sent.length===0,
   {dones:n.dones.length,errors:n.errors.length,sends:n.sent.length});
  n.fire();
  check("★ "+type+" input after close is rejected without any new Host request",
   n.dones.length===2&&n.dones[1] instanceof Error&&calls.get(type)===1,
   {dones:n.dones.length,calls:calls.get(type)});
 }
}
// All Host-backed node types must have the same authorization identity,
// invocation-time snapshot and cleared-output semantics as mcode-agent.
{
 type Run = (msg:Record<string,unknown>, config:Record<string,unknown>,
   host:(payload:Record<string,unknown>)=>Promise<unknown>)=>Promise<{msg:Record<string,unknown>}>;
 const runners: Array<{name:string;invoke:Run;hostResult:Record<string,unknown>}>=[
  {name:"conversation",invoke:(m,c,host)=>runConversationNode(m,c as never,{run:host} as never),hostResult:{text:"ok",artifacts:[]}},
  {name:"module",invoke:(m,c,host)=>runModuleCapabilityNode(m,c as never,{run:host} as never),hostResult:{text:"ok",artifacts:[]}},
  {name:"node-red-call",invoke:(m,c,host)=>runNodeRedCallNode(m,c as never,{run:host} as never),hostResult:{text:"ok",artifacts:[]}},
  {name:"branch",invoke:(m,c,host)=>runBranchNode(m,c as never,{decide:host} as never),hostResult:{port:0}},
 ];
 for(const {name,invoke,hostResult} of runners){
  let deniedCalls=0;
  let rejected=false;
  try {
   await invoke({}, {id:"",wires:[["target"]]},async()=>{deniedCalls++;return hostResult;});
  } catch {rejected=true;}
  check("★ "+name+" refuses missing node identity before any Host RPC",rejected&&deniedCalls===0,
   {rejected,deniedCalls});
  const incoming:{payload:{value:string};meta:string;mcode:Record<string,unknown>}={
    payload:{value:"original"},meta:"before",
    mcode:{runId:"r1",outputVar:"old-output",lineage:{value:"original"}},
  };
  const config:Record<string,unknown>={
   id:"valid",outputVar:"",wires:[["target"]],
   "x-mcode":{params:{nested:{permission:"original"}}},
  };
  let release!:(result:Record<string,unknown>)=>void;
  let seen:Record<string,unknown>|undefined;
  const response=new Promise<Record<string,unknown>>(resolve=>{release=resolve;});
  const pendingResult=invoke(incoming,config,async(payload)=>{seen=payload;return response;});
  incoming.payload.value="mutated";
  incoming.meta="after";
  (incoming.mcode.lineage as {value:string}).value="mutated";
  incoming.mcode.forgedGrant="yes";
  (((config["x-mcode"] as {params:{nested:{permission:string}}}).params).nested).permission="mutated";
  release(hostResult);
  const result=await pendingResult;
  check("★ "+name+" Host gets invocation-time input and params, not mutated references",
   (seen?.input as {value?:string})?.value==="original"
      && ((seen?.params as {nested?:{permission?:string}})?.nested?.permission==="original"),
   seen);
  const metadata=result.msg.mcode as Record<string,unknown>;
  check("★ "+name+" late Host result preserves original upstream provenance",
   result.msg.meta==="before"
      && (metadata.lineage as {value:string}).value==="original"
      && metadata.forgedGrant===undefined,
   {meta:result.msg.meta,metadata});
  check("★ "+name+" clearing native outputVar does not inherit stale upstream binding",
   !Object.prototype.hasOwnProperty.call(metadata,"outputVar"),metadata);
 }
}

// FULL-3: a trigger has no input callback: its subscription and emitted event
// must pass the same stable node-id / IPC-data boundary as Host input nodes.
{
 let invalidNodeRejected=false;
 try {
  triggerSubscribePayload({id:""} as never);
 } catch {invalidNodeRejected=true;}
 check("★ triggerSubscribePayload rejects missing native node identity",
  invalidNodeRejected,invalidNodeRejected);

 const original={nested:{kind:"before"}};
 const config={id:"trigger-valid","x-mcode":{params:original}} as never;
 const subscription=triggerSubscribePayload(config);
 original.nested.kind="after";
 check("★ trigger subscription params are invocation-time copied, not mutable editor references",
  (subscription.params["nested"] as {kind?:string})?.kind==="before",subscription.params);

 let invalidParamsRejected=false;
 try {triggerSubscribePayload({id:"trigger-valid","x-mcode":{params:{callback:()=>0}}} as never);}
 catch {invalidParamsRejected=true;}
 check("★ trigger uncloneable params rejected before subscribe",invalidParamsRejected);
 let invalidMessageRejected=false;
 try {triggerMessage({id:""} as never);}
 catch {invalidMessageRejected=true;}
 check("★ triggerMessage without native identity cannot create an apparently valid event",
  invalidMessageRejected);
}
{
 const nodeErrors:unknown[]=[];
 let sends:unknown[]=[];
 let emitted:((msg:Record<string,unknown>)=>void)|null=null;
 let subscribed=0;
 let disposed=0;
 const ctorsLocal=new Map<string,(this:FakeNode,config:unknown)=>void>();
 const localRed={
  nodes:{
   registerType(type:string,ctor:(this:FakeNode,config:unknown)=>void){ctorsLocal.set(type,ctor);},
   createNode(node:FakeNode,config:{wires?:string[][]}){node.wires=config.wires??[[]];},
  },log:{info(){}},
 } as never;
 registerMcodeNodePack(localRed,()=>({
  agent:{run:async()=>({text:"",artifacts:[]})},
  conversation:{run:async()=>({text:"",artifacts:[]})},
  branch:{decide:async()=>({port:0})},
  trigger:{subscribe:(payload:Record<string,unknown>,emit:(msg:Record<string,unknown>)=>void)=>{
   subscribed++;
   emitted=emit;
   // A Host port is a transport boundary, not a trusted object owner.
   // It may mutate its argument asynchronously or synchronously.
   payload.nodeId="transport-mutated-node";
   return ()=>{disposed++;};
  }},
  moduleCapability:{run:async()=>({text:"",artifacts:[]})},
  nodeRedCall:{run:async()=>({text:"",artifacts:[]})},
 }) as never);
 const listeners=new Map<string,Array<()=>void>>();
 const instance:FakeNode={
  wires:[[]],
  on(event,fn){const old=listeners.get(event)??[];old.push(fn as ()=>void);listeners.set(event,old);},
  send(msg){sends.push(msg);},error(error){nodeErrors.push(error);},
 };
 const ctor=ctorsLocal.get(MCODE_TRIGGER_NODE_TYPE)!;
 ctor.call(instance,{id:"trigger-real",wires:[[]]});
 check("★ trigger can subscribe with valid native Node-RED id",subscribed===1);
 const rejectedErrors:unknown[]=[];
 const forbidden:FakeNode={
  wires:[[]],
  on(){},send(){},error(err){rejectedErrors.push(err);},
 };
 ctor.call(forbidden,{id:"",wires:[[]]});
 check("★ invalid trigger node never reaches Host subscription; failure is visible",
   subscribed===1&&rejectedErrors.length===1,{subscribed,errors:rejectedErrors.length});
 const emit=emitted as unknown as (msg:Record<string,unknown>)=>void;
 const source={payload:{nested:{name:"before"}},mcode:{nodeId:"forged-id",runId:"forged-run",outputVar:"untrusted",
   engineStatus:200,branchPort:2,branchLabel:"spoof",triggerKind:"schedule",condition:true}};
 emit(source);
 source.payload.nested.name="after";
 check("★ trigger event uses trusted current node id, not source-forged identity",
  (sends[0] as {mcode?:{nodeId?:string}})?.mcode?.nodeId==="trigger-real",sends[0]);
 check("★ trigger event data detached from mutable Host emission object",
  (sends[0] as {payload?:{nested?:{name?:string}}})?.payload?.nested?.name==="before",sends[0]);
 const emittedMeta=(sends[0] as {mcode:Record<string,unknown>}).mcode;
 check("★ trigger 外部来源不得伪造 Host 已签发的 runId",
   emittedMeta.runId===null,emittedMeta);
 check("★ trigger 外部来源不能带入下游能力和分支路由权威",
   emittedMeta.outputVar===undefined && emittedMeta.engineStatus===undefined
     && emittedMeta.branchPort===undefined && emittedMeta.branchLabel===undefined,emittedMeta);
 check("★ trigger 只接受 Host 确认的 triggerKind 并保留合法 condition 标志",
   emittedMeta.triggerKind==="manual" && emittedMeta.condition===true,emittedMeta);
 emit(null as never);
 emit({mcode:"bad",payload:"incorrect metadata"} as never);
 emit({payload:{callback:()=>0}} as never);
 check("★ trigger malformed and uncloneable Host messages never escape as downstream sends",
  sends.length===1,sends);
 check("★ trigger malformed Host messages are explicitly reported, not silently discarded",
  nodeErrors.length===3,nodeErrors.length);
 for(const fn of listeners.get("close")??[])fn();
 for(const fn of listeners.get("close")??[])fn();
 check("★ trigger unsubscribe still idempotent after malformed events",disposed===1,disposed);
 emit({payload:"late"});
 check("★ trigger late Host event after close cannot send into deleted flow",sends.length===1);
}

// FULL-3 close exception isolation: one broken Node-RED done() callback
// must not stop the other outstanding input completions from being settled.
{
 let closeHandler!:()=>void;
 let settled=0;
 let seenError=0;
 const lifecycle=createNodeInputLifecycle({
  on:(event:string,fn:()=>void)=>{if(event==="close")closeHandler=fn;},
  error:()=>{seenError++;},
 } as never);
 lifecycle.begin(()=>{throw new Error("simulated Node-RED done failure");});
 lifecycle.begin(()=>{settled++;});
 let escaped=false;
 try {closeHandler();} catch {escaped=true;}
 check("★ close callback failure does not escape and skip sibling input completion",
   !escaped&&settled===1,{escaped,settled});
 check("★ failed Node-RED done is reported without losing other pending completions",
   seenError===1,{seenError});
 closeHandler();
 check("★ repeated close after one done throws stays idempotent",settled===1,settled);
}

  // Trigger ports can emit synchronously from subscribe() before they have
  // returned a disposer. Such events must not escape a failed subscription,
  // and a non-cancellable Host subscription is not an acceptable deployed
  // trigger (it would leave its scheduler alive after flow redeploy).
  {
    type TriggerHook = (payload: Record<string, unknown>,
      emit: (msg: Record<string, unknown>) => void) => unknown;
    const exercise = (subscribe: TriggerHook) => {
      const types = new Map<string, (this: FakeNode, config: unknown) => void>();
      const reds = {
        nodes: {
          registerType(type: string, ctor: (this: FakeNode, cfg: unknown) => void) { types.set(type, ctor); },
          createNode() {},
        }, log: { info() {} },
      } as never;
      registerMcodeNodePack(reds, () => ({
        agent: { run: async () => ({ text: "", artifacts: [] }) },
        conversation: { run: async () => ({ text: "", artifacts: [] }) },
        branch: { decide: async () => ({ port: 0 }) },
        trigger: { subscribe },
        moduleCapability: { run: async () => ({ text: "", artifacts: [] }) },
        nodeRedCall: { run: async () => ({ text: "", artifacts: [] }) },
      }) as never);
      const sends: unknown[] = [];
      const errors: unknown[] = [];
      const closers: Array<() => void> = [];
      const node: FakeNode = {
        wires: [[]],
        on(event, fn) { if (event === "close") closers.push(fn as () => void); },
        send(msg) { sends.push(msg); },
        error(err) { errors.push(err); },
      };
      types.get(MCODE_TRIGGER_NODE_TYPE)!.call(node, { id: "sync-subscribe" });
      return { sends, errors, close() { for (const close of closers) close(); } };
    };
    const event = { payload: { trigger: { kind: "manual", at: 1 } } };
    let badEmit: ((msg: Record<string, unknown>) => void) | null = null;
    const bad = exercise((_params, emit) => {
      badEmit = emit;
      emit(event);
      throw new Error("Host failed while subscribing");
    });
    check("★ subscribe 同步 emit 后失败不可泄漏未生效 trigger", bad.sends.length === 0, bad.sends);
    check("★ subscribe 失败向 Node-RED 显式报告", bad.errors.length === 1, bad.errors.length);
    (badEmit as unknown as (m: Record<string, unknown>) => void)(event);
    check("★ 订阅失败后 Host 迟到回调仍不能发布", bad.sends.length === 0, bad.sends);
    let undone = 0;
    const accepted = exercise((_params, emit) => {
      emit(event);
      return () => { undone++; };
    });
    check("★ subscribe 同步 emit 且成功返回 disposer 的事件不丢失",
      accepted.sends.length === 1, accepted.sends);
    accepted.close();
    accepted.close();
    check("★ 有效同步订阅在重复 close 下只退订一次", undone === 1, undone);
    const boundary = exercise((_params, emit) => {
      for (let i = 0; i < 256; i++) emit({ payload: { sequence: i } });
      return () => {};
    });
    check("★ 有限同步订阅缓冲上限内 256 条事件按原顺序完整发布",
      boundary.errors.length === 0 && boundary.sends.length === 256
        && (boundary.sends[0] as {payload?:{sequence?:number}})?.payload?.sequence === 0
        && (boundary.sends[255] as {payload?:{sequence?:number}})?.payload?.sequence === 255,
      {errors: boundary.errors.length, sends: boundary.sends.length});
    boundary.close();
    let orphanEmit: ((msg: Record<string, unknown>) => void) | null = null;
    const orphan = exercise((_params, emit) => {
      orphanEmit = emit;
      emit(event);
      return undefined;
    });
    check("★ 不返回取消函数的 Host 订阅必须失败关闭而非保留游离 Trigger",
      orphan.sends.length === 0, orphan.sends);
    check("★ Host 订阅没有 disposer 必须向 Node-RED 明确报错",
      orphan.errors.length === 1, orphan.errors.length);
    (orphanEmit as unknown as (m: Record<string, unknown>) => void)(event);
    check("★ 无法取消的订阅失败后不得再发送后续事件",
      orphan.sends.length === 0, orphan.sends);
  }


// A synchronous Host event burst cannot allocate an unbounded queue while
// subscribe() is still negotiating cancellation. Once the boundary is
// exceeded, fail closed, dispose once, and never publish a partial burst.
{
 const types=new Map<string,(this:FakeNode,config:unknown)=>void>();
 let cancelled=0;
 let emits:((value:Record<string,unknown>)=>void)|null=null;
 const red={nodes:{
  registerType:(type:string,ctor:(this:FakeNode,config:unknown)=>void)=>{types.set(type,ctor);},
  createNode:()=>{},
 },log:{info:()=>{}}} as never;
 registerMcodeNodePack(red,()=>({
  agent:{run:async()=>({text:"",artifacts:[]})},
  conversation:{run:async()=>({text:"",artifacts:[]})},
  branch:{decide:async()=>({port:0})},
  trigger:{subscribe:(_p:unknown,emit:(value:Record<string,unknown>)=>void)=>{
    emits=emit;
    for(let i=0;i<300;i++) emit({payload:{sequence:i}});
    return ()=>{cancelled++;};
  }},
  moduleCapability:{run:async()=>({text:"",artifacts:[]})},
  nodeRedCall:{run:async()=>({text:"",artifacts:[]})},
 }) as never);
 const errors:unknown[]=[];const sent:unknown[]=[];const closeHandlers:Array<()=>void>=[];
 const node:FakeNode={wires:[[]],
  on:(event,cb)=>{if(event==="close")closeHandlers.push(cb as ()=>void);},
  send:(value)=>{sent.push(value);},
  error:(value)=>{errors.push(value);},
 };
 types.get(MCODE_TRIGGER_NODE_TYPE)!.call(node,{id:"flood-test"});
 check("★ synchronous trigger burst over safety limit must not publish partial results",
   sent.length===0,sent.length);
 check("★ synchronous trigger flood must report an explicit failure once",
   errors.length===1,errors.map(String));
 check("★ synchronous trigger flood must dispose its active Host subscription",
   cancelled===1,cancelled);
 for(const close of closeHandlers)close();
 (emits as unknown as (value:Record<string,unknown>)=>void)({payload:"late"});
 check("★ flood failure and late callback stay closed and idempotent",
   sent.length===0&&cancelled===1,{sent:sent.length,cancelled});
}
// A Host cancellation callback may itself throw. Report the failed release to
// Node-RED instead of silently pretending the source was cancelled.
{
 const types=new Map<string,(this:FakeNode,config:unknown)=>void>();
 registerMcodeNodePack({nodes:{
  registerType:(type:string,ctor:(this:FakeNode,config:unknown)=>void)=>{types.set(type,ctor);},
  createNode:()=>{},
 },log:{info:()=>{}}} as never,()=>({
  agent:{run:async()=>({text:"",artifacts:[]})},
  conversation:{run:async()=>({text:"",artifacts:[]})},
  branch:{decide:async()=>({port:0})},
  trigger:{subscribe:()=>()=>{throw new Error("Host cancellation failed");}},
  moduleCapability:{run:async()=>({text:"",artifacts:[]})},
  nodeRedCall:{run:async()=>({text:"",artifacts:[]})},
 }) as never);
 const errors:unknown[]=[];const closeHandlers:Array<()=>void>=[];
 const node:FakeNode={wires:[[]],
  on:(event,cb)=>{if(event==="close")closeHandlers.push(cb as ()=>void);},
  send:()=>{},error:(value)=>{errors.push(value);},
 };
 types.get(MCODE_TRIGGER_NODE_TYPE)!.call(node,{id:"cancel-error"});
 for(const close of closeHandlers)close();
 for(const close of closeHandlers)close();
 check("★ Host disposer throwing must be reported once, not silently discarded",
   errors.length===1&&String(errors[0]).includes("cancellation failed"),errors.map(String));
}


// Conversation/module/Node-RED-call all share the Host result snapshot rather
// than publishing mutable Host-owned references or uncloneable artifact extras.
{
 const runners=[
  {name:"conversation",run:(result:Record<string,unknown>)=>
    runConversationNode({payload:"in"},{id:"snapshot-conversation"} as never,{run:async()=>result} as never)},
  {name:"module",run:(result:Record<string,unknown>)=>
    runModuleCapabilityNode({payload:"in"},{id:"snapshot-module"} as never,{run:async()=>result} as never)},
  {name:"node-red-call",run:(result:Record<string,unknown>)=>
    runNodeRedCallNode({payload:"in"},{id:"snapshot-call"} as never,{run:async()=>result} as never)},
 ];
 for(const {name,run} of runners){
  const artifact={kind:"file",uri:"file:///original"};
  const hostResult={text:"original",artifacts:[artifact],runId:"host-run"};
  const outcome=await run(hostResult);
  artifact.uri="file:///changed-later";
  hostResult.text="changed later";
  const payload=outcome.msg.payload as {text:string;artifacts:Array<{uri:string}>};
  check("★ "+name+" published artifact must be detached from later Host mutation",
    payload.text==="original"&&payload.artifacts[0]?.uri==="file:///original",payload);
  let rejected=false;
  try{
   await run({text:"bad",artifacts:[{kind:"file",uri:"file:///ok",extra:()=>1}]});
  }catch{rejected=true;}
  check("★ "+name+" rejects uncloneable Host artifact extras before publish",
    rejected,rejected);
 }
}

// Malformed native wires are not a trusted target count for a Host routing
// decision; a restored flow could otherwise route into a synthetic output.
{
 for(const wires of ["not-an-array",[123],[["valid"],["valid",5]]]){
  let calls=0;let rejected=false;
  try{
   await runBranchNode({}, {id:"invalid-wires",wires} as never, {
    decide:async()=>{calls++;return {port:0};},
   });
  }catch{rejected=true;}
  check("★ invalid Node-RED wires must be rejected before Host branch decision",
    rejected&&calls===0,{wires,rejected,calls});
 }
}

console.log(`mcode-node-close-race-smoke:${total-failed}/${total} PASS`);
if(failed)process.exitCode=1;
