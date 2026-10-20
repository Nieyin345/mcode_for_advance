/** ARC-006: legacy runner and Node-RED must interpret the SAME trust record.
 * All SettingRepo writes use an in-memory stub, no real DB or user workflow. */
import * as repositoryModule from "@main/store/repositories.js";
const { SettingRepo } = repositoryModule;
// This extra mutation hook exists ONLY in the esbuild-aliased smoke stub.
// Production SettingRepo deliberately has no such API. Access it through an
// explicit test-only structural cast to keep Desktop tsc free of fake exports.
const changeAfterNextRead = (repositoryModule as typeof repositoryModule & {
  changeAfterNextRead: (key: string, replacement: string) => void;
}).changeAfterNextRead;
const changeBeforeNextWrite = (repositoryModule as typeof repositoryModule & {
  changeBeforeNextWrite: (key: string, replacement: string) => void;
}).changeBeforeNextWrite;
import { approveWorkflowRevision, workflowReviewOf, workflowRevision } from "../../src/main/orchestration/workflowTrust.js";
import { flowExecutableUnderTrust } from "../../src/main/workflowEngines/flowTrustGate.js";
import type { WorkflowDoc } from "@contracts/workflow";
let total=0,failed=0;
function check(name:string,condition:boolean,detail?:unknown):void{
  total++;console.log((condition?"PASS ":"FAIL ")+name+(condition?"":" "+JSON.stringify(detail)));
  if(!condition) failed++;
}
const doc={id:"fake-flow",name:"Fixture",nodes:[],edges:[],updatedAt:0,builtin:false} as WorkflowDoc;
const key="workflow.review.v1."+doc.id;
const revision=workflowRevision(doc);
const record=(additional:Record<string,unknown>={})=>
  JSON.stringify({origin:"ai",approvedRevision:revision,...additional});
const legacyPending=()=>workflowReviewOf(doc)?.pending;
const nodeRedDenied=(raw:string)=>!flowExecutableUnderTrust(revision,raw).ok;
check("absence of review record keeps legacy local flow behavior",workflowReviewOf(doc)===null);
for(const [name,raw] of [
  ["valid historical approval",record()],
  ["valid current timestamp",record({reviewedAt:1760000000000})],
] as const){
  SettingRepo.set(key,raw);
  check(name+" legacy execution remains approved",legacyPending()===false);
  check(name+" Node-RED gate also approves",!nodeRedDenied(raw));
}
for(const [name,raw] of [
  ["invalid timestamp",record({reviewedAt:"yesterday"})],
  ["unbounded oversized record",record({padding:"x".repeat(128*1024)})],
  ["broken JSON","{not-json"],
  ["invalid approved revision",record({approvedRevision:"invalid"})],
] as const){
  SettingRepo.set(key,raw);
  check(name+" must be pending to legacy runner",legacyPending()===true,legacyPending());
  check(name+" must be denied by Node-RED gate",nodeRedDenied(raw));
  // Corrupt settings must not be silently normalized into a new successful
  // approval record by the standard UI approve action.
  const action = approveWorkflowRevision(doc, revision);
  check(name+" cannot be silently reapproved until corrupt ledger is repaired", !action.ok);
  check(name+" approval attempt preserves the corrupt original for diagnosis",SettingRepo.get(key)===raw);
}
SettingRepo.set(key,JSON.stringify({origin:"ai",approvedRevision:null}));
check("explicit pending review remains blocked by legacy runner",legacyPending()===true);
check("human approval of a healthy pending revision still succeeds",approveWorkflowRevision(doc,revision).ok);
check("approved healthy record is executable after human review",legacyPending()===false);
// A renderer can approve an old read while a concurrent window changes the
// record. The original approve path reads the marker TWICE, and the second
// read can observe a corrupt record which gets silently rewritten as approved.
{
  const initial=record();
  const damaged="{\"origin\":\"ai\",\"approvedRevision\":true}";
  SettingRepo.set(key,initial);
  changeAfterNextRead(key,damaged);
  const result=approveWorkflowRevision(doc,revision);
  check("★ changed approval marker during review must not return successful approval",!result.ok,result);
  check("★ concurrent damaged marker remains untouched for diagnosis",SettingRepo.get(key)===damaged,SettingRepo.get(key));
}
// Ordinary stable approval still works after the optimistic recheck.
SettingRepo.set(key,JSON.stringify({origin:"ai",approvedRevision:null}));
check("★ stable pending record is still approvable after concurrency guard",
  approveWorkflowRevision(doc,revision).ok===true);
// The final get() and set() in a naive optimistic guard are TWO separate
// operations. Simulate a concurrent edit precisely between them: only the
// repository's compare-and-set single statement can reject that race.
{
  const pending=JSON.stringify({origin:"ai",approvedRevision:null});
  const hostile=JSON.stringify({origin:"ai",approvedRevision:false});
  SettingRepo.set(key,pending);
  changeBeforeNextWrite(key,hostile);
  const result=approveWorkflowRevision(doc,revision);
  check("★ approval uses atomic compare-and-set rather than a final separate get+set",!result.ok,result);
  check("★ last-moment concurrent edit is retained, not laundered as consent",SettingRepo.get(key)===hostile,SettingRepo.get(key));
}
SettingRepo.set(key,JSON.stringify({origin:"ai",approvedRevision:null}));
check("★ normal pending review still approves through conditional CAS",approveWorkflowRevision(doc,revision).ok===true);
console.log(`arc006-trust-consistency-smoke: ${total-failed}/${total}`);
if(failed)process.exitCode=1;
