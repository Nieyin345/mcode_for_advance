import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryItem } from "@contracts/library";
import { libraryTextPathOwners, searchRegisteredLibraryText } from "../../src/main/library/textSearch.js";
import { calls } from "./stubs/rgSearch.js";
import { readFileSync } from "node:fs";

let count=0, failed=0;
function check(label:string,ok:boolean,detail?:unknown){
 count++;if(!ok)failed++;
 console.log((ok?"PASS ":"FAIL ")+label+(ok?"":": "+JSON.stringify(detail)));
}
const item=(id:string, fields:Partial<LibraryItem>):LibraryItem=>({
 id,title:id,entryMode:"attached",addedAt:0,updatedAt:0,...fields,
});
const records:LibraryItem[]=[
 item("pdf",{mdPath:"markdown/ab/cd/source.md",pdfPath:"papers/ab/cd/s.pdf"}),
 item("note",{mdPath:"notes/writing.md"}),
 item("outOfScope",{filePath:"files/00-other.txt"}),
 item("text",{filePath:"files/01-brief.txt"}),
 item("json",{filePath:"files/02-data.json"}),
 item("code",{filePath:"files/03-parser.ts"}),
 item("binary",{filePath:"files/04-slides.pptx"}),
 item("linked",{entryMode:"linked",filePath:"C:/unrelated/external.txt"}),
 item("dup",{filePath:"files/01-brief.txt"}),
 item("unsafe",{filePath:"files/../../private.txt"}),
 item("outside",{mdPath:"../../private.md"}),
 item("altStream",{filePath:"files/a:secret.txt"}),
 item("idempotent",{mdPath:"notes/writing.md",filePath:"files/01-brief.txt"}),
 item("binaryText",{filePath:"files/05-binary.txt"}),
 item("largeText",{filePath:"files/06-large.txt"}),
 item("utf16",{mdPath:"notes/utf16.md"}),
];
const pathIndex=libraryTextPathOwners(records);
check("Legacy PDF transcript is indexed by its real relative mdPath",
 pathIndex.get("markdown/ab/cd/source.md")?.[0]?.id==="pdf");
check("Standalone Markdown note is indexed under notes/",
 pathIndex.get("notes/writing.md")?.some(x=>x.id==="note")===true);
check("Generic attached text, JSON and TypeScript are indexed as plain text",
 ["files/01-brief.txt","files/02-data.json","files/03-parser.ts"].every(p=>pathIndex.has(p)));
check("Binary Office file is not misdecoded as text",
 !pathIndex.has("files/04-slides.pptx"));
check("Linked external path is not scanned by searching its parent directory",
 [...pathIndex.keys()].every(p=>!p.includes("external")));
check("Traversal-shaped database paths are not admitted to rg result map",
 !pathIndex.has("files/../../private.txt")&&!pathIndex.has("../../private.md"));
check("Windows alternate stream paths are rejected before rg receives file arguments",
 !pathIndex.has("files/a:secret.txt"));
check("Shared physical files return both linked library item owners",
 pathIndex.get("files/01-brief.txt")?.length===3);
const root=mkdtempSync(join(tmpdir(),"mcode-library-search-"));
const external=mkdtempSync(join(tmpdir(),"mcode-library-external-"));
const linkedFile=join(external,"selected.txt");
writeFileSync(linkedFile,"needle selected only\nexternalneedle explicit reference","utf8");
writeFileSync(join(external,"secret.txt"),"externalneedle should not appear","utf8");
const linkedRecord=item("linkedReal",{entryMode:"linked",filePath:linkedFile});
records.push(linkedRecord);
try {
 const put=(path:string,contents:string)=>{
   const p=join(root,path);
   mkdirSync(join(p,".."),{recursive:true});
   writeFileSync(p,contents,"utf8");
 };
 put("markdown/ab/cd/source.md","intro\nneedle scientific report\n");
 put("notes/writing.md","个人笔记 needle\nfallback from note\n");
 put("files/00-other.txt","scopecap out of scope\n");
 put("files/01-brief.txt","needle content\nfallback from text\ncapneedle registered only\nscopecap expected result\ntrailer");
 put("files/02-data.json",'{"context":"needle item"}\n');
 put("files/03-parser.ts",'export const needle = "hello";\n');
 put("files/04-slides.pptx","needle this is a mock binary but must not scan");
 put("files/999-orphan.txt","needle leaked orphan not indexed");
 put("files/000-orphan.txt","capneedle should never consume the result limit");
 put("markdown/orphan.md","needle orphan md not indexed");
 let symlinkCreated=false;
 try {
   symlinkSync(linkedFile,join(root,"files/03-shadow.txt"),"file");
   records.push(item("shadow",{filePath:"files/03-shadow.txt"}));
   symlinkCreated=true;
 } catch { /* File symlinks may require privileges on Windows. */ }
 put("files/05-binary.txt","fallback"+String.fromCharCode(0)+"hidden");
 put("files/06-large.txt","fallback"+"x".repeat(2*1024*1024));
 writeFileSync(join(root,"notes/utf16.md"),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from("fallback utf16 text","utf16le")]));
 const found=await searchRegisteredLibraryText(root,records,"needle",50);
 const ids=new Set(found.map(m=>m.itemId));
 check("PDF conversion, editable notes, generic plain text and code all searchable",
 ["pdf","note","text","json","code"].every(id=>ids.has(id)),[...ids]);
 check("Duplicate physical file supports multiple registered owners in results",
 ids.has("dup")&&ids.has("idempotent"));
 check("Orphan file not owned by a library item never appears",
 found.every(m=>!m.relativePath.includes("orphan")));
 check("Binary and linked external files do not appear as accidental text results",
 !ids.has("binary")&&!ids.has("linked"));
 check("Returned relativePath identifies owned library or linked file",
 found.every(m=>/^(markdown|notes|files|linked)\//.test(m.relativePath)));
 check("An explicitly linked external text file can be searched by item identity",
 found.some(m=>m.itemId==="linkedReal"&&m.lineText==="needle selected only"));
 check("Registered internal symlink never redirects scanning outside the library",
 !symlinkCreated || !found.some(m=>m.itemId==="shadow"));
 check("A sibling file beside the linked target is never searched",
 !(await searchRegisteredLibraryText(root,records,"should not appear",50)).some(m=>m.itemId==="linkedReal"));
 check("Linked-only library searches do not require any local markdown owner",
 (await searchRegisteredLibraryText(root,[linkedRecord],"externalneedle",50)).some(m=>m.itemId==="linkedReal"));
 check("Every hit is attached to correct item ID and original title",
 found.every(m=>records.some(x=>x.id===m.itemId&&x.title===m.title)));
 check("Line numbers are 1-based, lineText preserves actual source",
 found.some(m=>m.itemId==="text" && m.lineNumber===1 && m.lineText==="needle content"));
 check("One query can restrict search to a collection and never expose other rows",
 (await searchRegisteredLibraryText(root,records,"needle",50,id=>id==="text")).every(m=>m.itemId==="text"));
 check("Global limit is respected even when one registered file has multiple owners",
 (await searchRegisteredLibraryText(root,records,"needle",2)).length===2);
 check("Already-stale result cancels without scanning any directory",
 (await searchRegisteredLibraryText(root,records,"needle",50,()=>true,()=>false)).length===0);
 let gate=true;
 const cancelled=await searchRegisteredLibraryText(root,records,"needle",50,()=>true,()=>{ const c=gate;gate=false;return c; });
 check("Search cancelled after a late rg response never returns stale matches",cancelled.length===0);
 const cap=await searchRegisteredLibraryText(root,records,"capneedle",1);
 check("Orphan files cannot pre-empt registered files under a global match cap",
 cap.length===1&&cap[0]?.itemId==="text");
 const scopedCap=await searchRegisteredLibraryText(root,records,"scopecap",1,id=>id==="text");
 check("Matches from other collections cannot exhaust the scoped result limit",
 scopedCap.length===1&&scopedCap[0]?.itemId==="text",scopedCap);
 check("Every ripgrep scan gets explicit registered paths rather than a directory",
 calls.every(c=>Array.isArray(c.files)&&c.files.length>0&&c.files.length<=64));
 check("Actual scanning uses only bounded fixed-string rg with supported extensions",
 calls.some(c=>c.extensions.includes("txt")) && calls.some(c=>c.extensions.includes("md")) &&
 calls.every(c=>c.limit<=50&&c.maxPerFile===5));
 const fallback=await searchRegisteredLibraryText(root,records,"fallback",50);
 check("Missing ripgrep still scans recorded text and notes",
   fallback.some(m=>m.itemId==="text") && fallback.some(m=>m.itemId==="note"));
 check("Fallback never scans unregistered files or linked external paths",
   fallback.every(m=>!m.relativePath.includes("orphan")&&m.itemId!=="linked"));
 check("Fallback preserves multiple item owners of one physical file",
   fallback.some(m=>m.itemId==="dup") && fallback.some(m=>m.itemId==="idempotent"));
 check("Fallback refuses NUL-bearing binary and large files",
   fallback.every(m=>m.itemId!=="binaryText"&&m.itemId!=="largeText"));
 check("Fallback can read small UTF-16LE text with an explicit BOM",
   fallback.some(m=>m.itemId==="utf16"&&m.lineText==="fallback utf16 text"));
 check("Fallback respects the same collection filter",
   (await searchRegisteredLibraryText(root,records,"fallback",50,id=>id==="text")).every(m=>m.itemId==="text"));
 check("Empty query returns no fabricated results",
 (await searchRegisteredLibraryText(root,records,"",50)).length===0);
 const rgSource=readFileSync(join(process.cwd(),"src/main/lib/rgSearch.ts"),"utf8");
 check("Underlying rg runner separates literal pattern from scoped file arguments",
 rgSource.includes('"-e", query,') && rgSource.includes('...(opts.files ?? ["."])') &&
 rgSource.includes("opts.files?.some((file)"));
 const ipc=readFileSync(join(process.cwd(),"src/main/ipc/library.ts"),"utf8");
 check("Existing IPC now calls unified registered-asset scanner",
 ipc.includes("searchRegisteredLibraryText(")&&ipc.includes("LibraryRepo.listAllItems()"));
 check("IPC keeps latest-query-wins and collection ownership filtering",
 ipc.includes("seq === fullTextSearchSeq")&&ipc.includes("CollectionRepo.collectionsOfItem(itemId)"));
 check("IPC no longer silently caps library ownership at first 100000 items",
 !ipc.includes("LibraryRepo.list({ limit: 100000 }).items"));
 check("Negative: deleting linked-file guard changes owner index",
 !libraryTextPathOwners(records).has("C:/unrelated/external.txt"));
} finally { rmSync(root,{recursive:true,force:true});rmSync(external,{recursive:true,force:true});}
console.log("library-unified-text-search-smoke: "+(count-failed)+"/"+count);
if(failed)process.exitCode=1;
