import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryItem } from "@contracts/library";
import { LibraryDocumentIndex, documentIndexKind, flattenDocumentBlocks } from "../../src/main/library/documentTextIndex.js";
import { genofficeLibraryReader } from "../../src/main/library/documentIndexReader.js";

let total=0,fail=0;
function ck(label:string,yes:boolean) { total++;if(!yes)fail++;console.log((yes?"PASS ":"FAIL ")+label); }
function item(id:string):LibraryItem {return { id, title:"Document "+id, entryMode:"attached",addedAt:1,updatedAt:1 } as LibraryItem;}
const root=mkdtempSync(join(tmpdir(),"mcode-index-"));
try {
 const original=join(root,"sample.docx");
 writeFileSync(original,"synthetic fixture");
 let reads=0;
 let allow!:()=>void;
 let first=true;
 const blocker=new Promise<void>(resolve=>{allow=resolve;});
 const service=new LibraryDocumentIndex(root,async()=>{
   reads++;
   if(first){first=false;await blocker;}
   return {sections:[{text:"Important syntax and sample\nFollowup text",location:{block:2}}],coverage:"complete" as const};
 });
 const input={item:item("word"),path:original,kind:"docx" as const};
 ck("First search schedules missing index rather than blocking synchronously",
   (await service.search([input],"Important",3,()=>true,()=>true)).matches.length===0);
 ck("Index queue reports unfinished work",service.getStatus().pending>0);
 ck("Repeated searches deduplicate same in-flight job",
   (await service.search([input],"Important",3,()=>true,()=>true)).pending>0);
 allow();
 for(let n=0;n<75&&service.getStatus().pending>0;n++)await new Promise(r=>setTimeout(r,15));
 const results=await service.search([input],"Important",3,()=>true,()=>true);
 ck("Extracted text becomes searchable after background job settles",results.matches.length===1);
 ck("Search hit includes original block position and extractable text",
   results.matches[0]?.location?.block===2&&results.matches[0]?.lineNumber===1);
 ck("Index retains accurate complete coverage from reader",
   results.matches[0]?.coverage==="complete");
 ck("Single-flight queue invoked document reader exactly once",reads===1);
 const restored=new LibraryDocumentIndex(root,async()=>{reads++;throw Error("cache should be used");});
 ck("Index snapshot survives process restart and loads from disk",
   (await restored.search([input],"Followup",2,()=>true,()=>true)).matches.length===1);
 ck("Collection filter removes indexed results before displaying",
   (await restored.search([input],"Followup",2,()=>false,()=>true)).matches.length===0);
 ck("Cancelled search does not return stale indexed text",
   (await restored.search([input],"Important",2,()=>true,()=>false)).matches.length===0);
 writeFileSync(original,"synthetic fixture revised");
 const changed=await restored.search([input],"Important",3,()=>true,()=>true);
 ck("Changed document invalidates snapshot; stale hits are not returned",changed.matches.length===0);
 ck("Changed document schedules a background reindex",changed.pending>=1);
 const pdf=flattenDocumentBlocks([{index:0,text:"[page 12] text match"},{index:1,text:"[page 13] followup"}],"pdf",{});
 ck("PDF extract gives exact original page locators",pdf.sections[0]?.location.page===12 && pdf.sections[1]?.location.page===13);
 const ppt=flattenDocumentBlocks([{index:4,text:"[slide 5] slide text"}],"pptx",{});
 ck("PPT extraction retains slide locator",ppt.sections[0]?.location.slide===5);
 const xlsx=flattenDocumentBlocks([{index:2,text:"row data"}],"xlsx",{sheetDetail:{sheet:"Sheet 2"}});
 ck("Workbook index is honestly partial and includes row/sheet",xlsx.coverage==="partial"&&xlsx.sections[0]?.location.row===3&&xlsx.sections[0]?.location.sheet==="Sheet 2");
 const word=flattenDocumentBlocks([{index:3,text:"a block"}],"docx",{});
 ck("Word extraction keeps stable document block offset",word.sections[0]?.location.block===3);
 const cli=join(process.cwd(),"../../genoffice/packages/cli/dist/genoffice.cjs");
 const fixture=join(process.cwd(),"scripts/fixtures/sample-paper.pdf");
 if(existsSync(cli)&&existsSync(fixture)) {
   const reader=genofficeLibraryReader(cli);
   const native=await reader({item:item("pdf-fixture"),path:fixture,kind:"pdf"});
   ck("Real GenOffice PDF envelope pages_read yields indexed page text",
     native.sections.length>0 && native.sections[0]?.location.page===1 &&
     native.sections.some(x=>x.text.includes("A Sample Paper for Headless Smoke Tests")));
   const wordPath=join(process.cwd(),"scripts/library-document-index-smoke/fixtures/sample.docx");
   const excelPath=join(process.cwd(),"scripts/library-document-index-smoke/fixtures/sample.xlsx");
   const slidesPath=join(process.cwd(),"../../genoffice/packages/pptx-engine/tests/fixtures/01_standard_business.pptx");
   if(existsSync(wordPath)) {
     const word=await reader({item:item("docx-fixture"),path:wordPath,kind:"docx"});
     ck("Real GenOffice Word indexed paragraph with original block index",
       word.sections.some(x=>x.text.includes("Word Index Sample Alpha")&&x.location.block===0));
   }
   if(existsSync(excelPath)) {
     const xlsx=await reader({item:item("xlsx-fixture"),path:excelPath,kind:"xlsx"});
     ck("Real GenOffice Excel indexed cells with sheet and row mapping",
       xlsx.coverage==="partial"&&xlsx.sections.some(x=>x.text.includes("Excel Index Sample") &&
         x.location.sheet==="Research"&&x.location.row===1));
   }
   if(existsSync(slidesPath)) {
     const slides=await reader({item:item("pptx-fixture"),path:slidesPath,kind:"pptx"});
     ck("Real GenOffice PPT indexed original slide text",
       slides.sections.some(x=>x.location.slide===1&&x.text.includes("Q3 Business Review")));
   }
 } else console.log("SKIP native GenOffice fixtures unavailable (pure shape tests still run)");
 ck("Only four true document formats enter binary indexing",
   ["pdf","docx","pptx","xlsx"].every(x=>documentIndexKind("a."+x)===x) &&
   documentIndexKind("a.exe")===null);
 const ipc=readFileSync(join(process.cwd(),"src/main/ipc/library.ts"),"utf8");
 ck("Full text IPC interleaves indexed results rather than starves them",
   ipc.includes("indexableLibraryDocuments(items)")&&ipc.includes("indexed.matches[i]"));
 ck("Imported documents are queued without holding import response",
   ipc.includes("scheduleImportedDocuments(res.items)"));
 const reader=readFileSync(join(process.cwd(),"src/main/library/documentIndexReader.ts"),"utf8");
 ck("Office/PDF reader reuses existing native GenOffice adapter and no cloud calls",
   reader.includes("readAnyDocument(ports, source)") && reader.includes("withinWorkspace:(path)=>samePath(path,source)"));
} finally {rmSync(root,{recursive:true,force:true});}
console.log("library-document-index-smoke: "+(total-fail)+"/"+total);
if(fail)process.exitCode=1;
