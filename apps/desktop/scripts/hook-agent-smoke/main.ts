/**
 * T63: real HookRunner event -> action grant -> persisted child -> agent/workflow
 * dispatch. Only provider/workflow execution are stubbed; no real AI or user data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_PROMPT_PARAM_KEY } from "@contracts/nodeType";
import { hookActionOf, type HookSpec } from "@contracts/hook";
import { runtimeManager, sent, bound } from "./stubs/runtimeManager.js";
import { runs } from "./stubs/workflow.js";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { saveAgentProfile } from "@main/orchestration/agentProfiles.js";
import { writeHooks } from "@main/hooks/store.js";
import { hookRunner } from "@main/hooks/HookRunner.js";
import { authoredHookSourceOf, issueHostHookGrant, resetHostHookGrants } from "@main/hooks/hostHookGrants.js";
import { launchHookAction } from "@main/hooks/agentActions.js";
import type { Session } from "@contracts/session";

let checks = 0;
let fails = 0;
const check = (name: string, okay: boolean, actual?: unknown): void => {
  checks++;
  if (!okay) { fails++; console.log(" FAIL "+name+" "+JSON.stringify(actual)); }
  else console.log(" ok "+name);
};
const until = async (cond: () => boolean): Promise<void> => {
  for (let i=0;i<150;i++) {
    if (cond()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("T63 dispatch timeout");
};
await initDb();
const work = mkdtempSync(join(tmpdir(), "t63-agent-work-"));
const now = Date.now();
const projectId="p_t63";
ProjectRepo.create({ id:projectId, name:"T63", path:work, archived:false, group:null,sortOrder:0,
  pinnedAt:null,createdAt:now,updatedAt:now });
const session:Session = {
  id:"sess_t63", projectId, providerId:"claude-sdk", claudeSessionId:null,
  kind:"chat",parentSessionId:null,nodeId:null,title:"T63",status:"idle",
  model:"default",effort:"default",permissionMode:"default",workflowId:"default",
  customModelId:null, envMode:"local",worktreePath:null,
  archived:false,pinnedAt:null,contextSnapshot:null,todos:null,subagents:null,
  planDraft:null,turnFiles:null,usageHistory:null,bookmarks:null,subagentTranscripts:null,
  createdAt:now,updatedAt:now,hookDepth:1,
};
SessionRepo.create(session);
const profileId="p_t63_smoke";
const profileResult=saveAgentProfile({version:1,id:profileId,name:"T63 agent",type:"mcode.agent",
 params:{ [NODE_PROMPT_PARAM_KEY]:"Assist the T63 smoke" },createdAt:now,updatedAt:now});
check("T63: saved profile fixture",profileResult.ok,profileResult);
const actionSpec:HookSpec = {
 id:"h_t63_realagent",name:"T63 profile",event:"tool.use",enabled:true,command:"",
 action:{kind:"agent",profileId},matcher:"Write",
};
hookRunner.setHookRunSink(null);
hookRunner.setPluginHookSource(() => []);
hookRunner.setActionLauncher(launchHookAction);
hookRunner.start();
writeHooks([actionSpec]);
const emit=(id:string)=>runtimeManager.emit({
 type:"tool.use",sessionId:session.id,toolName:"Write",toolCallId:id,input:{file_path:"src/t63.ts"},requiresApproval:false,
});
resetHostHookGrants();
emit("t63_denied");
await until(() => (hookRunner.deliveryCountsOf(actionSpec.id)?.denied??0)>=1);
check("T63: no permission means no physical agent call",sent.length===0,sent.length);
const src=authoredHookSourceOf(actionSpec);
issueHostHookGrant({pluginId:src.pluginId,events:[src.nativeEvent],commandDigest:src.commandDigest,
 matcherDigest:src.matcherDigest,actionKind:"agent",maxRuns:4,ttlMs:60_000,now:Date.now()});
emit("t63_granted");
await until(() => sent.length===1);
check("T63: runner actually invoked agent SDK entry",sent.length===1,sent.length);
const child=sent[0].session;
check("T63: child is a distinct persisted session",child.id!==session.id && SessionRepo.get(child.id)?.id===child.id,child.id);
check("T63: child retains profile snapshot",child.agentProfile?.id===profileId,child.agentProfile);
check("T63: child inherits depth 2",SessionRepo.get(child.id)?.hookDepth===2,SessionRepo.get(child.id)?.hookDepth);
check("T63: child provider is bound",bound.includes(child.id),bound);
const injected=JSON.parse(sent[0].prompt) as {event:string;session:{id:string};data:{input:{file_path:string}};hookDepth:number};
check("T63: original hook payload flows to agent prompt",injected.event==="tool.use"
 && injected.session.id===session.id && injected.data.input.file_path==="src/t63.ts"
 && injected.hookDepth===1,injected);
const wf:HookSpec={...actionSpec,id:"h_t63_workflow",name:"T63 workflow",
 action:{kind:"workflow",workflowId:"wf_t63_valid"} };
writeHooks([wf]);
const ws=authoredHookSourceOf(wf);
issueHostHookGrant({pluginId:ws.pluginId,events:[ws.nativeEvent],commandDigest:ws.commandDigest,
 matcherDigest:ws.matcherDigest,actionKind:"workflow",maxRuns:4,ttlMs:60_000,now:Date.now()});
runtimeManager.emit({type:"tool.use",sessionId:session.id,toolName:"Write",toolCallId:"t63_workflow",
 input:{payload:"workflow"},requiresApproval:false});
await until(()=>runs.length===1);
check("T63: real workflow launcher is invoked",runs[0].session.workflowId==="wf_t63_valid",runs[0].session.workflowId);
check("T63: workflow child persisted depth",SessionRepo.get(runs[0].session.id)?.hookDepth===2);
check("T63: workflow prompt contains event",runs[0].prompt?.includes("t63_workflow")===true,runs[0].prompt);
check("T63: workflow action never uses shell",hookActionOf(wf).kind==="workflow");
resetHostHookGrants();
writeHooks([]);
rmSync(work,{recursive:true,force:true});
console.log(`hook-agent-smoke:${checks-fails}/${checks} passed`);
if (fails) process.exitCode=1;
