/**
 * Isolated real sql.js regression for SessionRepo: every prepared read must
 * free after step/getAsObject fails, and worktree reference keys must not be
 * swallowed by Object.prototype. Never touches the user's DB.
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories/project.js";
import { SessionRepo } from "@main/store/repositories/session.js";
import type { Project, Session } from "@contracts/session";

let count=0,failures=0;
function check(label:string,pass:boolean,extra?:unknown):void{
  count++;if(pass)console.log("  ok   "+label);
  else {failures++;console.log("  FAIL "+label+" "+JSON.stringify(extra));}
}
await initDb();
const now=Date.now();
const p:Project={id:"p_session_lifetime",name:"Isolated",path:"/session-smoke",archived:false,group:null,sortOrder:0,pinnedAt:null,createdAt:now,updatedAt:now};
ProjectRepo.create(p);
function fakeSession(id:string):Session {return {
  id,projectId:p.id,providerId:"claude-sdk",claudeSessionId:null,kind:"chat",parentSessionId:null,
  nodeId:null,agentProfile:null,title:id,status:"idle",model:"default",effort:"default",
  permissionMode:"default",workflowId:"default",customModelId:null,archived:false,
  pinnedAt:null,contextSnapshot:null,todos:null,subagents:null,planDraft:null,
  usageHistory:null,turnFiles:null,subagentTranscripts:null,bookmarks:null,
  createdAt:now,updatedAt:now
} as Session;}
SessionRepo.create(fakeSession("s_ref_a"));
SessionRepo.create(fakeSession("s_ref_b"));
const db=getDb();
db.run("UPDATE sessions SET worktree_path = '__proto__' WHERE id = 's_ref_a'");
db.run("UPDATE sessions SET worktree_path = 'constructor' WHERE id = 's_ref_b'");
const references=SessionRepo.worktreeReferenceCounts();
check("★★ reference count has literal __proto__ own key",Object.hasOwn(references,"__proto__") && references["__proto__"]===1,{value:references["__proto__"],keys:Object.keys(references)});
check("★★ worktree reference map has no inherited prototype",Object.getPrototypeOf(references)===null,Object.getPrototypeOf(references));
check("★★ constructor is an own numeric reference count",Object.hasOwn(references,"constructor") && Object.getOwnPropertyDescriptor(references,"constructor")?.value===1,{value:Object.getOwnPropertyDescriptor(references,"constructor")?.value});
check("normal listWorktreeRoots still includes both distinct paths",SessionRepo.listWorktreeRoots().length===2);
check("normal listByProject still returns 2 real chat sessions",SessionRepo.listByProject(p.id).length===2);
check("normal get returns source project",SessionRepo.get("s_ref_a")?.projectId===p.id);

const queries:Array<[string,()=>unknown]>=[
  ["listByProject",()=>SessionRepo.listByProject(p.id)],
  ["listIdsByProject",()=>SessionRepo.listIdsByProject(p.id)],
  ["countByProject",()=>SessionRepo.countByProject(p.id)],
  ["listPinned",()=>SessionRepo.listPinned()],
  ["listAll",()=>SessionRepo.listAll()],
  ["countAll",()=>SessionRepo.countAll()],
  ["searchByTitle",()=>SessionRepo.searchByTitle("Session")],
  ["searchBookmarks",()=>SessionRepo.searchBookmarks("topic")],
  ["listStale",()=>SessionRepo.listStale(now+100000)],
  ["get",()=>SessionRepo.get("s_ref_a")],
  ["findFreshByProject",()=>SessionRepo.findFreshByProject(p.id)],
  ["findFreshSideByParent",()=>SessionRepo.findFreshSideByParent("s_ref_a")],
  ["listSideByParent",()=>SessionRepo.listSideByParent("s_ref_a")],
  ["listNodesByParent",()=>SessionRepo.listNodesByParent("s_ref_a")],
  ["hasNodeSessions",()=>SessionRepo.hasNodeSessions("s_ref_a")],
  ["listAutomationsByWorkflow",()=>SessionRepo.listAutomationsByWorkflow("wf_none")],
  ["findNodeByNodeId",()=>SessionRepo.findNodeByNodeId("s_ref_a","node_1")],
  ["findAutomationByOrigin",()=>SessionRepo.findAutomationByOrigin("s_ref_a")],
  ["worktreeReferenceCounts",()=>SessionRepo.worktreeReferenceCounts()],
  ["listWorktreeRoots",()=>SessionRepo.listWorktreeRoots()],
  ["listByWorktreePath",()=>SessionRepo.listByWorktreePath("__proto__")],
  ["listUsageRows",()=>SessionRepo.listUsageRows()],
];
const wrapped=db as unknown as {prepare:(sql:string)=>unknown};
const preparedOriginal=wrapped.prepare;
for(const [name,action] of queries){
  let freed=0,prepared=0;
  const fault=new Error("FAKE_SESSION_STEP_FAILURE_"+name);
  wrapped.prepare=()=>{
    prepared++;
    return {bind:()=>{},step:()=>{throw fault;},free:()=>{freed++;}};
  };
  let raised:unknown=null;
  try {action();} catch(e){raised=e;} finally {wrapped.prepare=preparedOriginal;}
  check(name+": original SQLite error surfaces unchanged",raised===fault,{raised:String(raised)});
  check(name+": prepared statement freed once on failure",prepared===1 && freed===1,{freed,prepared});
}
closeDb();
console.log("session-repo-lifetime-smoke:"+(count-failures)+"/"+count+" PASS");
if(failures)process.exitCode=1;
