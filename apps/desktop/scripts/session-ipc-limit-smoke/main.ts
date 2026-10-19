/**
 * IPC resource bounds: oversized requests must be rejected at the shared
 * host-validated contract, preserving ordinary paging and cursor semantics.
 */
import {
  ProjectSessionsSchema, SessionListAllSchema,
  SessionSearchSchema, BookmarkSearchSchema, SessionMessagesSchema,
} from "@contracts/ipc/session";
let checks=0,failures=0;
function check(label:string,pass:boolean,value?:unknown){
 checks++;if(pass)console.log("  ok   "+label);
 else{failures++;console.log("  FAIL "+label+(value===undefined?"":" "+JSON.stringify(value)));}
}
const cases=[
 {name:"project sessions",schema:ProjectSessionsSchema,base:{projectId:"p_syn",offset:10,archived:false},max:1000},
 {name:"all sessions",schema:SessionListAllSchema,base:{offset:10},max:1000},
 {name:"session title search",schema:SessionSearchSchema,base:{query:"needle"},max:200},
 {name:"bookmarks search",schema:BookmarkSearchSchema,base:{query:"needle"},max:200},
 {name:"session messages",schema:SessionMessagesSchema,
  base:{sessionId:"s_syn",beforeCreatedAt:12345,beforeId:"m_old"},max:500},
] as const;
for(const c of cases){
 const sample=c.base;
 const parse=(limit?:number)=>{
  const payload=limit===undefined?sample:{...sample,limit};
  return c.schema.safeParse(payload);
 };
 check(c.name+": optional/default still accepted",parse().success);
 check(c.name+": normal page accepted",parse(50).success);
 check(c.name+": exact upper boundary accepted",parse(c.max).success);
 check("★★ "+c.name+": just beyond upper bound is rejected",!parse(c.max+1).success);
 check("★★ "+c.name+": billion-row response is rejected",!parse(1_000_000_000).success);
 check(c.name+": 0 invalid",!parse(0).success);
 check(c.name+": negative invalid",!parse(-20).success);
 check(c.name+": fractional invalid",!parse(2.5).success);
}
check("messages cursor remains valid",
 SessionMessagesSchema.safeParse({
  sessionId:"s",limit:500,beforeCreatedAt:10,beforeId:"m",
 }).success);
check("session list scope unchanged",
 SessionListAllSchema.safeParse({limit:5,offset:2,projectIds:["p1","p2"],worktreeKey:"/tmp/isolate"}).success);
console.log("session-ipc-limit-smoke:"+(checks-failures)+"/"+checks+" PASS");
if(failures)process.exitCode=1;
