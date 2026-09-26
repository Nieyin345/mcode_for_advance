import { ConversationQueue } from "@main/orchestration/conversationQueue.js";
import { runWorkflow, type RunPorts } from "@main/orchestration/scheduler.js";
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
let checks = 0, failed = 0;
function check(name: string, value: boolean): void { checks++; console.log(`${value ? "ok" : "FAIL"} ${name}`); if (!value) failed++; }
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const q = new ConversationQueue();
const signal = new AbortController().signal;
{
  const blocker = gate(), entered = gate(); const order: string[] = [];
  const first = q.run("same", signal, () => false, async () => { order.push("A"); entered.resolve(); await blocker.promise; order.push("A done"); });
  await entered.promise;
  const second = q.run("same", signal, () => false, async () => { order.push("B"); });
  const third = q.run("same", signal, () => false, async () => { order.push("C"); });
  await q.run("other", signal, () => false, async () => { order.push("other"); });
  check("other sessions progress while same session waits", order.join(",") === "A,other");
  blocker.resolve(); await Promise.all([first, second, third]);
  check("same target FIFO, no overlap", order.join(",") === "A,other,A done,B,C");
}
{
  const blocker = gate(), entered = gate(); const controller = new AbortController(); let ran = false;
  const first = q.run("cancel", signal, () => false, async () => { entered.resolve(); await blocker.promise; });
  await entered.promise;
  const next = q.run("cancel", controller.signal, () => false, async () => { ran = true; }).then(() => false, () => true);
  controller.abort(); check("queued cancellation settles before predecessor", await next);
  check("cancelled waiter has no side effects", !ran);
  blocker.resolve(); await first;
  check("cancel does not leak slot", await q.run("cancel", signal, () => false, async () => true));
}
{
  const controller = new AbortController(); controller.abort(); let ran = false;
  const rejected = await q.run("preabort", controller.signal, () => false, async () => { ran = true; }).then(() => false, () => true);
  check("pre-aborted turn never echoes or starts", rejected && !ran);
  const waiting = new AbortController();
  const busy = q.run("busy", waiting.signal, () => true, async () => { ran = true; }).then(() => false, () => true);
  await sleep(30); waiting.abort(); check("external busy wait is abortable", await busy && !ran);
  let external = true;
  const externalWait = q.run("busy", signal, () => external, async () => { ran = true; });
  await sleep(30); check("waits for user/provider-start phase", !ran);
  external = false; await externalWait; check("starts after external turn clears", ran);
}
{
  await q.run("failure", signal, () => false, async () => { throw new Error("fixture"); }).catch(() => {});
  check("task failure releases lease", await q.run("failure", signal, () => false, async () => true));
  const done = gate(); const accepted = await q.run("auto", signal, () => false, async (hold) => { hold(done.promise); return "accepted"; });
  check("auto returns without awaiting provider completion", accepted === "accepted");
  let ran = false;
  const next = q.run("auto", signal, () => false, async () => { ran = true; });
  await sleep(10); check("auto retains target lease until provider done", !ran);
  done.resolve(); await next; check("auto completion wakes next task", ran);
  const rejection = gate();
  await q.run("auto-error", signal, () => false, async (hold) => { hold(rejection.promise.then(() => { throw new Error("provider"); })); });
  const after = q.run("auto-error", signal, () => false, async () => true);
  rejection.resolve(); check("rejected detached provider also releases", await after);
}
{
  // Real scheduler, the same fan-out that previously returned one busy failure.
  const manifest: NodeTypeManifest = {id:"mcode.conversation",manifestVersion:1,name:"Conversation",runner:{kind:"conversation"},capability:"read",params:[{key:"instruction",kind:"longtext",label:"Instruction",required:true}]};
  const doc: WorkflowDoc={id:"queue-regression",name:"fanout",builtin:false,updatedAt:0,nodes:["A","B","C"].map(id=>({id,type:id==="A"?"mcode.main":"mcode.conversation",title:id,params:{instruction:"Reply"},position:{x:0,y:0}})),edges:[{id:"ab",from:"A",to:"B"},{id:"ac",from:"A",to:"C"}]};
  let busy = false, conflicts = 0; const replies: string[] = [];
  const ports: RunPorts = {
    async manifestOf(type){return {...manifest,id:type};},async manifestDirOf(){return undefined;},contextLines(){return [];},
    execute(node, _manifest, input) { return q.run("shared-conversation",input.signal,()=>busy,async () => {
      if (busy) { conflicts++; return {status:"failed" as const,summary:"",error:"busy"}; }
      busy=true; await sleep(10); replies.push(node.id); busy=false;
      return {status:"success" as const,summary:node.id};
    }); },async choose(){return {edgeId:""};},report(){},maxParallel(){return 4;},
  };
  const result=await runWorkflow({doc,prompt:"test",ports,signal});
  check("parallel conversation graph now succeeds", result.status === "success");
  check("no provider busy rejection", conflicts === 0);
  check("each node returns its own reply", ["A","B","C"].every(id=>result.outcomes.get(id)?.summary===id));
  check("all three nodes execute exactly once", replies.join(",") === "A,B,C");
}
console.log(`conversation-queue-smoke: ${checks-failed}/${checks} passed`);
if (failed) process.exitCode = 1;
