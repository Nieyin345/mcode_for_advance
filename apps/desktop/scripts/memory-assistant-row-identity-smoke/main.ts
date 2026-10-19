/**
 * MC-025/MC-052 isolated job-identity boundary: a JSON payload's ID must
 * match the setting row key, and a damaged job's untrusted index reference
 * is not sufficient proof to destroy its only persisted bytes.
 */
import { initDb, closeDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories/project.js";
import { SessionRepo } from "@main/store/repositories/session.js";
import { SettingRepo } from "@main/store/repositories/setting.js";
import { createAssistantJob, readAssistantJob, listAssistantJobs, dropAssistantJobs } from "@main/memory/assistantStore.js";
import type { Project, Session } from "@contracts/session";
let n=0,fails=0;
function check(label:string,ok:boolean,details?:unknown):void {
 n++;if(ok)console.log("  ok   "+label);else{fails++;console.log("  FAIL "+label+" "+JSON.stringify(details));}
}
await initDb();
const now=Date.now();
const p:Project={id:"p_memory_identity",name:"Synthetic",path:"/isolated/memory",archived:false,group:null,
 sortOrder:0,pinnedAt:null,createdAt:now,updatedAt:now};
ProjectRepo.create(p);
const session=(id:string):Session=>({
 id,projectId:p.id,providerId:"claude-sdk",claudeSessionId:null,kind:"chat",
 parentSessionId:null,nodeId:null,agentProfile:null,title:id,status:"idle",
 model:"default",effort:"default",permissionMode:"default",workflowId:"default",
 customModelId:null,archived:false,pinnedAt:null,contextSnapshot:null,
 todos:null,subagents:null,planDraft:null,usageHistory:null,turnFiles:null,
 subagentTranscripts:null,bookmarks:null,createdAt:now,updatedAt:now,
} as Session);
SessionRepo.create(session("source_a")); SessionRepo.create(session("source_b"));
const a=createAssistantJob("source_a",p.id,"worker_a","checkpoint");
const b=createAssistantJob("source_b",p.id,"worker_b","checkpoint");
const jobKey=(id:string)=>"memory.assistant.job."+id;
const sourceKey=(id:string)=>"memory.assistant.source."+id;
const aOriginal=SettingRepo.get(jobKey(a.id))!;
const bOriginal=SettingRepo.get(jobKey(b.id))!;
check("normal job A key identity",readAssistantJob(a.id)?.id===a.id);
check("normal job B key identity",readAssistantJob(b.id)?.id===b.id);
SettingRepo.set(jobKey(a.id),bOriginal);
let caught="";
try{readAssistantJob(a.id)}catch(e){caught=String(e)}
check("★★ mismatched key/payload job ID rejects instead of returning B",caught.includes("损坏"),{caught});
check("★★ mismatched A row's foreign bytes were not silently rewritten",
 SettingRepo.get(jobKey(a.id))===bOriginal);
check("★★ B's actual job remains intact",SettingRepo.get(jobKey(b.id))===bOriginal);
SettingRepo.set(jobKey(a.id),aOriginal);
check("healthy original A restored",readAssistantJob(a.id)?.id===a.id);

// An existing but empty persisted row is corrupted data, not a missing job.
SettingRepo.set(jobKey("persisted-empty"),"");
let emptyError="";
try{readAssistantJob("persisted-empty")}catch(e){emptyError=String(e)}
check("★★ empty persisted row must fail closed rather than claim job is absent",
 emptyError.includes("损坏"),{emptyError});
check("empty raw bytes are preserved",SettingRepo.get(jobKey("persisted-empty"))==="");

// An invalid job row cannot be assigned an owner from a possibly corrupted
// source index alone. Otherwise deleting A can delete B's only corrupt record
// even though its payload carries no provable A source or target ID.
const corruptKey=jobKey("ambiguous-corrupt");
const originalBroken="{truncated-data-for-unknown-owner";
SettingRepo.set(corruptKey,originalBroken);
const unindexedCorrupt=jobKey("unindexed-foreign-corrupt");
SettingRepo.set(unindexedCorrupt,"{foreign-unknown-owner");
// This payload names A but is stored under an unrelated persistent key.
// Trusting only the inner sourceSessionId would delete a mismatched identity
// row without knowing which job it actually belongs to.
const mismatchedKey=jobKey("mismatched-key-unknown-owner");
SettingRepo.set(mismatchedKey,aOriginal);
const savedIndex=JSON.parse(SettingRepo.get(sourceKey("source_a"))??"[]") as string[];
SettingRepo.set(sourceKey("source_a"),JSON.stringify([...savedIndex,"ambiguous-corrupt"]));
dropAssistantJobs("source_a");
check("normal healthy A job deleted with its session",SettingRepo.get(jobKey(a.id))===null);
check("normal A source index removed",SettingRepo.get(sourceKey("source_a"))===null);
check("index-proven corrupt A job is cleaned by existing MC-052 rule",
 SettingRepo.get(corruptKey)===null,SettingRepo.get(corruptKey));
check("★★ unknown-owner corrupt job outside A index is never collateral deleted",
 SettingRepo.get(unindexedCorrupt)==="{foreign-unknown-owner");
check("★★ mismatched-key job outside A index cannot be claimed by inner source ID",
 SettingRepo.get(mismatchedKey)===aOriginal);
check("★★ B-owned healthy job is not affected by deleting A",SettingRepo.get(jobKey(b.id))===bOriginal);
check("normal remaining B still lists its job",listAssistantJobs("source_b").some(x=>x.id===b.id));
closeDb();
console.log("memory-assistant-row-identity-smoke:"+(n-fails)+"/"+n+" PASS");
if(fails)process.exitCode=1;
