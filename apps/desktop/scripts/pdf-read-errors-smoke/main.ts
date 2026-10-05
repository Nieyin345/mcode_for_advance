import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {extractPdfText,probePdf} from "@main/library/pdfText.js";
import {state} from "./stubs/state.js";
const root=mkdtempSync(join(tmpdir(),"mcode-pdf-failures-")),file=join(root,"input.pdf");writeFileSync(file,"%PDF-fixture");let passed=0,failed=0;
async function test(name:string,fn:()=>unknown){state.fail.clear();state.cmapFail=false;state.cleanupFail=false;state.destroyed=0;state.opened=0;try{await fn();passed++;console.log("PASS "+name);}catch(e){failed++;console.error("FAIL "+name+": "+String(e));}}
try{
 await test("all page errors are failures, not scanned/empty document success",async()=>{state.fail=new Set([1,2,3]);const r=await extractPdfText(file);assert.equal(r.ok,false);assert.equal(state.destroyed,1);});
 await test("partial errors preserve text and identify failed pages",async()=>{state.fail.add(2);const r=await extractPdfText(file) as any;assert.equal(r.ok,true);assert.ok(r.text.includes("PAGE_1")&&r.text.includes("PAGE_3"));assert.deepEqual(r.failedPages,[2]);assert.equal(r.pagesRead,2);assert.equal(state.destroyed,1);});
 await test("page cap reports attempted/read counts and truncation",async()=>{const r=await extractPdfText(file,1) as any;assert.equal(r.ok,true);assert.equal(r.pageCount,3);assert.equal(r.pagesRead,1);assert.equal(r.pagesAttempted,1);assert.equal(r.truncated,true);});
 await test("missing CMap resources return classified error rather than rejecting",async()=>{state.cmapFail=true;const r=await extractPdfText(file);assert.equal(r.ok,false);assert.ok(!r.ok&&r.error.includes("CMap"));});
 await test("probe shares resource error classification",async()=>{state.cmapFail=true;const r=await probePdf(file);assert.equal(r.ok,false);});
 await test("invalid page limit does not silently produce empty success",async()=>{const r=await extractPdfText(file,0);assert.equal(r.ok,false);assert.equal(state.opened,0);});
 await test("cleanup failure does not replace a valid extraction",async()=>{state.cleanupFail=true;const r=await extractPdfText(file);assert.equal(r.ok,true);assert.equal(state.destroyed,1);});
 console.log(`PDF error contract: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
}finally{rmSync(root,{recursive:true,force:true});}
