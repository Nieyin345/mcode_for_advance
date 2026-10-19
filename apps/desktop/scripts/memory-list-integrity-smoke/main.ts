/**
 * ARC-006 memory list integrity: real isolated archive bytes + native home.
 * Does not touch the user's HOME/dataRoot; runner points both to mktemp.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { initDb, closeDb } from "@main/store/db.js";
import { memoryHistory, readHistory } from "@main/memory/store.js";
import { manageMemory } from "@main/memory/manage.js";

let n=0,bad=0;
function check(label:string,good:boolean,extra?:unknown):void {
 n++;if(good)console.log("  ok   "+label);
 else{bad++;console.log("  FAIL "+label+" "+JSON.stringify(extra));}
}
const root=process.env.MCODE_SMOKE_DATA_ROOT;
if(!root)throw new Error("smoke must have isolated data root");
const home=join(root,"home");
const isIsolatedHome=homedir().replaceAll("\\","/").toLowerCase()===home.replaceAll("\\","/").toLowerCase();
check("synthetic HOME replaces real user home",isIsolatedHome,{home,actual:homedir()});
if(!isIsolatedHome)throw new Error("STOP: would inspect real HOME");

const archive=join(root,"memory",".history");
mkdirSync(archive,{recursive:true});
const mk=(timestamp:string,uuid:string)=>timestamp+"-"+uuid;
const g1=mk("1792410600000","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const g2=mk("1792410600001","bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const broken=mk("1792410600002","cccccccc-cccc-cccc-cccc-cccccccccccc");
const valid=(id:string,path:string)=>JSON.stringify({version:1,id,path,at:1792410600000,reason:"before-update",raw:"original unmodified markdown"});
writeFileSync(join(archive,g1+".json"),valid(g1,"global/rules/restore-a.md"),"utf8");
writeFileSync(join(archive,g2+".json"),valid(g2,"global/rules/restore-b.md"),"utf8");
const originalBroken="{unfinished-original-archive";
writeFileSync(join(archive,broken+".json"),originalBroken,"utf8");
const archiveList=memoryHistory();
check("two healthy archive entries remain visible",archiveList.entries.length===2,archiveList.entries);
check("★★ corrupted snapshot is reported, never silently omitted",archiveList.unreadable===1,archiveList);
check("corrupt history original bytes preserved",readFileSync(join(archive,broken+".json"),"utf8")===originalBroken);
check("healthy history still readable",readHistory(g1).raw==="original unmodified markdown");
check("history archive truncation stays zero",archiveList.truncated===0,archiveList.truncated);

// Invalid slug names must not consume the 500 *valid* project cap. The same
// applies to 100 *valid* .md files. The old slice-before-filter implementation
// reported 500 projects scanned but returned ZERO sources.
const native=join(home,".mcode","projects");
mkdirSync(native,{recursive:true});
for(let i=0;i<500;i++)mkdirSync(join(native,"!invalid-"+String(i).padStart(3,"0")));
const mem=join(native,"zz-valid","memory");
mkdirSync(mem,{recursive:true});
for(let i=0;i<100;i++)writeFileSync(join(mem,"a"+String(i).padStart(3,"0")+".txt"),"unrelated sidecar");
writeFileSync(join(mem,"z-importable.md"),"valuable user native memory");
mkdirSync(join(mem,"broken.md"));
await initDb();
const list=manageMemory({action:"list"});
check("memory manage list succeeds on isolated HOME",list.ok,list.error);
check("★★ valid project behind 500 malformed slugs remains visible",
 list.sources?.some(x=>x.id===".mcode/zz-valid/z-importable.md")===true,list.sources?.slice(0,3));
check("★★ 100 unrelated non-md files do not hide the valid memory file",
 list.sources?.filter(x=>x.id.endsWith("z-importable.md")).length===1,list.sources?.length);
check("non-memory junk is not reported as truncated valid source",list.truncatedSources===0,list.truncatedSources);
check("★★ malformed candidate .md directory appears in diagnostics",list.unreadableSources===1,list.unreadableSources);
check("★★ desktop sees exact unreadable archive count",list.historyUnreadable===1,list.historyUnreadable);
check("desktop still sees the two healthy restore choices",list.history?.length===2,list.history?.length);
const scoped=manageMemory({action:"list"},path=>path==="global/rules/restore-a.md");
check("★★ agent scope never learns hidden global archive error count",scoped.historyUnreadable===0,scoped.historyUnreadable);
check("★★ agent scope never learns host native source errors",scoped.unreadableSources===0,scoped.unreadableSources);
check("scope leaves only permitted healthy history entry",scoped.history?.length===1,scoped.history);
closeDb();
console.log("memory-list-integrity-smoke: "+(n-bad)+"/"+n+" PASS");
if(bad)process.exitCode=1;
