import { SceneBudgetAccounts } from "@main/orchestration/sceneTaskRegistry.js";
let total=0,failed=0;
const check=(name:string,ok:boolean,detail?:unknown):void=>{total++;console.log((ok?"ok ":"FAIL ")+name+(ok?"":" "+JSON.stringify(detail)));if(!ok)failed++;};
const bad=(result:{ok:boolean;code?:string},code:string)=>!result.ok && result.code===code;
const above=Number.MAX_SAFE_INTEGER+1;
const accounts = new SceneBudgetAccounts();
check("★ maxTokens outside safe integer range must not become a valid budget",
  bad(accounts.createAccount("badTokenLimit","scene",{maxTokens:above}),"INVALID_LIMITS"));
check("★ maxConcurrency outside safe integer range must not become a valid concurrency budget",
  bad(accounts.createAccount("badConcurrency","scene",{maxConcurrency:above}),"INVALID_LIMITS"));
check("valid normal token budget still accepted",accounts.createAccount("normal","scene",{maxTokens:10}).ok);
check("★ estimate tokens outside safe integer range rejected before counter update",
  bad(accounts.reserve("normal",{tokens:above,costUsd:0,concurrency:1},"taskA"),"INVALID_ESTIMATE"));
check("★ estimate concurrency outside safe integer range rejected before counter update",
  bad(accounts.reserve("normal",{tokens:1,costUsd:0,concurrency:above},"taskB"),"INVALID_ESTIMATE"));
check("no incorrect reservation survives malformed estimates",accounts.openReservationCount()===0);
const wide=new SceneBudgetAccounts();
check("unlimited account created",wide.createAccount("large","scene",{}).ok);
const huge=wide.reserve("large",{tokens:Number.MAX_SAFE_INTEGER,costUsd:0,concurrency:1},"huge");
check("single largest exact integer reservation still accepted",huge.ok);
const overflow=wide.reserve("large",{tokens:1,costUsd:0,concurrency:1},"overflow");
check("★ unlimited token ledger rejects addition past safe integer range",bad(overflow,"INVALID_ESTIMATE"),overflow);
check("★ arithmetic overflow cannot pollute reserved tokens",wide.getAccount("large")?.reservedTokens===Number.MAX_SAFE_INTEGER);
if(huge.ok)check("release removes the largest exact integer",wide.release(huge.value.reservationId).ok);
const costAccount=new SceneBudgetAccounts();costAccount.createAccount("cost","scene",{});
const maxCost=costAccount.reserve("cost",{tokens:0,costUsd:Number.MAX_VALUE,concurrency:1},"costA");
check("single max finite cost may be recorded",maxCost.ok);
const costOverflow=costAccount.reserve("cost",{tokens:0,costUsd:Number.MAX_VALUE,concurrency:1},"costB");
check("★ cost aggregation must reject Infinity instead of reporting an unlimited account",bad(costOverflow,"INVALID_ESTIMATE"),costOverflow);
check("★ overflow leaves reserved cost finite",Number.isFinite(costAccount.getAccount("cost")?.reservedCostUsd));
const settled=new SceneBudgetAccounts();settled.createAccount("settle","scene",{});
const first=settled.reserve("settle",{tokens:0,costUsd:0,concurrency:1},"first");
if(first.ok)check("settle maximum safe tokens accepted",settled.settle(first.value.reservationId,{tokens:Number.MAX_SAFE_INTEGER,costUsd:0}).ok);
const next=settled.reserve("settle",{tokens:1,costUsd:0,concurrency:1},"next");
check("★ settled token overflow cannot silently produce unsafe account totals",
  next.ok ? bad(settled.settle(next.value.reservationId,{tokens:1,costUsd:0}),"INVALID_USAGE") : bad(next,"INVALID_ESTIMATE"));
check("settled ledger stays exact",settled.getAccount("settle")?.committedTokens===Number.MAX_SAFE_INTEGER);
// Host invocations are TypeScript contracts, but can also come from restored
// JSON/SDK callbacks. Numeric NaN and malformed runtime states must not make
// fanout/deadline guards permanently ineffective.
const { SceneTaskRegistry } = await import("@main/orchestration/sceneTaskRegistry.js");
const inv = (id:string, change:Record<string,unknown>={}) => ({
  taskId:id,sceneId:"scene",parentTaskId:null,sessionId:null,
  originAgentId:"host",providerId:"claude-sdk",triggerOrigin:"scene",
  allowedCapabilities:["fs"],budgetAccountId:"budget",
  maxFanout:2,maxDepth:2,deadline:null,
  ...change,
}) as never;
for (const [label,change] of [
  ["empty task id",{taskId:""}],
  ["negative fanout",{maxFanout:-1}],
  ["NaN fanout",{maxFanout:NaN}],
  ["infinite fanout",{maxFanout:Infinity}],
  ["negative depth",{maxDepth:-1}],
  ["unsafe depth",{maxDepth:Number.MAX_SAFE_INTEGER+1}],
  ["nonfinite deadline",{deadline:NaN}],
  ["invalid capability list",{allowedCapabilities:["fs",32]}],
] as const) {
  const reg=new SceneTaskRegistry();
  const result=reg.createRootTask(inv("root",change));
  check("★ malformed root "+label+" is rejected before registry insert",bad(result,"INVALID_TASK"),result);
  check("malformed root "+label+" left registry empty",reg.getTask("root")===undefined);
}
const reg=new SceneTaskRegistry();
check("ordinary scene root remains valid",reg.createRootTask(inv("root")).ok);
check("★ malformed child fanout rejected",bad(reg.spawn("root",inv("child",{maxFanout:Infinity})),"INVALID_TASK"));
check("★ malformed child deadline rejected",bad(reg.spawn("root",inv("child2",{deadline:NaN})),"INVALID_TASK"));
check("★ malformed task state cannot circumvent descendant validation",
  bad(reg.setState("root","not-a-state" as never),"INVALID_TASK"));
check("malformed state did not replace pending",reg.getTask("root")?.state==="pending");
check("★ nonboolean external-action flag rejected",
  bad(reg.markExternalAction("root","false" as never),"INVALID_TASK"));
check("malformed external-action flag did not poison cancellation accounting",
  reg.getTask("root")?.externalActionInFlight===false);
const childAllowed=reg.spawn("root",inv("child",{parentTaskId:"root"}));
check("valid child spawn remains available",childAllowed.ok);
{
  const exposed=new SceneTaskRegistry();
  const rootResult=exposed.createRootTask(inv("root"));
  check("snapshot root setup succeeded",rootResult.ok);
  if(rootResult.ok) {
    // The returned result is delivered to SDK/UI consumers. They must not
    // receive a writable reference to internal Map state and bypass admission.
    rootResult.value.maxFanout=Number.MAX_SAFE_INTEGER;
    rootResult.value.maxDepth=Number.MAX_SAFE_INTEGER;
    rootResult.value.allowedCapabilities.push("shell");
    rootResult.value.state="completed";
    check("★ root registration result never mutates internal fanout/depth",
      exposed.getTask("root")?.maxFanout===2 && exposed.getTask("root")?.maxDepth===2);
    check("★ root result cannot grant extra capabilities",
      exposed.getTask("root")?.allowedCapabilities.join(",")==="fs");
    check("★ root result cannot overwrite task lifecycle state",
      exposed.getTask("root")?.state==="pending");
  }
  const childRegistry=new SceneTaskRegistry();
  childRegistry.createRootTask(inv("root"));
  const childResult=childRegistry.spawn("root",inv("child",{parentTaskId:"root"}));
  check("snapshot child setup succeeded",childResult.ok);
  if(childResult.ok) {
    childResult.value.sceneId="attacker-scene";
    childResult.value.allowedCapabilities.push("network");
    childResult.value.state="completed";
    check("★ returned child cannot forge registered scene or capabilities",
      childRegistry.getTask("child")?.sceneId==="scene" &&
      childRegistry.getTask("child")?.allowedCapabilities.join(",")==="fs");
    check("★ returned child cannot release fanout slot via forged terminal state",
      childRegistry.getTask("child")?.state==="pending" && childRegistry.activeChildCount("root")===1);
  }
}
{
  const stateRegistry=new SceneTaskRegistry();
  stateRegistry.createRootTask(inv("root"));
  const done=stateRegistry.setState("root","completed");
  check("terminal event setup can complete",done.ok);
  const version=stateRegistry.getTask("root")?.generation;
  const repeat=stateRegistry.setState("root","completed");
  check("★ duplicate completion event cannot bump a terminal task version",
    repeat.ok && stateRegistry.getTask("root")?.generation===version,repeat);
  check("★ repeated completion is idempotent for replay",
    repeat.ok && repeat.value.generation===version);
}
console.log("scene-budget-precision-smoke:"+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
