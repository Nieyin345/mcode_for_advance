import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryItem } from "@contracts/library";
import { LibraryDocumentIndex, documentIndexKind, flattenDocumentBlocks } from "../../src/main/library/documentTextIndex.js";
import { genofficeLibraryReader } from "../../src/main/library/documentIndexReader.js";
import { blocksToMarkdown } from "../../src/main/document/documentToolSurface.js";

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
 const xlsxLegacy=flattenDocumentBlocks([{index:2,text:"row data"}],"xlsx",{sheetDetail:{sheet:"Sheet 2"}});
 ck("Workbook index without a sheet ledger reports partial (unknown coverage, not a guess)",
   xlsxLegacy.coverage==="partial"&&xlsxLegacy.sections[0]?.location.row===3&&xlsxLegacy.sections[0]?.location.sheet==="Sheet 2");
 // ── 工作簿级账目：覆盖判定必须来自「读了哪几张」，不是写死的 kind === "xlsx" ──
 const ledgerAll = { sheets:["Summary","Detail"], activeSheet:"Summary", readSheets:["Summary","Detail"], unreadSheets:[], truncatedSheets:[] };
 const ledgerPartial = { ...ledgerAll, readSheets:["Summary"], unreadSheets:["Detail"] };
 const bookBlocks = [
   {index:0,text:"[sheet Summary] SUMMARY_ONLY_TOKEN"},
   {index:1,text:"[sheet Detail] DETAIL_ONLY_TOKEN"},
 ];
 const bookFull = flattenDocumentBlocks(bookBlocks,"xlsx",{sheetLedger:ledgerAll});
 ck("All worksheets read ⇒ workbook coverage is complete, not a fixed partial",
   bookFull.coverage==="complete");
 ck("Every row block is attributed to its own worksheet",
   bookFull.sections[0]?.location.sheet==="Summary"&&bookFull.sections[1]?.location.sheet==="Detail");
 const bookPartial = flattenDocumentBlocks(bookBlocks,"xlsx",{sheetLedger:ledgerPartial});
 ck("An unread worksheet keeps coverage partial even though every block parsed",
   bookPartial.coverage==="partial");
 const bookTruncated = flattenDocumentBlocks(bookBlocks,"xlsx",
   {sheetLedger:{...ledgerAll, truncatedSheets:["Detail"]}});
 ck("A row-truncated worksheet keeps coverage partial",bookTruncated.coverage==="partial");
 const malformed = flattenDocumentBlocks(bookBlocks,"xlsx",{sheetLedger:{sheets:"not-an-array"}});
 ck("A malformed ledger is treated as unknown coverage rather than complete",
   malformed.coverage==="partial");
 ck("A block whose [sheet X] name is absent from the ledger gets no sheet attribution",
   flattenDocumentBlocks([{index:0,text:"[sheet Ghost] data"}],"xlsx",{sheetLedger:ledgerAll})
     .sections[0]?.location.sheet===undefined);
 const word=flattenDocumentBlocks([{index:3,text:"a block"}],"docx",{});
 ck("Word extraction keeps stable document block offset",word.sections[0]?.location.block===3);
 // ── 模型侧的 Markdown 载体：多表必须分节，不能连成一张表 ──
 const md=blocksToMarkdown({items:[
   {index:0,type:"tableRow",text:"[sheet Summary] SUMMARY_ONLY_TOKEN"},
   {index:1,type:"tableRow",text:"[sheet Detail] DETAIL_ONLY_TOKEN"},
 ]});
 ck("★ Multi-sheet Markdown separates worksheets instead of merging their rows",
   md!==null && md.markdown.includes("### Summary") && md.markdown.includes("### Detail") &&
   md.markdown.includes("SUMMARY_ONLY_TOKEN") && md.markdown.includes("DETAIL_ONLY_TOKEN"));
 ck("Worksheet heading is emitted once per sheet, not once per row",
   (md!.markdown.match(/### Summary/g)??[]).length===1);
 ck("The [sheet X] prefix is consumed by the heading, not duplicated in the row text",
   md!.markdown.includes("SUMMARY_ONLY_TOKEN") && !md!.markdown.includes("[sheet Summary] SUMMARY_ONLY_TOKEN"));
 const plain=blocksToMarkdown({items:[{index:0,type:"tableRow",text:"plain row"}]});
 ck("Rows without a sheet prefix keep their previous Markdown shape",
   plain!==null && !plain.markdown.includes("###") && plain.markdown.includes("plain row"));
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
       xlsx.sections.some(x=>x.text.includes("Excel Index Sample") &&
         x.location.sheet==="Research"&&x.location.row===1));
     ck("Single-worksheet workbook is indexed as complete, not permanently partial",
       xlsx.coverage==="complete");
   }
   // ── 多工作表：真 CLI 驱动，证明「全表读完」与「漏读」在输出上分得开 ──
   const multiSheet=join(process.cwd(),"scripts/library-document-index-smoke/fixtures/multi-sheet.xlsx");
   if(existsSync(multiSheet)) {
     const book=await reader({item:item("xlsx-multi"),path:multiSheet,kind:"xlsx"});
     ck("★ Every worksheet's text reaches the index, not just the active one",
       book.sections.some(x=>x.text.includes("SUMMARY_ONLY_TOKEN")) &&
       book.sections.some(x=>x.text.includes("DETAIL_ONLY_TOKEN")));
     ck("★ Multi-worksheet hits carry the worksheet they came from",
       book.sections.find(x=>x.text.includes("DETAIL_ONLY_TOKEN"))?.location.sheet==="Detail");
     ck("★ A fully read workbook is honestly complete (the old fixed partial is gone)",
       book.coverage==="complete");
   } else console.log("SKIP multi-sheet fixture missing (run multi-sheet-fixture.py)");
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
