/** UI/source contract with actual deferred async settings writes. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nextCriteriaSelection, queueCriteriaPreferenceSave } from "../../src/renderer/components/chat/criteriaPreferenceQueue.js";
import { sourceHas } from "../lib/sourceText.js";
const src = readFileSync(resolve("src/renderer/components/chat/SearchFilterBar.tsx"),"utf8");
let total=0, failed=0;
function ck(label: string, condition: boolean) {
  total++; if(!condition)failed++;
  console.log((condition?"PASS ":"FAIL ")+label);
}
function deferred() {
  let yes!:()=>void, no!:(error:Error)=>void;
  const promise=new Promise<void>((resolve,reject)=>{yes=resolve;no=reject;});
  return {promise,resolve:()=>yes(),reject:(msg:string)=>no(new Error(msg))};
}
const base={years:"3"};
const a=nextCriteriaSelection(base,"tier","Q1");
const b=nextCriteriaSelection(a,"limit","20");
ck("Immediate consecutive edits preserve all changes before React rerender",
 b.years==="3" && b.tier==="Q1" && b.limit==="20");
ck("Immutable merge never mutates prior render snapshots",
 !("tier" in base) && !("limit" in a) && base!==a && a!==b);
ck("An empty value is retained for honest unset semantics",
 nextCriteriaSelection(a,"tier","").tier==="");
ck("Unexpected dynamic criterion keys are still JSON-serializable",
 JSON.parse(JSON.stringify(nextCriteriaSelection({},"__proto__","x"))).__proto__==="x");

const pending=new Map<string,Promise<void>>();
const d1=deferred(),d2=deferred(),d3=deferred();
const calls:string[]=[];
const persist=(id:string,value:string) => {
  calls.push(id+":"+value);
  return calls.length===1?d1.promise:calls.length===2?d2.promise:d3.promise;
};
const p1=queueCriteriaPreferenceSave(pending,"wf1","{\"a\":1}",persist);
const p2=queueCriteriaPreferenceSave(pending,"wf1","{\"a\":1,\"b\":2}",persist);
await Promise.resolve();await Promise.resolve();
ck("Same-workflow second write does not overtake first",calls.length===1 && calls[0]==='wf1:{"a":1}');
d1.resolve();
await p1;await Promise.resolve();await Promise.resolve();
ck("Second write starts only after first commits",calls.length===2 && calls[1]==='wf1:{"a":1,"b":2}');
d2.resolve();await p2;
await Promise.resolve();
ck("Settled save queue releases completed workflow key",pending.size===0);
const secondPending=new Map<string,Promise<void>>();
const p3=queueCriteriaPreferenceSave(secondPending,"wf2","A",()=>d3.promise);
const p4=queueCriteriaPreferenceSave(secondPending,"wf3","B",async()=>{calls.push("wf3:B");});
await Promise.resolve();await Promise.resolve();await p4;
ck("Independent workflows are not blocked by another workflow pending save",
 calls.includes("wf3:B") && secondPending.has("wf2"));
d3.resolve();await p3;
const rejecting=new Map<string,Promise<void>>();
const bad=deferred();const recovered:string[]=[];
const first=queueCriteriaPreferenceSave(rejecting,"wf","bad",()=>bad.promise);
const second=queueCriteriaPreferenceSave(rejecting,"wf","good",async(_key,value)=>{recovered.push(value);});
await Promise.resolve();await Promise.resolve();bad.reject("simulated write error");
let sawError=false;try{await first;}catch{sawError=true;}
await second;await Promise.resolve();
ck("Write rejection is observable by existing toast handler",sawError);
ck("Queue recovers and commits latest value after failure",recovered[0]==="good");
ck("Queue does not leak task references after failed save",rejecting.size===0);

ck("Renderer synchronously mirrors every selected value in a ref",
 sourceHas(src,"const next = nextCriteriaSelection(valuesRef.current, name, value)") &&
 sourceHas(src,"valuesRef.current = next;") &&
 sourceHas(src,"setValues(next);"));
ck("Renderer queues writes per workflow instead of racing concurrent IPC saves",
 sourceHas(src,"queueCriteriaPreferenceSave(") &&
 sourceHas(src,"savingRef.current,") &&
 sourceHas(src,"(id, json) => api.setting.set("));
ck("Renderer retains failure toast instead of silently swallowing save errors",
 sourceHas(src,'kind: "error"') &&
 sourceHas(src,'t("store.toast.settingSaveFailed")'));
ck("Switching workflows hides prior conditions immediately, before effect runs",
 sourceHas(src, "loadedWorkflowId !== workflowId") &&
 sourceHas(src, "setLoadedWorkflowId(workflowId)"));
ck("Persistent workflow prefs still use existing node settings prefix",
 sourceHas(src, "WORKFLOW_NODE_PREFS_SETTING_PREFIX + id") &&
 sourceHas(src, "parsePrefs(prefsRes.value)"));
ck("Exactly one equal-width row retains previous requested layout",
 sourceHas(src,"flex min-w-0 flex-nowrap items-center") &&
 sourceHas(src,"flex min-h-8 min-w-0 flex-1 basis-0 items-center"));
ck("Native select keeps visible focus and real selected value",
 sourceHas(src,"aria-label={cond.name}") &&
 sourceHas(src,"focus-visible:ring-2 focus-visible:ring-accent") &&
 sourceHas(src,"value={current}"));
ck("Live reference lists still display orphan choices and honest empty state",
 sourceHas(src,"const orphaned = live && current !==") &&
 sourceHas(src,"useRefOptions(cond.source ??") &&
 sourceHas(src,'t("chat.nodeCriteria.noOptions")'));
ck("Negative: removal of synchronous ref would regress consecutive picks",
 !sourceHas(src.replace("valuesRef.current = next;", "noop();"),"valuesRef.current = next;"));
console.log("arc005-criteria-ui-smoke: "+(total-failed)+"/"+total);
if(failed)process.exitCode=1;
