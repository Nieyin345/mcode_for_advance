/**
 * E1: real isolated sql.js for IPC-facing persisted message ownership and
 * library batch link dictionaries. All project/session/item ids are synthetic.
 * No user DB, no network, no Electron window.
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories/project.js";
import { SessionRepo } from "@main/store/repositories/session.js";
import { MessageRepo } from "@main/store/repositories/message.js";
import { LibraryLinkRepo } from "@main/store/repositories/libraryLink.js";
import type { Project, Session } from "@contracts/session";
import type { MessageRecord } from "@contracts/session";
let total=0, failures=0;
function check(name:string, ok:boolean, details?:unknown):void {
  total++; if(ok) console.log("  ok   "+name);
  else { failures++; console.log("  FAIL "+name+(details===undefined?"":" — "+JSON.stringify(details))); }
}
function equal(name:string, actual:unknown, expected:unknown):void {
  check(name,JSON.stringify(actual)===JSON.stringify(expected),{actual,expected});
}
function errors(name:string, action:()=>unknown):void {
  let msg=""; try{action();}catch(e){msg=String(e)}
  check(name, msg.length>0, {error:msg});
}
await initDb();
const now=Date.now();
const p: Project = {id:"project-test",name:"Isolated",path:"/smoke/identity",archived:false,group:null,
  sortOrder:0,pinnedAt:null,createdAt:now,updatedAt:now};
ProjectRepo.create(p);
const session=(id:string):Session=>({id,projectId:p.id,providerId:"claude-sdk",claudeSessionId:null,kind:"chat",
  parentSessionId:null,nodeId:null,agentProfile:null,title:id,status:"idle",
  model:"default",effort:"default",permissionMode:"default",workflowId:"default",
  customModelId:null,archived:false,pinnedAt:null,contextSnapshot:null,
  todos:null,subagents:null,planDraft:null,usageHistory:null,turnFiles:null,
  subagentTranscripts:null,bookmarks:null,createdAt:now,updatedAt:now} as Session);
SessionRepo.create(session("sA")); SessionRepo.create(session("sB"));
const msg=(id:string,sessionId:string,at=now):MessageRecord=>({id,sessionId,role:"user",content:[],createdAt:at});
MessageRepo.replaceAll("sA",[msg("a1","sA")]);
MessageRepo.replaceAll("sB",[msg("b1","sB")]);
const list=(id:string)=>MessageRepo.listBySession(id).messages.map(x=>x.id+":"+x.sessionId+":"+x.createdAt);

// An untrusted renderer may send mismatched embedded sessionId despite the
// request carrying a different target sessionId. Reject before DELETE.
errors("★★ replaceAll rejects foreign embedded sessionId before deletion",
  ()=>MessageRepo.replaceAll("sA",[msg("foreign","sB")]));
equal("★★ replaceAll rejection preserves existing A and B rows",
  [list("sA"),list("sB")], [["a1:sA:"+now],["b1:sB:"+now]]);

// SQL ON CONFLICT(id) cannot silently REASSIGN an already-persisted message to
// a different session when it collides with global id.
errors("★★ upsertMany rejects id already owned by a different session",
  ()=>MessageRepo.upsertMany([msg("b1","sA")]));
equal("★★ upsert collision preserves both histories",
  [list("sA"),list("sB")], [["a1:sA:"+now],["b1:sB:"+now]]);

// Mixed valid+invalid batch must be all-or-nothing and must not move existing ID.
errors("★★ mixed upsert batch is atomic on collision",
  ()=>MessageRepo.upsertMany([msg("a2","sA"),msg("b1","sA")]));
equal("★★ batch failure does not leave first newly inserted message behind",
  [list("sA"),list("sB")], [["a1:sA:"+now],["b1:sB:"+now]]);

// Truncate deletes suffix first: guard its supplied payload BEFORE any DELETE.
errors("★★ truncateAndInsert rejects rows targeting another session",
  ()=>MessageRepo.truncateFromAndInsert("sA",{createdAt:now,id:"a1"},[msg("fake","sB")]));
equal("★★ foreign replacement cannot silently destroy A history",
  [list("sA"),list("sB")], [["a1:sA:"+now],["b1:sB:"+now]]);

errors("★★ truncateAndInsert rejects collision with another session ID",
  ()=>MessageRepo.truncateFromAndInsert("sA",{createdAt:now,id:"a1"},[msg("b1","sA")]));
equal("★★ cross-session ID collision keeps A/B histories",
  [list("sA"),list("sB")], [["a1:sA:"+now],["b1:sB:"+now]]);

// A partially failed message INSERT must free its prepared statement and
// roll back the earlier deletion/changes. This runs the *real* repo transaction
// with one injected fake prepared statement; the real data stays in smoke DB.
{
  const db = getDb() as unknown as { prepare: (sql: string) => unknown };
  const prepare = db.prepare;
  for (const [label, run] of [
    ["replaceAll", () => MessageRepo.replaceAll("sA", [msg("fault_r", "sA")])],
    ["upsertMany", () => MessageRepo.upsertMany([msg("fault_u", "sA")])],
    ["truncateFromAndInsert", () => MessageRepo.truncateFromAndInsert("sA",{createdAt:now,id:"a1"},[msg("fault_t","sA")])],
  ] as const) {
    let freed=0, prepared=0;
    db.prepare = (sql: string) => {
      if (!sql.includes("INSERT INTO messages")) return prepare.call(db,sql);
      prepared++;
      return { run: () => { throw new Error("FAKE_MESSAGE_INSERT_FAIL"); }, free: () => { freed++; } };
    };
    let error="";
    try { run(); } catch(e) { error=String(e); }
    finally { db.prepare=prepare; }
    check("故障注入 "+label+" 真正命中写入阶段",error.includes("FAKE_MESSAGE_INSERT_FAIL")&&prepared===1,{error,prepared});
    check("★★ "+label+" 出错后 prepared statement 释放一次",freed===1,{freed});
    equal("★★ "+label+" 写入/截断失败自动 ROLLBACK，没有丢旧消息", [list("sA"),list("sB")],
      [["a1:sA:"+now],["b1:sB:"+now]]);
  }
}

// Correct operations are still allowed.
MessageRepo.upsertMany([msg("a1","sA",now+1),msg("a2","sA",now+2)]);
equal("normal same-session upsert is still possible",
  list("sA"), ["a1:sA:"+(now+1),"a2:sA:"+(now+2)]);
MessageRepo.truncateFromAndInsert("sA",{createdAt:now+2,id:"a2"},[msg("a3","sA",now+3)]);
equal("normal edit-and-resend preserves older messages",
  list("sA"), ["a1:sA:"+(now+1),"a3:sA:"+(now+3)]);

// Special literal item IDs can be imported from prior databases. A batch
// dictionary keyed with '{}' cannot represent "__proto__" as own data.
getDb().run("INSERT INTO library_items (id,title,added_at,updated_at) VALUES ('__proto__','A',1,1),('constructor','B',1,1),('ordinary','C',1,1)");
LibraryLinkRepo.add("__proto__",{targetItemId:"ordinary"});
LibraryLinkRepo.add("constructor",{targetItemId:"ordinary"});
const counts=LibraryLinkRepo.countsOf(["__proto__","constructor","ordinary"]);
check("★★ countsOf preserves literal __proto__ as own numeric key",
  Object.hasOwn(counts,"__proto__")&&counts["__proto__"]===1,
  {keys:Object.keys(counts),value:counts["__proto__"]});
check("★★ countsOf has null prototype to avoid getter/setter collisions",
  Object.getPrototypeOf(counts)===null);
equal("normal countsOf still counts both endpoints", [counts["constructor"],counts["ordinary"]],[1,2]);
let views:Record<string,unknown>|null=null, viewErr="";
try { views=LibraryLinkRepo.viewsOfMany(["__proto__","constructor","ordinary"]); } catch(e){viewErr=String(e);}
check("★★ viewsOfMany does not throw for literal special IDs",!viewErr,{error:viewErr});
check("★★ viewsOfMany preserves __proto__ as real array with one entry",
  !!views&&Object.hasOwn(views,"__proto__")&&Array.isArray(views["__proto__"])&&(views["__proto__"] as unknown[]).length===1,
  {keys:views?Object.keys(views):[],value:views?.["__proto__"]});
check("normal viewsOfMany still contains outgoing and incoming edges",
  !!views&&Array.isArray(views["ordinary"])&&(views["ordinary"] as unknown[]).length===2);
check("★★ viewsOfMany has no inherited prototype",
  !!views&&Object.getPrototypeOf(views)===null);
closeDb();
console.log("repository-identity-boundary-smoke:"+ (total-failures)+"/"+total+" PASS");
if(failures)process.exitCode=1;
