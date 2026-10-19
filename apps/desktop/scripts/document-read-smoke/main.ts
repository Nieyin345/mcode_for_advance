import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, truncateSync, rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { agentMcpTools } from "@main/mcp/agentTools.js";
import { convertFile, docsRead, sheetRead, resolveGenofficeCliPath } from "@main/document/genofficeCli.js";
import { configureDocumentRepoRoot } from "@main/ipc/document.js";
import { __registeredDisposerCount, __registeredShutdownHookCount } from "@main/mcp/agentSessionCleanup.js";
import { ResponseReadGate, classifyContentType, readResponseWithinBudget, checkZipInflation, clampCellBudget, MAX_CONCURRENT_URL_READS, DOCUMENT_READ_BUDGET, type ReadBudget } from "@main/lib/readBudget.js";
import { toolTextOf, type ToolResult } from "@main/mcp/sdk.js";
const root=mkdtempSync(join(tmpdir(),"mcode-doc-read-"));
const failures:string[]=[];let passed=0;
async function test(name:string,fn:()=>unknown){try{await fn();passed++;console.log("PASS "+name);}catch(e){failures.push(name+":"+String(e));console.error("FAIL "+failures.at(-1));}}
const specs=agentMcpTools({cwdFor:()=>root});const spec=specs.find(x=>x.name==="agent_read_document")!;
const read=async(path:string,args:Record<string,unknown>={})=>spec.handler(z.object(spec.inputSchema).parse({path,reader:"native",...args}),{sessionId:"document-fixture"});
const text=toolTextOf;
function pdf(width=595,height=842,file="paper.pdf",pages=3){
 const kids=Array.from({length:pages},(_,i)=>`${3+2*i} 0 R`).join(" ");
 const fontId=3+2*pages;
 const objects:string[]=["<< /Type /Catalog /Pages 2 0 R >>",`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`];
 for(let n=1;n<=pages;n++){const s=n===2?`BT /F1 12 Tf 50 750 Td (PAGE_2_LEFT) Tj ET\nBT /F1 12 Tf 340 750 Td (PAGE_2_RIGHT) Tj ET`:`BT /F1 12 Tf 50 750 Td (PAGE_${n} ${"Paper metadata ".repeat(200)}) Tj ET`;objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${2+n*2} 0 R >>`,`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);}
 objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");let body="%PDF-1.4\n";const offsets=[0];for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${o}\nendobj\n`;}
 const x=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>`${String(o).padStart(10,"0")} 00000 n \n`).join("")+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;writeFileSync(join(root,file),body);
}
try {
 let py:string|undefined;for(const exe of process.platform==="win32"?["python","py","python3"]:["python3","python"]){const r=spawnSync(exe,["-X","utf8",resolve("scripts/document-read-smoke/fixtures.py"),root],{encoding:"utf8",timeout:20000});if(r.status===0){py=exe;break;}}
 assert.ok(py,"This integration suite requires the existing Python + python-pptx + openpyxl toolchain; nothing is installed automatically");pdf();pdf(2000,500,"wide-paper.pdf");pdf(595,842,"many-pages.pdf",220);
 const emptyDeck=spawnSync(py,["-X","utf8","-c","from pptx import Presentation;import sys;Presentation().save(sys.argv[1])",join(root,"empty-slides.pptx")],{encoding:"utf8",timeout:20000});
 assert.equal(emptyDeck.status,0,emptyDeck.stderr);
 await test("PPTX reader reads actual slides instead of slicing an unsupported collection",async()=>{const r=await read("slides.pptx",{max_slides:1});assert.ok(!r.isError,text(r));assert.ok(text(r).includes("SLIDE_1"));assert.ok(!text(r).includes("SLIDE_2"));});
 await test("★ GenOffice PPTX first slide reuses native --slide selector",async()=>{
   const r=await read("slides.pptx",{reader:"genoffice",max_slides:1});
   assert.ok(!r.isError,text(r).slice(0,260));
   const body=text(r);
   assert.match(body,/SLIDE_1/);
   assert.ok(!body.includes("SLIDE_2"),"GenOffice vendor must not ignore max_slides=1");
   assert.match(body,/next_slide.*2/);
 });
 await test("★ GenOffice PPTX resumes at slide 2 using original vendor --slide",async()=>{
   const r=await read("slides.pptx",{reader:"genoffice",slide_start:2,max_slides:1});
   assert.ok(!r.isError,text(r));const s=text(r);
   assert.match(s,/SLIDE_2/);assert.ok(!s.includes("SLIDE_1"),"slide_start ignored");
   assert.ok(!/next_slide.*3/.test(s),"last page must not offer an out-of-range continuation");
 });
 await test("★ GenOffice PPTX native two-slide window does not switch to Python",async()=>{
   const r=await read("slides.pptx",{reader:"genoffice",slide_start:1,max_slides:2});
   assert.ok(!r.isError,text(r));const s=text(r);
   assert.match(s,/GenOffice\/Office/);assert.match(s,/SLIDE_1/);assert.match(s,/SLIDE_2/);
   assert.ok(!s.includes("SLIDE_3"),"unexpected third slide");
 });
 await test("★ GenOffice PPTX default is bounded and exposes continuation",async()=>{
   const r=await read("slides.pptx",{reader:"genoffice"});
   assert.ok(!r.isError,text(r));const s=text(r);
   assert.match(s,/SLIDE_1/);assert.ok(!s.includes("SLIDE_2"),"default vendor full deck is unbounded");
   assert.match(s,/next_slide.*2/);
 });
 await test("★ Native PPTX slide_start=2 shares the same continuation contract",async()=>{
   const r=await read("slides.pptx",{reader:"native",slide_start:2,max_slides:1});
   assert.ok(!r.isError,text(r));const s=text(r);
   assert.match(s,/SLIDE_2/);assert.ok(!s.includes("SLIDE_1"),"native slide_start ignored");
   assert.match(s,/第 2|Slide 2/);
 });
 await test("★ PPTX invalid start returns error, not false empty success",async()=>{
   for(const reader of ["native","genoffice"]){
     const r=await read("slides.pptx",{reader,slide_start:999,max_slides:1});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/999|范围|超出/);
   }
 });
 await test("★ GenOffice slide window hard cap rejects 9 while auto preserves native fallback",async()=>{
   const exact=await read("slides.pptx",{reader:"genoffice",max_slides:9});
   assert.equal(exact.isError,true,text(exact));assert.match(text(exact),/最多8张/);
   const automatic=await read("slides.pptx",{reader:"auto",max_slides:9});
   assert.ok(!automatic.isError,text(automatic));
   assert.match(text(automatic),/SLIDE_1/);assert.match(text(automatic),/SLIDE_2/);
   assert.ok(!text(automatic).includes("GenOffice/Office"),"unsupported vendor window must use declared auto compatibility");
 });
 await test("★ Empty PPTX deck reports zero slides, no false missing-page failure",async()=>{
   for (const reader of ["genoffice","native"] as const) {
     const r=await read("empty-slides.pptx",{reader});
     assert.ok(!r.isError,text(r));
     assert.match(text(r),/0 (slides|页)|slides.*0/);
     assert.ok(!/next_slide/.test(text(r)),"empty deck cannot have continuation");
   }
 });
 await test("★ GenOffice multi-slide rejects source changed between vendor calls",async()=>{
   const mutable=join(root,"mutable-slides.pptx");copyFileSync(join(root,"slides.pptx"),mutable);
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   mkdirSync(join(root,"genoffice","packages","cli","dist"),{recursive:true});
   writeFileSync(fakeCli,`const fs=require("node:fs");\nconst args=process.argv.slice(2);\nconst file=args[2];\nconst idx=Number(args[args.indexOf("--slide")+1]);\nconsole.log(JSON.stringify({status:"ok",summary:"mocked vendor",detail:{slides:2,pages:[{index:idx,text:"S"+idx}]}}));\nif(idx===0) fs.appendFileSync(file,"MUTATED_AFTER_SLIDE_0");\n`);
   configureDocumentRepoRoot(root);
   try {
     const r=await read("mutable-slides.pptx",{reader:"genoffice",slide_start:1,max_slides:2});
     assert.equal(r.isError,true,text(r));
     assert.match(text(r),/修改|变化|版本|一致性/);
   } finally { configureDocumentRepoRoot(null); }
 });
 await test("★ GenOffice tiny output must retain PPTX next_slide cursor",async()=>{
   const r=await read("slides.pptx",{reader:"genoffice",max_chars:130});
   assert.ok(!r.isError,text(r));
   assert.match(text(r),/next_slide=2/);
   assert.ok(text(r).length<=130);
 });
 await test("PPTX reports page-limit truncation explicitly",async()=>{const r=await read("slides.pptx",{max_slides:1});assert.ok(!r.isError,text(r));assert.match(text(r),/截断|未读取/);});
 await test("PDF reader extracts real fixture text",async()=>{const r=await read("paper.pdf",{max_pages:1});assert.ok(!r.isError,text(r));assert.ok(text(r).includes("PAGE_1"));assert.ok(!text(r).includes("PAGE_2"));});
 // MC-065: the GenOffice backend must not parse a gigantic PDF just because
 // max_chars only limits returned text. Sparse file is private to this suite.
 const hugePdf=join(root,"oversize.pdf");writeFileSync(hugePdf,"%PDF-1.4\n");truncateSync(hugePdf,DOCUMENT_READ_BUDGET.maxRawBytes+1);
 for(const reader of ["native","auto","genoffice"] as const) await test(`★ ${reader} PDF is refused at raw-file budget BEFORE parser/CLI`,async()=>{
   const r=await read("oversize.pdf",{reader,max_chars:100});
   assert.equal(r.isError,true,text(r));
   assert.match(text(r),/PDF.*(?:预算|上限)|PDF.*超过|文件.*超过上限/);
   assert.match(text(r),new RegExp(String(DOCUMENT_READ_BUDGET.maxRawBytes)));
 });
 await test("★ GenOffice reader uses vendor PDFium instead of own pdfjs parser",async()=>{const r=await read("paper.pdf",{reader:"genoffice",page_start:2,max_pages:1});assert.ok(!r.isError,text(r));assert.match(text(r),/GenOffice\/PDFium/);assert.match(text(r),/PAGE_2/);assert.ok(!text(r).includes("PAGE_1"));});
 await test("★ explicit GenOffice mode must not silently use native layout parser",async()=>{const r=await read("paper.pdf",{reader:"genoffice",pdf_mode:"layout"});assert.equal(r.isError,true,text(r));assert.match(text(r),/不支持|请用/);});
 await test("★ GenOffice max_pages larger than short PDF is clipped to real page count, not rejected",async()=>{const r=await read("paper.pdf",{reader:"genoffice",max_pages:20});assert.ok(!r.isError,text(r));assert.match(text(r),/GenOffice\/PDFium/);assert.match(text(r),/PAGE_3/);});
 await test("★ GenOffice PDFium 220-page output is budgeted before CLI JSON",async()=>{
   const r=await read("many-pages.pdf",{reader:"genoffice",max_pages:220,max_chars:300000});
   assert.ok(!r.isError,text(r).slice(0,320));
   assert.match(text(r),/PAGE_220/,"requested final page must survive bounded preview");
   assert.match(text(r),/GenOffice\/PDFium/);
 });
 await test("★ Native tiny PDF response preserves next_page in front header",async()=>{
   const r=await read("paper.pdf",{reader:"native",page_start:1,max_pages:1,max_chars:140});
   assert.ok(!r.isError,text(r));assert.match(text(r),/next_page=2/);
   assert.ok(text(r).length<=140);
 });
 await test("★ GenOffice tiny PDF response preserves next_page when text is clipped",async()=>{
   const r=await read("paper.pdf",{reader:"genoffice",page_start:1,max_pages:1,max_chars:140});
   assert.ok(!r.isError,text(r));
   assert.match(text(r),/next_page=2/);
   assert.ok(text(r).length<=140);
 });
 await test("★ GenOffice PDF rejects a mismatched page from vendor envelope",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   mkdirSync(join(root,"genoffice","packages","cli","dist"),{recursive:true});
   writeFileSync(fakeCli,'console.log(JSON.stringify({status:"ok",summary:"wrong page",detail:{pages:3,pages_read:[{page:3,text:"OTHER_PAGE"}]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("paper.pdf",{reader:"genoffice",page_start:1,max_pages:1});
     assert.equal(r.isError,true,text(r));
     assert.match(text(r),/页码|页段|不一致|匹配/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice PDF refuses incomplete requested two-page window",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'console.log(JSON.stringify({status:"ok",summary:"MISSING_PAGE",detail:{pages:3,pages_read:[{page:1,text:"ONLY_FIRST"}]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("paper.pdf",{reader:"genoffice",page_start:1,max_pages:2});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/页段|页数|不完整|请求/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice PDF refuses page-count drift between probe and requested range",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'const a=process.argv.slice(2);const probe=!a.includes("--range")&&!a.includes("--page");console.log(JSON.stringify({status:"ok",summary:"COUNT_DRIFT",detail:{pages:probe?3:4,pages_read:probe?[{page:1,text:"PROBE"}]:[{page:1,text:"A"},{page:2,text:"B"}]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("paper.pdf",{reader:"genoffice",page_start:1,max_pages:2});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/页数|变化|不一致/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice PDF refuses source mutation after metadata probe even with identical page count",async()=>{
   const src=join(root,"mutable-probe.pdf");copyFileSync(join(root,"paper.pdf"),src);
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'const fs=require("node:fs"),a=process.argv.slice(2),probe=!a.includes("--range")&&!a.includes("--page");if(probe)fs.appendFileSync(a[2],"MUTATED_AFTER_PROBE");console.log(JSON.stringify({status:"ok",summary:"same count",detail:{pages:3,pages_read:probe?[{page:1,text:"probe"}]:[{page:1,text:"new1"},{page:2,text:"new2"}]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("mutable-probe.pdf",{reader:"genoffice",page_start:1,max_pages:2});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/修改|变化|版本|一致性/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice single-page PDF detects source changed during the native read",async()=>{
   const src=join(root,"mutable-single.pdf");copyFileSync(join(root,"paper.pdf"),src);
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'const fs=require("node:fs"),a=process.argv.slice(2);fs.appendFileSync(a[2],"CHANGED_DURING_PAGE");console.log(JSON.stringify({status:"ok",summary:"stale page",detail:{pages:3,pages_read:[{page:1,text:"old"}]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("mutable-single.pdf",{reader:"genoffice",page_start:1,max_pages:1});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/修改|变化|版本/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ Auto PDF falls back only for a genuinely unavailable GenOffice probe",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'console.log(JSON.stringify({status:"error",code:4,error:"app_unavailable",message:"mock PDFium unavailable"}));process.exitCode=4;\n');
   configureDocumentRepoRoot(root);
   try {
     const auto=await read("paper.pdf",{reader:"auto",page_start:2,max_pages:2});
     assert.ok(!auto.isError,text(auto));assert.match(text(auto),/PAGE_2/);assert.ok(!text(auto).includes("GenOffice\/PDFium"));
     const exact=await read("paper.pdf",{reader:"genoffice",page_start:2,max_pages:2});
     assert.equal(exact.isError,true,text(exact));assert.match(text(exact),/unavailable/i);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("PDF reports page-limit truncation instead of presenting total pages as read",async()=>{const r=await read("paper.pdf",{max_pages:1});assert.ok(!r.isError,text(r));assert.match(text(r),/截断|未读取/);});
 await test("★ PDF layout exposes real page dimensions and positioned text instead of a flattened paragraph",async()=>{
   const r=await read("paper.pdf",{pdf_mode:"layout",page_start:2,max_pages:1});
   assert.ok(!r.isError,text(r));
   const t=text(r);
   assert.match(t,/第 2 页/);assert.match(t,/\[x=\d+,y=\d+\]/);
   assert.match(t,/\[x=50,y=\d+\] PAGE_2_LEFT/,"左栏必须有独立坐标");
   assert.match(t,/\[x=340,y=\d+\] PAGE_2_RIGHT/,"右栏不能被并入左栏");
   assert.ok(!t.includes("PAGE_1")&&!t.includes("PAGE_3"),"Layout selection must not mix pages");
   assert.match(t,/未读取其余页|只读取了第 2/);
 });
 await test("★ PDF layout refuses an unbounded 500-page paint-operator walk",async()=>{
   const r=await read("paper.pdf",{pdf_mode:"layout",max_pages:500});
   assert.equal(r.isError,true,text(r));assert.match(text(r),/20 页|最多/);
 });
 await test("★ PDF layout out-of-range page fails explicitly instead of reporting empty success",async()=>{
   const r=await read("paper.pdf",{pdf_mode:"layout",page_start:40,max_pages:1});
   assert.equal(r.isError,true,text(r));assert.match(text(r),/超出|超过/);
 });
 await test("★ PDF text reading can resume at page 2 without silently restarting page 1",async()=>{
   const r=await read("paper.pdf",{page_start:2,max_pages:1});
   assert.ok(!r.isError,text(r));
   assert.match(text(r),/PAGE_2/);
   assert.ok(!text(r).includes("PAGE_1")&&!text(r).includes("PAGE_3"),"page_start ignored");
   assert.match(text(r),/第 2 页/);
   assert.match(text(r),/截断|未读取/);
 });
 await test("★ rendered PDF page is actual JPEG image content with correct dimensions",async()=>{
   const render=specs.find(x=>x.name==="agent_render_pdf_page");
   assert.ok(render,"MCP must expose PDF visual page rendering");
   const input=z.object(render!.inputSchema).parse({path:"paper.pdf",page:1,max_dimension:700,renderer:"native"});
   const r=await render!.handler(input,{sessionId:"document-fixture"});
   assert.ok(!r.isError,text(r));
   const block=r.content.find(c=>c.type==="image");
   assert.ok(block&&block.type==="image","MCP must return image content, not a base64 text blob");
   if(block?.type==="image"){
     assert.equal(block.mimeType,"image/jpeg");
     assert.deepEqual([...Buffer.from(block.data,"base64").subarray(0,2)],[0xff,0xd8]);
     assert.ok(block.data.length<8*1024*1024,"render output is bounded");
   }
 });
 await test("★ PDF page image route shares MC-065 raw PDF input ceiling",async()=>{
   const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
   const result=await render.handler(z.object(render.inputSchema).parse({path:"oversize.pdf",page:1,renderer:"genoffice",max_dimension:700}),{sessionId:"document-fixture"});
   assert.equal(result.isError,true,text(result));
   assert.match(text(result),new RegExp(String(DOCUMENT_READ_BUDGET.maxRawBytes)));
 });
 await test("★ GenOffice PDFium render returns a real PNG MCP image block without PyMuPDF",async()=>{
   const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
   const r=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:1,renderer:"genoffice",max_dimension:1400}),{sessionId:"document-fixture"});
   assert.ok(!r.isError,text(r));
   const block=r.content.find(c=>c.type==="image");assert.ok(block&&block.type==="image",text(r));
   if(block?.type==="image"){
     assert.equal(block.mimeType,"image/png");
     assert.equal(Buffer.from(block.data,"base64").subarray(0,8).toString("hex"),"89504e470d0a1a0a");
   }
 });
 await test("★ GenOffice PDFium image exposes authoritative page count",async()=>{
   const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
   const r=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:2,renderer:"genoffice",max_dimension:600}),{sessionId:"document-fixture"});
   assert.ok(!r.isError,text(r));assert.match(text(r),/第 2\/3 页/);
 });
 await test("★ auto PDF render falls back when GenOffice PDFium read is unavailable",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   mkdirSync(join(root,"genoffice","packages","cli","dist"),{recursive:true});
   writeFileSync(fakeCli,'console.log(JSON.stringify({status:"error",code:4,error:"app_unavailable",message:"fixture PDFium not found"}));process.exitCode=4;\n');
   configureDocumentRepoRoot(root);
   try {
     const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
     const r=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:1,renderer:"auto",max_dimension:600}),{sessionId:"document-fixture"});
     assert.ok(!r.isError,text(r));
     const image=r.content.find(c=>c.type==="image");assert.ok(image&&image.type==="image",text(r));
     if(image?.type==="image")assert.equal(image.mimeType,"image/jpeg");
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ renderer=auto falls back only when PDFium render stage is unavailable",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   mkdirSync(join(root,"genoffice","packages","cli","dist"),{recursive:true});
   writeFileSync(fakeCli,'const a=process.argv.slice(2);if(a[0]==="pdf"){console.log(JSON.stringify({status:"ok",summary:"geometry",detail:{pages:3,pages_read:[{page:1,width_pt:595,height_pt:842}]}}))}else{console.log(JSON.stringify({status:"error",code:4,error:"app_unavailable",message:"fixture PDFium render disabled"}));process.exitCode=4}\n');
   configureDocumentRepoRoot(root);
   try {
     const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
     const automatic=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:1,renderer:"auto",max_dimension:600}),{sessionId:"document-fixture"});
     assert.ok(!automatic.isError,text(automatic));
     const picture=automatic.content.find(c=>c.type==="image");assert.ok(picture&&picture.type==="image",text(automatic));
     if(picture?.type==="image")assert.equal(picture.mimeType,"image/jpeg");
     const exact=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:1,renderer:"genoffice",max_dimension:600}),{sessionId:"document-fixture"});
     assert.equal(exact.isError,true,text(exact));assert.match(text(exact),/render|PDFium|不可用|disabled/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ malformed PNG containing only IHDR dimensions must not be reported as image",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   mkdirSync(join(root,"genoffice","packages","cli","dist"),{recursive:true});
   writeFileSync(fakeCli,`const fs=require("node:fs"),path=require("node:path");const a=process.argv.slice(2);if(a[0]==="pdf"){console.log(JSON.stringify({status:"ok",summary:"fake",detail:{pages:3,pages_read:[{page:1,width_pt:600,height_pt:800}]}}));}else{const out=a[a.indexOf("--out")+1];const file=path.join(out,"pretend.png");const data=Buffer.alloc(24);Buffer.from("89504e470d0a1a0a","hex").copy(data);data.write("IHDR",12,"ascii");data.writeUInt32BE(1,16);data.writeUInt32BE(1,20);fs.writeFileSync(file,data);console.log(JSON.stringify({status:"ok",summary:"pretend",detail:{files:[{page:1,path:file,width:1,height:1}]}}));}`);
   configureDocumentRepoRoot(root);
   try {
     const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
     const r=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:1,renderer:"genoffice",max_dimension:600}),{sessionId:"document-fixture"});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/PNG|图像|无效/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice rejects duplicate rendered page artifacts",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9H8kAAAAASUVORK5CYII=";
   writeFileSync(fakeCli,`const fs=require("node:fs"),path=require("node:path");const a=process.argv.slice(2);if(a[0]==="pdf"){console.log(JSON.stringify({status:"ok",detail:{pages:3,pages_read:[{page:1,width_pt:595,height_pt:842}]}}));}else{const file=path.join(a[a.indexOf("--out")+1],"valid.png");fs.writeFileSync(file,Buffer.from("${png}","base64"));console.log(JSON.stringify({status:"ok",detail:{files:[{page:1,path:file,width:1,height:1},{page:1,path:file,width:1,height:1}]}}));}`);
   configureDocumentRepoRoot(root);
   try {
     const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
     const r=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:1,renderer:"genoffice",max_dimension:600}),{sessionId:"document-fixture"});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/唯一|重复|PNG/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice PDFium rejects PNG file path outside unique temp folder",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   const outside=join(root,"outside-render.png");
   writeFileSync(outside,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9H8kAAAAASUVORK5CYII=","base64"));
   writeFileSync(fakeCli,`const a=process.argv.slice(2);if(a[0]==="pdf"){console.log(JSON.stringify({status:"ok",detail:{pages:3,pages_read:[{page:1,width_pt:595,height_pt:842}]}}));}else{console.log(JSON.stringify({status:"ok",detail:{files:[{page:1,path:${JSON.stringify(outside)},width:1,height:1}]}}));}`);
   configureDocumentRepoRoot(root);
   try {
     const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
     const r=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:1,renderer:"genoffice",max_dimension:600}),{sessionId:"document-fixture"});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/围栏|临时目录|越过/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice refuses a PDF modified between geometry read and render",async()=>{
   const target=join(root,"mutable-render.pdf");copyFileSync(join(root,"paper.pdf"),target);
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,`const fs=require("node:fs");const args=process.argv.slice(2);if(args[0]==="pdf"){fs.appendFileSync(args[2],"MUTATION");console.log(JSON.stringify({status:"ok",summary:"old geometry",detail:{pages:3,pages_read:[{page:1,width_pt:595,height_pt:842}]}}))}else{console.log(JSON.stringify({status:"error",error:"should_not_render",message:"source had changed"}));process.exitCode=1}`);
   configureDocumentRepoRoot(root);
   try {
     const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
     const r=await render.handler(z.object(render.inputSchema).parse({path:"mutable-render.pdf",page:1,renderer:"genoffice",max_dimension:600}),{sessionId:"document-fixture"});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/修改|不同版本|变化/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice rejects PNG whose actual size contradicts vendor envelope",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9H8kAAAAASUVORK5CYII=";
   writeFileSync(fakeCli,`const fs=require("node:fs"),path=require("node:path");const a=process.argv.slice(2);if(a[0]==="pdf"){console.log(JSON.stringify({status:"ok",summary:"dimensions",detail:{pages:3,pages_read:[{page:1,width_pt:595,height_pt:842}]}}));}else{const out=a[a.indexOf("--out")+1],file=path.join(out,"image.png");fs.writeFileSync(file,Buffer.from("${png}","base64"));console.log(JSON.stringify({status:"ok",summary:"wrong dimensions",detail:{files:[{page:1,path:file,width:2,height:1}]}}));}`);
   configureDocumentRepoRoot(root);
   try {
     const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
     const r=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:1,renderer:"genoffice",max_dimension:600}),{sessionId:"document-fixture"});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/尺寸|元数据|不一致/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice wide PDF page is rendered under max_dimension using vendor page geometry",async()=>{
   const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
   const result=await render.handler(z.object(render.inputSchema).parse({path:"wide-paper.pdf",page:1,renderer:"genoffice",max_dimension:700}),{sessionId:"document-fixture"});
   assert.ok(!result.isError,text(result));
   const picture=result.content.find(c=>c.type==="image");
   assert.ok(picture&&picture.type==="image",text(result));
   if(picture?.type==="image"){
     assert.equal(picture.mimeType,"image/png");
     const bytes=Buffer.from(picture.data,"base64");
     assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
     assert.ok(bytes.readUInt32BE(16)<=700 && bytes.readUInt32BE(20)<=700,"vendor scaled real landscape page below budget");
   }
 });
 await test("★ PDF rendering invalid page is a visible failure",async()=>{
   const render=specs.find(x=>x.name==="agent_render_pdf_page")!;
   const r=await render.handler(z.object(render.inputSchema).parse({path:"paper.pdf",page:50}),{sessionId:"document-fixture"});
   assert.equal(r.isError,true,text(r));assert.match(text(r),/50|页|out of range/);
 });

 for(const file of ["paper.pdf","text.docx","slides.pptx"])await test(file+" respects max_chars=100 including truncation notice",async()=>{const r=await read(file,{max_chars:100});assert.ok(!r.isError,text(r));const t=text(r);assert.ok(t.length<=100,`returned ${t.length}`);assert.match(t,/截断/);assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t),"no split surrogate");});
 await test("DOCX Unicode survives Python pipe decoding",async()=>{const r=await read("text.docx");assert.ok(!r.isError,text(r));assert.ok(text(r).includes("研究😀"),text(r).slice(0,120));});
 await test("★ GenOffice creates the DOCX and MCP reuses its true style/table reader",async()=>{
   const cli=resolveGenofficeCliPath(resolve("../.."));assert.ok(cli,"GenOffice bundle is required for vendor-route test");
   writeFileSync(join(root,"genoffice-seed.md"),"# Vendor Heading\n\n| Key | Value |\n| --- | --- |\n| sample | 42 |\n");
   const ports={cliPath:cli,withinWorkspace:(p:string)=>p.startsWith(root)};
   const made=await convertFile(ports,join(root,"genoffice-seed.md"),"docx",join(root,"vendor.docx"));
   assert.ok(made.ok,JSON.stringify(made));
   const result=await read("vendor.docx",{reader:"genoffice",docx_mode:"structure",max_blocks:5});
   assert.ok(!result.isError,text(result));
   assert.match(text(result),/GenOffice\/Office/);
   assert.match(text(result),/Vendor Heading/);
   assert.match(text(result),/sample/);
   assert.match(text(result),/42/);
   const automatic=await spec.handler(z.object(spec.inputSchema).parse({path:"vendor.docx",docx_mode:"structure"}),{sessionId:"document-fixture"});
   assert.ok(!automatic.isError,text(automatic));
   assert.match(text(automatic),/GenOffice\/Office/,"unspecified reader should prefer the existing GenOffice engine");
 });
 await test("★ GenOffice DOCX late block uses vendor range BEFORE large stdout",async()=>{
   const cli=resolveGenofficeCliPath(resolve("../.."));assert.ok(cli,"GenOffice CLI snapshot missing");
   const ports={cliPath:cli,withinWorkspace:(p:string)=>p.startsWith(root)};
   const hugeMarkdown=Array.from({length:250},(_,i)=>`LONG_BLOCK_${i+1} ${"X".repeat(3300)}`).join("\n\n");
   writeFileSync(join(root,"long-structure.md"),hugeMarkdown);
   const converted=await convertFile(ports,join(root,"long-structure.md"),"docx",join(root,"long-structure.docx"));
   assert.ok(converted.ok,JSON.stringify(converted));
   const page=await read("long-structure.docx",{reader:"genoffice",docx_mode:"structure",block_start:220,max_blocks:2});
   assert.ok(!page.isError,text(page).slice(0,240));
   const body=text(page);
   assert.match(body,/LONG_BLOCK_220/);
   assert.match(body,/LONG_BLOCK_221/);
   assert.ok(!body.includes("LONG_BLOCK_219")&&!body.includes("LONG_BLOCK_222"),"GenOffice range ignored");
   assert.match(body,/next_block_start.*222/);
 });
 await test("★ Native tiny DOCX structure retains next_block_start cursor",async()=>{
   const r=await read("long-structure.docx",{reader:"native",docx_mode:"structure",block_start:220,max_blocks:2,max_chars:145});
   assert.ok(!r.isError,text(r));assert.match(text(r),/next_block_start=222/);
   assert.ok(text(r).length<=145);
 });
 await test("★ GenOffice tiny DOCX output retains next_block_start cursor",async()=>{
   const r=await read("long-structure.docx",{reader:"genoffice",docx_mode:"structure",block_start:220,max_blocks:2,max_chars:145});
   assert.ok(!r.isError,text(r));
   assert.match(text(r),/next_block_start=222/);
   assert.ok(text(r).length<=145);
 });
 await test("★ GenOffice DOCX rejects vendor block range inconsistent with request",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   mkdirSync(join(root,"genoffice","packages","cli","dist"),{recursive:true});
   writeFileSync(fakeCli,'console.log(JSON.stringify({status:"ok",summary:"WRONG_BLOCK",detail:{blocks:2,range:"0-0",items:[{index:0,text:"FORGED_0"}]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("text.docx",{reader:"genoffice",docx_mode:"structure",block_start:2,max_blocks:1});
     assert.equal(r.isError,true,text(r));
     assert.match(text(r),/结构块|range|索引|不一致/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice DOCX refuses same-count source mutation after block probe",async()=>{
   const src=join(root,"mutable-blocks.docx");copyFileSync(join(root,"long-structure.docx"),src);
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'const fs=require("node:fs"),a=process.argv.slice(2),rg=a[a.indexOf("--range")+1],probe=rg==="0";if(probe)fs.appendFileSync(a[2],"MUTATED_AFTER_PROBE");console.log(JSON.stringify({status:"ok",summary:"same blocks",detail:{blocks:250,range:probe?"0-0":"219-220",items:probe?[{index:0,text:"probe"}]:[{index:219,text:"one"},{index:220,text:"two"}]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("mutable-blocks.docx",{reader:"genoffice",docx_mode:"structure",block_start:220,max_blocks:2});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/修改|变化|版本|一致性/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ Auto DOCX fallback remains available after native vendor probe reports unavailable",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'console.log(JSON.stringify({status:"error",code:4,error:"app_unavailable",message:"mock DOCX unavailable"}));process.exitCode=4;\n');
   configureDocumentRepoRoot(root);
   try {
     const auto=await read("text.docx",{reader:"auto",docx_mode:"structure",block_start:1,max_blocks:2});
     assert.ok(!auto.isError,text(auto));assert.match(text(auto),/DOCX XML 结构/);
     const exact=await read("text.docx",{reader:"genoffice",docx_mode:"structure",block_start:1,max_blocks:2});
     assert.equal(exact.isError,true,text(exact));assert.match(text(exact),/unavailable/i);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice DOCX refuses block count changed between probe and selected window",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'const args=process.argv.slice(2);const rg=args[args.indexOf("--range")+1];const probe=rg==="0";console.log(JSON.stringify({status:"ok",summary:"MUTATED_BLOCKS",detail:{blocks:probe?3:4,range:probe?"0-0":"1-1",items:[{index:probe?0:1,text:"MUTATED"}]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("text.docx",{reader:"genoffice",docx_mode:"structure",block_start:2,max_blocks:1});
     assert.equal(r.isError,true,text(r));assert.match(text(r),/块数量|版本|变化|不一致/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice DOCX refuses missing or malformed block envelope",async()=>{
   const fakeCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
   writeFileSync(fakeCli,'console.log(JSON.stringify({status:"ok",summary:"MALFORMED",detail:{blocks:2,range:"0-0",items:"not-an-array"}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("text.docx",{reader:"genoffice",docx_mode:"structure",block_start:1,max_blocks:1});
     assert.equal(r.isError,true,text(r));
     assert.match(text(r),/结构块|索引|字段|格式|不合法/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ GenOffice large DOCX default read reports native continuation",async()=>{
   const r=await read("long-structure.docx",{reader:"genoffice"});
   assert.ok(!r.isError,text(r).slice(0,300));
   const body=text(r);
   assert.match(body,/LONG_BLOCK_1\b/);
   assert.ok(!body.includes("LONG_BLOCK_220"),"Default read must not claim to load every block");
   assert.match(body,/next_block_start.*31/);
   assert.match(body,/truncated.*true/);
 });
 await test("★ oversized GenOffice CLI JSON fails with explicit output budget, not malformed JSON",async()=>{
   const cli=resolveGenofficeCliPath(resolve("../.."));assert.ok(cli);
   const ports={cliPath:cli,withinWorkspace:(p:string)=>p.startsWith(root)};
   const result=await docsRead(ports,join(root,"long-structure.docx"),{full:true});
   assert.equal(result.ok,false,"oversized full document must not be falsely reported as complete");
   if(!result.ok)assert.match(result.reason,/输出超过.*字节|输出.*预算/);
 });
 await test("★ GenOffice DOCX late out-of-range block fails instead of wrapping around",async()=>{
   const r=await read("long-structure.docx",{reader:"genoffice",docx_mode:"structure",block_start:999,max_blocks:1});
   assert.equal(r.isError,true,text(r));
   assert.match(text(r),/block_start=999.*超过/);
 });
 writeFileSync(join(root,"styled.docx"),Buffer.from("UEsDBBQAAAAIAImmUl2/054C3wAAAO8BAAARAAAAd29yZC9kb2N1bWVudC54bWyVkduKwjAQhl9F+gBOV9CLUAtFg0dsqWvFK4ltPEAOJclu1rffGrWCB8Sb+Rnm/+ZnmMCiQuY/nArT+ONMaGS73t6YEgHofE850U1ZUlHNtlJxYqpW7cBKVZRK5lTrg9hxBi3f7wAnB+GFgUUbWRxPWrqSKCdzc2S0YdEvYV1vSElRkV8ehAHUHldMmKTxGPe+13GG02yElyeHcT51dte7L8Ac9+JZf51EaTRIo2T4FDAb5uTM5Pc7Jnj1BIOr9RHIoukCv0agjnoRyKTWnyX6Tb/9NhAul8L1DXB7cfgPUEsBAhQDFAAAAAgAiaZSXb/TngLfAAAA7wEAABEAAAAAAAAAAAAAAIABAAAAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAABAAEAPwAAAA4BAAAAAA==","base64"));
 await test("★ DOCX structure must preserve style and table coordinates",async()=>{const r=await read("styled.docx",{docx_mode:"structure",max_blocks:3});assert.ok(!r.isError,text(r));assert.match(text(r),/Heading1/);assert.match(text(r),/TABLE 2×2/);assert.match(text(r),/\[c1\]loss/);assert.match(text(r),/\[c2\]0\.05/);});
 await test("★ DOCX structure supports partial block reads with continuation",async()=>{const r=await read("styled.docx",{docx_mode:"structure",block_start:2,max_blocks:1});assert.ok(!r.isError,text(r));assert.match(text(r),/SECOND_PARAGRAPH/);assert.ok(!text(r).includes("PROJECT_OVERVIEW")&&!text(r).includes("loss"));assert.match(text(r),/next_block_start=3/);});
 await test("★ DOCX structure out-of-range is error instead of empty success",async()=>{const r=await read("styled.docx",{docx_mode:"structure",block_start:999});assert.equal(r.isError,true,text(r));assert.match(text(r),/超过/);});
 await test("★ DOCX structure cannot bypass existing ZIP decompression guard",async()=>{const r=await read("bomb.docx",{docx_mode:"structure"});assert.equal(r.isError,true,text(r));assert.match(text(r),/解压后体积|压缩膨胀/);});
 await test("★ DOCX default text mode is unchanged after structure addition",async()=>{const r=await read("styled.docx");assert.ok(!r.isError,text(r));assert.match(text(r),/PROJECT_OVERVIEW/);assert.match(text(r),/0\.05/);});
 await test("★ GenOffice sheet adapter forwards native worksheet/range/max-rows flags",async()=>{
   const fakeCli=join(root,"probe-sheet-cli.cjs");
   writeFileSync(fakeCli,'process.stdout.write(JSON.stringify({status:"ok",summary:"fake",detail:{argv:process.argv.slice(2)}})+"\\n")');
   const ports={cliPath:fakeCli,withinWorkspace:(p:string)=>p.startsWith(root)};
   const result=await sheetRead(ports,join(root,"table.xlsx"),undefined,{sheet:"Research",range:"A2:B2",maxRows:2});
   assert.ok(result.ok,JSON.stringify(result));
   if(result.ok){
     const argv=(result.envelope.detail as {argv:string[]}).argv;
     assert.deepEqual(argv.slice(0,3),["sheet","read",join(root,"table.xlsx")]);
     assert.ok(argv.includes("--json"));
     assert.deepEqual(argv.slice(argv.indexOf("--sheet"),argv.indexOf("--sheet")+2),["--sheet","Research"]);
     assert.deepEqual(argv.slice(argv.indexOf("--range"),argv.indexOf("--range")+2),["--range","A2:B2"]);
     assert.deepEqual(argv.slice(argv.indexOf("--max-rows"),argv.indexOf("--max-rows")+2),["--max-rows","2"]);
   }
 });
 await test("★ explicitly unsupported GenOffice max_cols fails rather than ignoring it",async()=>{
   const r=await read("table.xlsx",{reader:"genoffice",max_cols:1});
   assert.equal(r.isError,true,text(r));
   assert.match(text(r),/筛选参数|无法|不支持/);
 });
 const fakeSheetCli=join(root,"genoffice","packages","cli","dist","genoffice.cjs");
 const sheetSpawnMarker=join(root,"sheet-cli-spawned.txt");
 mkdirSync(join(root,"genoffice","packages","cli","dist"),{recursive:true});
 writeFileSync(fakeSheetCli,`const fs=require("node:fs");\nfs.writeFileSync(${JSON.stringify(join(root,"sheet-cli-spawned.txt"))},"called");\nconst args=process.argv.slice(2);const idx=args.indexOf("--range");const range=idx<0?"none":args[idx+1];\nconsole.log(JSON.stringify({status:"ok",summary:"MOCK_SHEET "+range,detail:{sheet:"Research",rows:[["SAFE"]],range}}));\n`);
 await test("★ GenOffice huge XLSX range is refused before any vendor process even with max_rows=1",async()=>{
   rmSync(sheetSpawnMarker,{force:true});configureDocumentRepoRoot(root);
   try {
     const r=await read("table.xlsx",{reader:"genoffice",range:"A1:AZ3000",max_rows:1});
     assert.equal(r.isError,true,text(r));
     assert.match(text(r),/单元格预算|超过/);
     assert.match(text(r),/100000/);
     assert.equal(existsSync(sheetSpawnMarker),false,"unbounded range reached GenOffice before budget check");
   } finally { configureDocumentRepoRoot(null); }
 });
 await test("★ GenOffice range guard also refuses invalid A1 coordinates and huge rectangles",async()=>{
   configureDocumentRepoRoot(root);
   try {
     for(const range of ["A1:XFD1048576","XFE1","A0:B10","A1:AZ3000"]){
       const r=await read("table.xlsx",{reader:"genoffice",range,max_rows:1});
       assert.equal(r.isError,true,`${range}: ${text(r)}`);
     }
     assert.equal(existsSync(sheetSpawnMarker),false,"invalid range launched the CLI");
   } finally { configureDocumentRepoRoot(null); }
 });
 await test("★ GenOffice safe XLSX area still reaches the original vendor selector",async()=>{
   rmSync(sheetSpawnMarker,{force:true});configureDocumentRepoRoot(root);
   try {
     const r=await read("table.xlsx",{reader:"genoffice",range:"A1:B3",max_rows:2});
     assert.ok(!r.isError,text(r));
     assert.match(text(r),/GenOffice\/Office/);
     assert.match(text(r),/MOCK_SHEET A1:B3/);
     assert.equal(existsSync(sheetSpawnMarker),true,"normal range must use GenOffice");
   } finally { configureDocumentRepoRoot(null); }
 });
 await test("★ GenOffice sheet rejects vendor response for a different requested worksheet",async()=>{
   writeFileSync(fakeSheetCli,'console.log(JSON.stringify({status:"ok",summary:"OTHER_SHEET",detail:{sheet:"Unexpected",range:"A1:B2",rows:[["WRONG"]]}}))\n');
   configureDocumentRepoRoot(root);
   try {
     const r=await read("table.xlsx",{reader:"genoffice",sheet:"Research",range:"A1:B2",max_rows:2});
     assert.equal(r.isError,true,text(r));
     assert.match(text(r),/工作表|sheet|不一致/);
   } finally {configureDocumentRepoRoot(null);}
 });
 await test("★ Native tiny XLSX output preserves range-clipped warning",async()=>{
   const r=await read("table.xlsx",{reader:"native",sheet:"Research",range:"A1:J1000",max_rows:1,max_cols:2,max_chars:125});
   assert.ok(!r.isError,text(r));assert.match(text(r),/range.*截断|部分区域|range.*夹紧/);
   assert.ok(text(r).length<=125);
 });
 await test("Excel selection returns actual Unicode cells and values",async()=>{const r=await read("table.xlsx",{sheet:"Research",range:"A2:B2"});assert.ok(!r.isError,text(r));assert.match(text(r),/研究论文/);assert.match(text(r),/2026/);});
 // 【MC-065】显式 range 必须**在迭代之前**夹紧,并显式回报 range 被截断。
 // 修前 `ws[rg]` 会先按声明的 dimension 构造整个矩形(与 max_rows/max_cols 无关),
 // 且**没有任何**"range 被截断"回执 —— 模型看到的只是前几格,却以为拿到了整个 range。
 // 这里宽工作簿声明 A1:ZZ1000000 而真实数据只有三行:请求 max_rows=1/max_cols=1 时
 // 必须只返回第一格、并明确说 range 被夹紧(不是默默假装读全了)。
 await test("★ 超大声明 range 在迭代前被夹紧且显式回报(不是 ws[rg] 全量物化)",async()=>{
  const r=await read("wide.xlsx",{sheet:"Wide",range:"A1:ZZ1000000",max_rows:1,max_cols:1});
  assert.ok(!r.isError,text(r));
  const t=text(r);
  assert.match(t,/WIDE_1/,t.slice(0,200));
  assert.ok(!t.includes("WIDE_2"),"max_rows=1 却返回了第二行:夹紧没生效");
  assert.match(t,/已.*夹紧|range.*截断|截断/,t.slice(0,300));
 });
 await test("★ 正常 range 不被误报为截断(Sheet!A1:C3 实际内容一致)",async()=>{
  const r=await read("table.xlsx",{sheet:"Research",range:"A1:B2",max_rows:10,max_cols:10});
  assert.ok(!r.isError,text(r));
  const t=text(r);
  assert.match(t,/Title/);assert.match(t,/研究论文/);
  assert.ok(!/夹紧|range.*截断/.test(t),"在预算内的正常 range 不该被标成截断");
 });
 // 【MC-065·第三轮】恶意大稀疏坐标:dimension 声明 A1:ZZ1000000,真实数据只有相隔极远的
 // 两格(第 1 行与第 1000000 行)。max_rows=1000×max_cols=200=200000 格 > maxCells(100000),
 // 新模型必须**显式回报**行×列被夹到预算内(不是默默假装读全),且不得去枚举十万亿格的矩形。
 await test("★ 超大稀疏坐标 xlsx:行×列超 maxCells 时夹到预算内并显式回报",async()=>{
  const r=await read("sparse.xlsx",{sheet:"Sparse",max_rows:1000,max_cols:200});
  assert.ok(!r.isError,text(r));
  const t=text(r);
  // 第一格必须读到;夹紧必须显式说明(判据立在用户/模型看到的那行字上)。
  assert.match(t,/SPARSE_TOP/,t.slice(0,300));
  assert.match(t,/单元格预算|夹到|部分区域/,t.slice(0,300));
  // 夹紧后的行列数应为 maxCells/cols=100000/200=500 行 × 200 列。
  const {maxRows,maxCols,cellBudgetTruncated}=clampCellBudget(1000,200,DOCUMENT_READ_BUDGET.maxCells!);
  assert.equal(cellBudgetTruncated,true,"1000×200 应判为超预算");
  assert.ok(maxRows*maxCols<=DOCUMENT_READ_BUDGET.maxCells!,"夹紧后 行×列 必须 ≤ maxCells");
 });
 // 【MC-065·第三轮】单元格文本膨胀:一个小工作簿,但读出文本量**超过子进程输出字节预算**
 // (16 MiB)。危险不是格数(在 max_rows/max_cols 内)而是单元格体积。到界即提前终止并报错,
 // 不得跑完再悄悄截断成一份假完整正文。
 await test("★ 单元格文本膨胀 xlsx:文本量超子进程输出预算时提前终止报错",async()=>{
  const r=await read("fat.xlsx",{sheet:"Fat"});
  assert.equal(r.isError,true,text(r));
  assert.match(text(r),/输出超过|字节上限|提前终止/,text(r));
 });
 // 【MC-065·第三轮】高压缩(deflate 炸弹):~200 KB 的 .docx,其 word/document.xml **声明**
 // 解压后 ≥200 MiB(比例 1000:1)。DOCX 抽取会整份 `z.read(...)`,故必须在**交给解析器之前**
 // 按同一份 ReadBudget 的 maxDecompressedBytes 前拒 —— 不能把 200 MiB 真解压进内存再处理。
 await test("★ 高压缩 xlsx/docx 容器声明解压体积超预算时前置拒绝(不 OOM)",async()=>{
  const r=await read("bomb.docx");
  assert.equal(r.isError,true,text(r));
  // 只认**前拒**那两句的措辞(「解压后体积」/「压缩膨胀」),它们不出现在子进程输出兜底的
  // 报错里 —— 这样这条断言测的确实是「交给解析器之前」那一层,而不是被兜底预算误判为绿。
  assert.match(text(r),/解压后体积|压缩膨胀/,text(r));
 });
 // 【MC-065·第三轮】**最干净的判别式**:bloated.xlsx 里要读的表极小(openpyxl 本可正常读出
 // SMALL_OK),但另挂一个声明解压 200 MiB 的无用成员,抽取器根本不会读它。撤掉前置预算时
 // 这个工作簿会**顺利返回 SMALL_OK**(而不是被别的预算兜底报错)—— 所以这条能精确区分
 // 「压缩膨胀前拒真的生效」与「碰巧被子进程字节上限拦住」。
 await test("★ 压缩膨胀前拒:无用大成员也拦下(撤掉前拒会误报 SMALL_OK 读成功)",async()=>{
  const r=await read("bloated.xlsx");
  assert.equal(r.isError,true,`带超大无用成员的工作簿不该被当成功读:${text(r)}`);
  assert.match(text(r),/解压后体积|压缩膨胀/,text(r));
  assert.ok(!text(r).includes("SMALL_OK"),"前拒未生效:竟然把表读出来了");
 });
 // 【MC-065·第三轮】协议层:checkZipInflation 直接读中央目录,声明解压超预算即报 exceeded,
 // 正常小文件不误报,非 zip 输入不当成超预算。
 await test("协议层:checkZipInflation 声明解压超预算判 exceeded,正常文件不误报",async()=>{
  const {readFileSync}=await import("node:fs");
  const bomb=readFileSync(join(root,"bomb.docx"));
  const over=checkZipInflation(bomb,DOCUMENT_READ_BUDGET.maxDecompressedBytes!);
  assert.equal(over.exceededBudget,true,JSON.stringify(over));
  assert.ok(over.declaredBytes>DOCUMENT_READ_BUDGET.maxDecompressedBytes!,JSON.stringify(over));
  const small=readFileSync(join(root,"table.xlsx"));
  const ok=checkZipInflation(small,DOCUMENT_READ_BUDGET.maxDecompressedBytes!);
  assert.equal(ok.exceededBudget,false,JSON.stringify(ok));
  const notZip=checkZipInflation(Buffer.from("这不是一个 zip 容器"),DOCUMENT_READ_BUDGET.maxDecompressedBytes!);
  assert.equal(notZip.exceededBudget,false,"非 zip 不能冒充超预算");
 });
 await test("invalid sheet fails rather than claiming an empty document",async()=>{const r=await read("table.xlsx",{sheet:"absent"});assert.equal(r.isError,true);});
 // agent 工具表是**按会话**持有进程 / 后台搜索 / SSH 的"进程级单例"(见 agentTools.ts
 // 文件头与 agentSessionCleanup.ts)。但桥(agentEngineBridge)的 specs() 每次取都要现调
 // agentMcpTools —— 也就是**每轮 sendTurn、每次工具调用**都调。若每次都新建三张管理器
 // 再登记一条释放函数,闭包就一条会话一份、且永远没人回收:登记的 set 只涨不落。
 await test("重复取工具表不会让释放登记无限增长(进程级单例只建一次)",async()=>{
  const before=__registeredDisposerCount(),beforeShutdown=__registeredShutdownHookCount();
  for(let i=0;i<5;i++)agentMcpTools({cwdFor:()=>root});
  assert.equal(__registeredDisposerCount(),before,"每次调 agentMcpTools 都登记新释放函数,登记的 set 只涨不落");
  assert.equal(__registeredShutdownHookCount(),beforeShutdown,"每次调 agentMcpTools 都登记新退出钩子,钩子只涨不落");
 });
 // 上一条断言的是"登记不涨";这一条断言它**为什么**要紧 —— 用户的真实症状。桥给 Pi / Codex
 // 是按名现取工具表再派发的:start 一次拿到 process_id,之后 write/read/stop 是**另几次**
 // 取表。若每次取表都换一张空管理器,那句 process_id 在后一次取的表里根本查不到 ——
 // "进程不存在" 而不是 "Start 后读不到输出"。用**两次独立取表**模拟那一串调用。
 await test("一个表里 start 的进程句柄,另一次取表仍查得到(否则 Pi/Codex 的进程工具整个坏掉)",async()=>{
  const cmd=process.platform==="win32"?'node -e "setTimeout(function(){},8000)"':"sleep 8";
  const started=await agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_process_start")!.handler(
    z.object({command:z.string(),timeout_ms:z.number().optional(),wait_ms:z.number().optional()}).parse({command:cmd,timeout_ms:8000,wait_ms:0}),
    {sessionId:"proc-persist"},
  );
  const id=/process_id[:：]?\s*`?([A-Za-z0-9_]+)/.exec(text(started))?.[1] ?? /(proc_[0-9a-f]+)/.exec(text(started))?.[1];
  assert.ok(id,"start 必须报出 process_id");
  try{
    // **另取一次表**(模拟 Pi/Codex 的下一次派发),按那个 id 读。
    const listed=await agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_process_sessions")!.handler({},{sessionId:"proc-persist"});
    assert.ok(text(listed).includes(id!),`后一次取表里查不到 ${id} —— 进程工具在 Pi/Codex 下会整个失效`);
  }finally{
    try{await agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_process_stop")!.handler({process_id:id!},{sessionId:"proc-persist"});}catch{/* best effort */}
  }
 });
 // Force legacy pipe encodings even on UTF-8 developer machines. Only these
 // serial tests change parent env, restoring every key afterward.
 const keys=["PYTHONIOENCODING","PYTHONUTF8","PYTHONCOERCECLOCALE"] as const;
 const originalEnv=keys.map(key=>[key,process.env[key]] as const);
 try {
  for(const encoding of ["cp1252","gbk"]){
   process.env.PYTHONIOENCODING=encoding+":strict";
   process.env.PYTHONUTF8="0";process.env.PYTHONCOERCECLOCALE="0";
   for(const [file,expected] of [["text.docx","研究😀"],["table.xlsx","研究论文😀"],["slides.pptx","研究😀"]]){
    await test(`${encoding} parent: ${file} returns UTF-8 Unicode`,async()=>{
     const r=await read(file!);assert.ok(!r.isError,text(r));assert.ok(text(r).includes(expected!),text(r).slice(0,160));
     assert.equal(process.env.PYTHONIOENCODING,encoding+":strict","reader must not modify parent environment");
    });
   }
   await test(`${encoding} parent: Python stderr retains Unicode`,async()=>{
    const r=await read("table.xlsx",{sheet:"不存在😀"});assert.equal(r.isError,true);assert.ok(text(r).includes("不存在😀"),text(r));
   });
  }
 }finally{for(const [key,value] of originalEnv){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 // 【MC-065】URL 正文预算必须**在输入端**生效:达到 max_chars 就停止读取并 abort,
 // 而不是先 `res.text()` 把整份收进来再截断。用一个只监听 127.0.0.1 的临时服务回送
 // 一大坨(远大于 max_chars)文本,并记录**它实际被要求发送了多少字节** —— 客户端若
 // 在预算处 cancel,服务端只能看到部分字节写出(连接被对端关闭)。
 await test("★ URL 读取在输入端有界:max_chars 处停止读取而非先下载完整响应",async()=>{
  const TOTAL=4*1024*1024; // 4 MiB,远大于任何 max_chars
  let acceptedBytes=0; let gotClientAbort=false;
  const server=createServer((req,res)=>{
   res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8","Content-Length":String(TOTAL)});
   // 分块慢发,让客户端有时间在预算处 cancel。
   const chunk=Buffer.alloc(64*1024,0x41); // 'A'
   let sent=0;
   const tick=()=>{
    if(sent>=TOTAL){res.end();return;}
    const ok=res.write(chunk);
    sent+=chunk.length; acceptedBytes=sent;
    if(!ok){res.once("drain",tick);return;}
    setTimeout(tick,1);
   };
   req.on("close",()=>{gotClientAbort=true;});
   tick();
  });
  await new Promise<void>((r)=>server.listen(0,"127.0.0.1",()=>r()));
  const port=(server.address() as {port:number}).port;
  try{
   const urlSpec=agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_read_url")!;
   const out=await urlSpec.handler(z.object(urlSpec.inputSchema).parse({url:`http://127.0.0.1:${port}/`,max_chars:1000,timeout_ms:8000}),{sessionId:"url-fixture"});
   const t=toolTextOf(out as ToolResult);
   assert.ok(!(out as ToolResult).isError,t);
   assert.match(t,/status: 200/);
   // 给服务端一点时间感知对端关闭。
   await new Promise((r)=>setTimeout(r,200));
   assert.ok(t.length<=1000+400,`返回正文应被压在 max_chars 附近,实际 ${t.length}`);
   assert.match(t,/部分正文|截断/,t.slice(-200));
   assert.ok(acceptedBytes<TOTAL,`客户端消费了完整 ${TOTAL} 字节——没有在输入端停止(${acceptedBytes})`);
  }finally{await new Promise<void>((r)=>server.close(()=>r()));}
 });
 // 【MC-065 §34.3 原样复现】审查者的 E1:第一块发 BEGIN-PARTIAL-ONLY,第二次 pull 抛
 // INJECTED_NETWORK_FAILURE。对**同一个 Response** 再调 res.text()(已由 getReader 锁定)
 // 必然失败,旧代码于是 catch(()=>out) 返回片段、truncated=false 的假完整。
 // 这里直接打协议函数,断言结局是 READ_ERROR_AFTER_PARTIAL(而不是 COMPLETE)。
 await test("★ 协议层:中途读错是 READ_ERROR_AFTER_PARTIAL,不是 COMPLETE",async()=>{
  let pulls=0;
  const stream=new ReadableStream<Uint8Array>({
   pull(c){
    pulls++;
    if(pulls===1){c.enqueue(new TextEncoder().encode("BEGIN-PARTIAL-ONLY"));return;}
    throw new Error("INJECTED_NETWORK_FAILURE");
   },
  });
  const budget:ReadBudget={maxRawBytes:1<<20,maxDecodedBytes:1<<20,maxOutputChars:10000,maxTimeMs:5000};
  const res=new Response(stream,{status:200,headers:{"content-type":"text/plain"}});
  const out=await readResponseWithinBudget(res,budget);
  assert.equal(out.kind,"READ_ERROR_AFTER_PARTIAL",JSON.stringify(out));
  assert.ok(out.text.includes("BEGIN-PARTIAL-ONLY"),out.text);
  assert.equal(out.charsRead,"BEGIN-PARTIAL-ONLY".length);
 });
 // 【MC-065】正常 EOF 是 COMPLETE;触及输出上限是 TRUNCATED_BY_BUDGET(不是 COMPLETE)。
 await test("协议层:正常 EOF=COMPLETE,超上限=TRUNCATED_BY_BUDGET",async()=>{
  const budget:ReadBudget={maxRawBytes:1<<20,maxDecodedBytes:1<<20,maxOutputChars:10,maxTimeMs:5000};
  const small=await readResponseWithinBudget(new Response("hello"),budget);
  assert.equal(small.kind,"COMPLETE",JSON.stringify(small));
  const big=await readResponseWithinBudget(new Response("A".repeat(1000)),budget);
  assert.equal(big.kind,"TRUNCATED_BY_BUDGET",JSON.stringify(big));
  assert.equal(big.text.length,10);
 });
 // 【MC-065】并发闸门:到上限立即拒绝(不是排队攒内存),释放后又能进。
 await test("协议层:并发闸门到上限拒绝,释放后可再进",async()=>{
  const gate=new ResponseReadGate(2);
  assert.equal(gate.tryAcquire(),true);
  assert.equal(gate.tryAcquire(),true);
  assert.equal(gate.tryAcquire(),false,"到上限必须拒绝");
  gate.release();
  assert.equal(gate.tryAcquire(),true,"释放后应可再进");
  assert.ok(MAX_CONCURRENT_URL_READS>=1);
 });
 // 【MC-065·第三轮】文档读取预算同一份模型:单元格数、解压后字节、子进程输出都在
 // DOCUMENT_READ_BUDGET 上,且文档读取共用一条并发闸门。
 await test("协议层:文档读取的 cell/解压/子进程预算同在一份 ReadBudget 上",async()=>{
  const {documentReadGate,MAX_CONCURRENT_DOCUMENT_READS}=await import("@main/lib/readBudget.js");
  assert.ok(DOCUMENT_READ_BUDGET.maxCells!>=1);
  assert.ok(DOCUMENT_READ_BUDGET.maxDecompressedBytes!>=1);
  assert.equal(DOCUMENT_READ_BUDGET.maxChildOutputBytes!>0,true);
  const held:boolean[]=[];
  for(let i=0;i<MAX_CONCURRENT_DOCUMENT_READS;i++)held.push(documentReadGate.tryAcquire());
  assert.ok(held.every(Boolean),"未到上限前都应进得去");
  assert.equal(documentReadGate.tryAcquire(),false,"到文档读取上限必须拒绝");
  documentReadGate.release();
  assert.equal(documentReadGate.tryAcquire(),true,"释放后应可再进");
  documentReadGate.release();
  for(let i=0;i<held.length-1;i++)documentReadGate.release();
  assert.equal(documentReadGate.active,0,"闸门计数必须回到 0");
 });
 // 【MC-065】Content-Type 分类:图片/PDF 是二进制,文本/无头是文本。
 await test("协议层:Content-Type 分类文本与二进制",async()=>{
  assert.equal(classifyContentType("image/png"),"binary");
  assert.equal(classifyContentType("application/pdf"),"binary");
  assert.equal(classifyContentType("text/html; charset=utf-8"),"text");
  assert.equal(classifyContentType("application/json"),"text");
  assert.equal(classifyContentType(""),"text");
 });
 // 【MC-065】204(无响应体)是正常 COMPLETE 空正文,不是失败。
 await test("协议层:204 无响应体=COMPLETE 空正文",async()=>{
  const budget:ReadBudget={maxRawBytes:1<<20,maxDecodedBytes:1<<20,maxOutputChars:1000,maxTimeMs:5000};
  const out=await readResponseWithinBudget(new Response(null,{status:204}),budget);
  assert.equal(out.kind,"COMPLETE",JSON.stringify(out));
  assert.equal(out.text,"");
 });
 // 【MC-065】多字节字符跨 chunk 边界不得被切成半个(两个 U+FFFD)。
 await test("协议层:UTF-8 字符跨 chunk 不被切坏",async()=>{
  const enc=new TextEncoder();const bytes=enc.encode("中文😀结束"); // 多字节跨块
  const stream=new ReadableStream<Uint8Array>({
   start(c){ // 逐字节推,强制每个多字节字符都跨 chunk 边界
    for(const b of bytes)c.enqueue(new Uint8Array([b]));
    c.close();
   },
  });
  const budget:ReadBudget={maxRawBytes:1<<20,maxDecodedBytes:1<<20,maxOutputChars:1000,maxTimeMs:5000};
  const out=await readResponseWithinBudget(new Response(stream),budget);
  assert.equal(out.kind,"COMPLETE",JSON.stringify(out));
  assert.equal(out.text,"中文😀结束",out.text);
  assert.ok(!out.text.includes("�"),out.text);
 });
 // 【MC-065】单块就超过字符上限:同一块内到界,结局是 TRUNCATED_BY_BUDGET。
 await test("协议层:单块超上限=TRUNCATED_BY_BUDGET",async()=>{
  const budget:ReadBudget={maxRawBytes:1<<20,maxDecodedBytes:1<<20,maxOutputChars:5,maxTimeMs:5000};
  const out=await readResponseWithinBudget(new Response("A".repeat(5000)),budget);
  assert.equal(out.kind,"TRUNCATED_BY_BUDGET",JSON.stringify(out));
  assert.equal(out.text.length,5);
 });
 // 【MC-065 §34.3】URL **中途读错不得伪装成完整短文**。修前 readBodyWithinCharBudget 的
 // catch 会对已锁定的 Response 再调 res.text()(必然失败),再 catch(()=>out) 返回此前片段
 // —— 片段短于 max_chars 时 truncated=false,于是一次中途断网被当成"读完整了"。现在
 // 必须判 isError,并明确告知"这是部分内容"。判据立在用户/模型看到的那行字上。
 await test("★ URL 中途读错必须报错且明说部分内容,不得伪装成完整短文",async()=>{
  const server=createServer((req,res)=>{
   res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8","Content-Length":"1048576"});
   res.write("BEGIN-PARTIAL-ONLY");
   setTimeout(()=>{res.socket?.destroy();},20); // 明写更小的 Content-Length 后中途掐断
  });
  await new Promise<void>((r)=>server.listen(0,"127.0.0.1",()=>r()));
  const port=(server.address() as {port:number}).port;
  try{
   const urlSpec=agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_read_url")!;
   const out=await urlSpec.handler(z.object(urlSpec.inputSchema).parse({url:`http://127.0.0.1:${port}/`,max_chars:10000,timeout_ms:8000}),{sessionId:"url-fixture"}) as ToolResult;
   const t=toolTextOf(out);
   assert.equal(out.isError,true,`中途断网被当成成功:${t}`);
   assert.match(t,/部分内容|中途失败|读取 URL 失败/,t);
  }finally{await new Promise<void>((r)=>server.close(()=>r()));}
 });
 // 【MC-065】超时也是失败形态:服务端一直不发完,timeout_ms 到点必须报错(并说明已有部分内容),
 // 不得当成完整短文返回。timeout_ms 下限 1000ms,这里用 1200ms。
 await test("★ URL 超时被明确报错,不得伪装成完整短文",async()=>{
  const server=createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8"});res.write("A");/* 永不结束 */});
  await new Promise<void>((r)=>server.listen(0,"127.0.0.1",()=>r()));
  const port=(server.address() as {port:number}).port;
  try{
   const urlSpec=agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_read_url")!;
   const out=await urlSpec.handler(z.object(urlSpec.inputSchema).parse({url:`http://127.0.0.1:${port}/`,max_chars:10000,timeout_ms:1200}),{sessionId:"url-fixture"}) as ToolResult;
   const t=toolTextOf(out);
   assert.equal(out.isError,true,`超时被当成成功:${t}`);
   assert.match(t,/超过|超时|部分内容/,t);
  }finally{await new Promise<void>((r)=>server.close(()=>r()));}
 });
 // 【MC-065】Content-Length 前置**快速拒绝**:声明体量超 maxRawBytes 时,连正文都不读就拒绝。
 // 用一个真实 32 MiB 声明长度的服务,断言客户端未消费正文(服务端只见极少量写出)。
 await test("★ 声明 Content-Length 超上限时前置拒绝(不下载正文)",async()=>{
  const DECLARED=64*1024*1024; // 64 MiB > 16 MiB maxRawBytes
  let sent=0;
  const server=createServer((req,res)=>{
   res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8","Content-Length":String(DECLARED)});
   res.write("HEAD_ONLY");
   sent=8;
   // 不主动发更多,等客户端前置拒绝后断连。
  });
  await new Promise<void>((r)=>server.listen(0,"127.0.0.1",()=>r()));
  const port=(server.address() as {port:number}).port;
  try{
   const urlSpec=agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_read_url")!;
   const out=await urlSpec.handler(z.object(urlSpec.inputSchema).parse({url:`http://127.0.0.1:${port}/`,max_chars:1000,timeout_ms:8000}),{sessionId:"url-fixture"}) as ToolResult;
   const t=toolTextOf(out);
   assert.equal(out.isError,true,t);
   assert.match(t,/Content-Length|上限/,t);
   assert.ok(sent<DECLARED,`客户端仍下载了正文(${sent})`);
  }finally{await new Promise<void>((r)=>server.close(()=>r()));}
 });
 // 【MC-065】非文本策略:二进制 Content-Type 直接拒绝并指向正确工具。
 await test("★ 二进制 Content-Type 被拒绝并指向文档/图片工具",async()=>{
  const server=createServer((req,res)=>{
   res.writeHead(200,{"Content-Type":"image/png"});
   res.end(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  });
  await new Promise<void>((r)=>server.listen(0,"127.0.0.1",()=>r()));
  const port=(server.address() as {port:number}).port;
  try{
   const urlSpec=agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_read_url")!;
   const out=await urlSpec.handler(z.object(urlSpec.inputSchema).parse({url:`http://127.0.0.1:${port}/`,max_chars:1000,timeout_ms:8000}),{sessionId:"url-fixture"}) as ToolResult;
   const t=toolTextOf(out);
   assert.equal(out.isError,true,t);
   assert.match(t,/二进制|agent_read_document|agent_read_image/,t);
  }finally{await new Promise<void>((r)=>server.close(()=>r()));}
 });
 // 【MC-065】重定向次数设硬上限,不交给 undici 无界跟随。
 await test("★ 重定向次数超上限被明确拒绝",async()=>{
  const server=createServer((req,res)=>{
   res.writeHead(302,{Location:"/again"});res.end(); // 永远重定向到自身
  });
  await new Promise<void>((r)=>server.listen(0,"127.0.0.1",()=>r()));
  const port=(server.address() as {port:number}).port;
  try{
   const urlSpec=agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_read_url")!;
   const out=await urlSpec.handler(z.object(urlSpec.inputSchema).parse({url:`http://127.0.0.1:${port}/`,max_chars:1000,timeout_ms:8000}),{sessionId:"url-fixture"}) as ToolResult;
   const t=toolTextOf(out);
   assert.equal(out.isError,true,t);
   assert.match(t,/重定向次数|超过上限/,t);
  }finally{await new Promise<void>((r)=>server.close(()=>r()));}
 });
 // 【MC-065】正常跟随一次重定向仍必须成功(修复不能误伤合法重定向)。
 await test("正常的一次重定向仍读到最终正文",async()=>{
  const server=createServer((req,res)=>{
   if(req.url==="/r"){res.writeHead(302,{Location:"/final"});res.end();return;}
   res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8"});res.end("FINAL_BODY_OK");
  });
  await new Promise<void>((r)=>server.listen(0,"127.0.0.1",()=>r()));
  const port=(server.address() as {port:number}).port;
  try{
   const urlSpec=agentMcpTools({cwdFor:()=>root}).find(x=>x.name==="agent_read_url")!;
   const out=await urlSpec.handler(z.object(urlSpec.inputSchema).parse({url:`http://127.0.0.1:${port}/r`,max_chars:1000,timeout_ms:8000}),{sessionId:"url-fixture"}) as ToolResult;
   const t=toolTextOf(out);
   assert.ok(!out.isError,t);
   assert.match(t,/FINAL_BODY_OK/,t);
  }finally{await new Promise<void>((r)=>server.close(()=>r()));}
 });
 // 【MC-065】子进程输出的**输入侧**上界:huge.docx 抽取约 20 MiB,超过 MAX_CHILD_OUTPUT_BYTES
 // (16 MiB)时必须在**输出累积到界**就 killTree 并显式报错,而不是"跑完再悄悄截断成一份假完整正文"。
 await test("★ 子进程输出超预算时提前终止并明确报错(不是跑完再截断)",async()=>{
  const r=await read("huge.docx");
  assert.equal(r.isError,true,text(r));
  assert.match(text(r),/输出超过|字节上限|提前终止/,text(r));
 });
 console.log(`Document reading: ${passed} passed, ${failures.length} failed`);if(failures.length)process.exitCode=1;
}finally{
 // huge.docx 那条会把子进程提前 killTree;Windows 上被 kill 的进程可能瞬间仍占着文件,
 // 所以清理要带重试,否则测试全绿却在收尾因 EBUSY 崩掉。
 try{rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch{/* best effort */}
}
