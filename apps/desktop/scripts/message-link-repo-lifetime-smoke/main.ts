/**
 * ARC-006 isolated SQL statement lifetime for messages + library links.
 * Test genuinely invokes production repositories and sql.js; no user DB.
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories/project.js";
import { SessionRepo } from "@main/store/repositories/session.js";
import { MessageRepo } from "@main/store/repositories/message.js";
import { LibraryRepo } from "@main/store/repositories/library.js";
import { LibraryLinkRepo } from "@main/store/repositories/libraryLink.js";
import type { Project, Session, MessageRecord } from "@contracts/session";

let cases=0, failures=0;
function check(label:string,ok:boolean,details?:unknown):void {
 cases++;
 if(ok) console.log("  ok   "+label);
 else { failures++; console.log("  FAIL "+label+" "+(details===undefined?"":JSON.stringify(details))); }
}
function equal(label:string,a:unknown,b:unknown):void {
 check(label,JSON.stringify(a)===JSON.stringify(b),{a,b});
}
await initDb();
const db=getDb();
const now=Date.now();
const project:Project={id:"p_msg_links",name:"Smoke",path:"/msg-smoke",archived:false,
 group:null,sortOrder:0,pinnedAt:null,createdAt:now,updatedAt:now};
ProjectRepo.create(project);
const sess:Session={
 id:"s_msg_links",projectId:project.id,providerId:"claude-sdk",claudeSessionId:null,
 kind:"chat",parentSessionId:null,nodeId:null,agentProfile:null,title:"Synthetic",
 status:"idle",model:"default",effort:"default",permissionMode:"default",workflowId:"default",
 customModelId:null,archived:false,pinnedAt:null,contextSnapshot:null,todos:null,
 subagents:null,planDraft:null,usageHistory:null,turnFiles:null,subagentTranscripts:null,
 bookmarks:null,createdAt:now,updatedAt:now,
} as Session;
SessionRepo.create(sess);
const msg=(id:string,createdAt:number):MessageRecord=>({
 id,sessionId:sess.id,role:"user",content:[{type:"text",text:id}],createdAt
});
MessageRepo.replaceAll(sess.id,[msg("m0",now),msg("m1",now+1),msg("m2",now+2)]);
const a=LibraryRepo.upsert({title:"Alpha"});
const b=LibraryRepo.upsert({title:"Beta"});
const link=LibraryLinkRepo.add(a.id,{targetItemId:b.id});
const oldCount=()=>LibraryLinkRepo.linksOf(a.id).length;
equal("normal links include the outgoing row",oldCount(),1);
equal("normal counts match source and target",[LibraryLinkRepo.countsOf([a.id,b.id])[a.id],LibraryLinkRepo.countsOf([a.id,b.id])[b.id]],[1,1]);

const queries:Array<{
  name:string;
  sqlPart:string;
  action:()=>unknown;
}>=[
 {name:"message.hasAny",sqlPart:"SELECT 1 FROM messages WHERE session_id",action:()=>MessageRepo.hasAny(sess.id)},
 {name:"message.list-full",sqlPart:"SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",action:()=>MessageRepo.listBySession(sess.id)},
 {name:"message.list-first",sqlPart:"SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC",action:()=>MessageRepo.listBySession(sess.id,{limit:2})},
 {name:"message.list-cursor",sqlPart:"AND (created_at < ? OR (created_at = ? AND id < ?))",action:()=>MessageRepo.listBySession(sess.id,{limit:2,beforeCreatedAt:now+2,beforeId:"m2"})},
 {name:"link.linksOf",sqlPart:"SELECT * FROM library_item_links WHERE item_id = ? OR target_item_id = ?",action:()=>LibraryLinkRepo.linksOf(a.id)},
 {name:"link.add-existing",sqlPart:"SELECT * FROM library_item_links WHERE item_id = ? AND target_item_id = ?",action:()=>LibraryLinkRepo.add(a.id,{targetItemId:b.id})},
 {name:"link.remove-probe",sqlPart:"SELECT id FROM library_item_links WHERE id = ?",action:()=>LibraryLinkRepo.remove(link.id)},
 {name:"link.countsOf",sqlPart:"SELECT owner, COUNT(*) AS n FROM",action:()=>LibraryLinkRepo.countsOf([a.id,b.id])},
 {name:"link.viewsOf-title",sqlPart:"SELECT id, title FROM library_items WHERE id IN",action:()=>LibraryLinkRepo.viewsOf(a.id)},
 {name:"link.viewsOfMany-edges",sqlPart:"SELECT * FROM library_item_links WHERE item_id IN",action:()=>LibraryLinkRepo.viewsOfMany([a.id,b.id])},
 {name:"link.viewsOfMany-title",sqlPart:"SELECT id, title FROM library_items WHERE id IN",action:()=>LibraryLinkRepo.viewsOfMany([a.id,b.id])},
];
const spy=db as unknown as {prepare:(sql:string)=>unknown};
const original=spy.prepare;
for(const {name,sqlPart,action} of queries){
 for(const stage of ["bind","step","row"] as const){
  // Existence probes do not call getAsObject(); pretending their row read
  // threw would instead run the real DELETE in the remove positive path.
  if(stage==="row" && (name==="message.hasAny" || name==="link.remove-probe")) continue;
  let prepared=0,freed=0;
  const fault=new Error("INJECT_REPO_"+name+"_"+stage);
  spy.prepare=(sql:string)=>{
   if(!sql.includes(sqlPart)) return original.call(db,sql);
   prepared++;
   return {
    bind:()=>{if(stage==="bind")throw fault;},
    step:()=>{if(stage==="step")throw fault;return true;},
    getAsObject:()=>{if(stage==="row")throw fault;return {};},
    free:()=>{freed++;},
   };
  };
  let thrown:unknown=null;
  try{action()}catch(e){thrown=e}finally{spy.prepare=original}
  check("SQL "+name+"/"+stage+" preserves original failure",thrown===fault,{thrown:String(thrown),prepared});
  check("★★ SQL "+name+"/"+stage+" always frees exactly once",prepared===1&&freed===1,{prepared,freed});
 }
}
// Verify injection did not poison or mutate real persisted rows. The actual
// list/links/ordering regressions need positive checks, not only fault spies.
check("after injection original link is still present",oldCount()===1);
equal("normal full history",MessageRepo.listBySession(sess.id).messages.map(x=>x.id),["m0","m1","m2"]);
const first=MessageRepo.listBySession(sess.id,{limit:2});
equal("normal first page returns newest 2",first.messages.map(x=>x.id),["m1","m2"]);
check("normal pagination still says there is older history",first.hasMore);
const previous=MessageRepo.listBySession(sess.id,{limit:2,beforeCreatedAt:now+1,beforeId:"m1"});
equal("normal cursor loads oldest row without duplicates",previous.messages.map(x=>x.id),["m0"]);
const single=LibraryLinkRepo.viewsOf(a.id);
check("normal one-item link preview retains target title",single.length===1&&single[0]?.title==="Beta",single);
const many=LibraryLinkRepo.viewsOfMany([a.id,b.id]);
check("normal batch preview retains both directions",many[a.id]?.length===1&&many[b.id]?.length===1,
 {out:many[a.id],in:many[b.id]});
equal("normal idempotent link.add returns original id",LibraryLinkRepo.add(a.id,{targetItemId:b.id}).id,link.id);
check("normal link.remove returns true",LibraryLinkRepo.remove(link.id));
check("normal remove clears both directions",LibraryLinkRepo.linksOf(a.id).length===0);

// Equal-millisecond messages are common in fast tool batches. Cursor pages
// order by (created_at,id) but the full-list route only sorted created_at;
// inserting reverse IDs therefore changed visible chronology after opting in
// to pagination. Both views must use one deterministic identity tiebreaker.
MessageRepo.upsertMany([msg("tie_z",now+99),msg("tie_a",now+99)]);
const fullTies=MessageRepo.listBySession(sess.id).messages
  .filter(x=>x.createdAt===now+99).map(x=>x.id);
const cursorTies=MessageRepo.listBySession(sess.id,{limit:20}).messages
  .filter(x=>x.createdAt===now+99).map(x=>x.id);
equal("★★ full history uses same (created_at,id) tie order as cursor pagination",fullTies,cursorTies);
equal("deterministic same-ms message IDs sort ascending",fullTies,["tie_a","tie_z"]);
closeDb();
console.log("message-link-repo-lifetime-smoke:"+(cases-failures)+"/"+cases+" PASS");
if(failures)process.exitCode=1;
