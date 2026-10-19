/**
 * ARC-006 - workflow stored-doc fail-closed and workflow-run ID ownership.
 * Real isolated sql.js, entirely synthetic data; never the user's database.
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories/project.js";
import { SessionRepo } from "@main/store/repositories/session.js";
import { WorkflowRepo } from "@main/store/repositories/workflow.js";
import { WorkflowRunRepo } from "@main/store/repositories/workflowRun.js";
import type { Project, Session } from "@contracts/session";
import type { WorkflowDoc } from "@contracts/workflow";

let checks = 0, failures = 0;
function check(name:string,pass:boolean,data?:unknown):void {
  checks++;
  if(pass) console.log("  ok   "+name);
  else {failures++;console.log("  FAIL "+name+" "+(data===undefined?"":JSON.stringify(data)));}
}
function equal(name:string,a:unknown,b:unknown):void {
  check(name,JSON.stringify(a)===JSON.stringify(b),{actual:a,expected:b});
}
function error(name:string,fn:()=>unknown):void {
  let err="";
  try {fn()}catch(e){err=String(e)}
  check(name,err.includes("损坏")||err.includes("归属")||err.includes("不匹配"),err);
}
await initDb();
const db=getDb();
const doc:WorkflowDoc={id:"wf_owner",name:"Owner",nodes:[],edges:[],builtin:false,updatedAt:1};
WorkflowRepo.save(doc);
const readPayload=():unknown=>db.exec("SELECT payload FROM workflows WHERE id = 'wf_owner'")[0]?.values[0]?.[0];
const goodRaw=String(readPayload());
equal("normal workflow.get id",WorkflowRepo.get(doc.id)?.doc.id,doc.id);
equal("normal workflow.list id",WorkflowRepo.list().find(x=>x.id===doc.id)?.doc.id,doc.id);
for(const [label,broken] of [
  ["truncated JSON","{broken-json"],
  ["JSON null","null"],
  ["wrong structure",'{"id":"wf_owner","name":"bad","nodes":"oops","edges":[],"builtin":false,"updatedAt":1}'],
  ["ID mismatch",JSON.stringify({...doc,id:"wf_other"})],
] as const) {
  db.run("UPDATE workflows SET payload = ? WHERE id = ?",[broken,doc.id]);
  error(label+": repository get refuses to fabricate empty graph",()=>WorkflowRepo.get(doc.id));
  error(label+": repository list refuses to fabricate empty graph",()=>WorkflowRepo.list());
  error(label+": repository save rejects overwrite of corrupt existing doc",()=>WorkflowRepo.save(doc));
  equal(label+": original persisted payload bytes survive all attempts",readPayload(),broken);
}
db.run("UPDATE workflows SET payload = ? WHERE id = ?",[goodRaw,doc.id]);
equal("normal workflow.get restored real nodes",WorkflowRepo.get(doc.id)?.doc.nodes,[]);

// Exercise actual repository Statement handling with injected SQL errors.
const wrapped=db as unknown as {prepare:(sql:string)=>unknown};
const realPrepare=wrapped.prepare;
for(const [name,match,invoke] of [
  ["workflow.get","SELECT * FROM workflows WHERE id",()=>WorkflowRepo.get(doc.id)],
  ["workflow.list","SELECT * FROM workflows ORDER BY",()=>WorkflowRepo.list()],
  ["workflow.save(max)","SELECT COALESCE(MAX(sort_order)",()=>WorkflowRepo.save({...doc,id:"wf_new_from_fault"})],
] as const) {
  for(const stage of ["step","row"] as const) {
    let freed=0,hits=0;
    const thrown=new Error("FAULT_"+name+"_"+stage);
    wrapped.prepare=(sql:string)=>{
      if(!sql.includes(match)) return realPrepare.call(db,sql);
      hits++;
      return {
        bind:()=>{},
        step:()=>{if(stage==="step")throw thrown;return true;},
        getAsObject:()=>{if(stage==="row")throw thrown;return {id:doc.id,name:doc.name,description:null,icon:null,builtin:0,payload:goodRaw,updated_at:1,next:1};},
        free:()=>{freed++;},
      };
    };
    let caught:unknown=null;
    try {invoke();}catch(e){caught=e} finally {wrapped.prepare=realPrepare}
    check(name+"/"+stage+": original SQL fault propagated",caught===thrown,{error:String(caught)});
    check(name+"/"+stage+": statement freed exactly once",freed===1&&hits===1,{freed,hits});
  }
}

// Workflow run IDs are global primary keys. Saving a foreign session's run
// with same ID used to overwrite the original run's status/payload silently.
const now=Date.now();
const project:Project={id:"p-workflow-integrity",name:"Smoke",path:"/isolated-workflow",archived:false,group:null,sortOrder:0,pinnedAt:null,createdAt:now,updatedAt:now};
ProjectRepo.create(project);
const session=(id:string):Session=>({
  id,projectId:project.id,providerId:"claude-sdk",claudeSessionId:null,kind:"chat",
  parentSessionId:null,nodeId:null,agentProfile:null,title:id,status:"idle",
  model:"default",effort:"default",permissionMode:"default",workflowId:"default",
  customModelId:null,archived:false,pinnedAt:null,contextSnapshot:null,
  todos:null,subagents:null,planDraft:null,usageHistory:null,turnFiles:null,
  subagentTranscripts:null,bookmarks:null,createdAt:now,updatedAt:now
} as Session);
SessionRepo.create(session("wf_session_a"));
SessionRepo.create(session("wf_session_b"));
const original={id:"run_collide",sessionId:"wf_session_a",workflowId:"wf_owner",status:"running" as const,payload:'{"phase":"original"}',awaiting:["node_a"]};
WorkflowRunRepo.save(original);
const originalRun=WorkflowRunRepo.get("run_collide");
error("run ID collision from other session rejected",()=>WorkflowRunRepo.save({...original,sessionId:"wf_session_b",status:"failed"}));
equal("foreign run ID cannot alter old status or payload",WorkflowRunRepo.get("run_collide"),originalRun);
error("run ID collision from other workflow rejected",()=>WorkflowRunRepo.save({...original,workflowId:"wf_other",status:"failed"}));
equal("foreign workflow cannot alter original run",WorkflowRunRepo.get("run_collide"),originalRun);
WorkflowRunRepo.save({...original,status:"success",payload:'{"phase":"done"}',awaiting:[]});
equal("legitimate same-owner status update remains supported",WorkflowRunRepo.get("run_collide")?.status,"success");
equal("legitimate same-owner payload update remains supported",WorkflowRunRepo.get("run_collide")?.payload,'{"phase":"done"}');

closeDb();
console.log("workflow-repo-integrity-smoke: "+(checks-failures)+"/"+checks+" PASS");
if(failures) process.exitCode=1;
