import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { agentMcpTools } from "@main/mcp/agentTools.js";
import { __registeredDisposerCount, __registeredShutdownHookCount } from "@main/mcp/agentSessionCleanup.js";
import type { ToolResult } from "@main/mcp/sdk.js";
const root=mkdtempSync(join(tmpdir(),"mcode-doc-read-"));
const failures:string[]=[];let passed=0;
async function test(name:string,fn:()=>unknown){try{await fn();passed++;console.log("PASS "+name);}catch(e){failures.push(name+": "+String(e));console.error("FAIL "+failures.at(-1));}}
const specs=agentMcpTools({cwdFor:()=>root});const spec=specs.find(x=>x.name==="agent_read_document")!;
const read=async(path:string,args:Record<string,unknown>={})=>spec.handler(z.object(spec.inputSchema).parse({path,...args}),{sessionId:"document-fixture"});
const text=(r:ToolResult)=>r.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
function pdf(){
 const objects:string[]=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>"];
 for(let n=1;n<=3;n++){const s=`BT /F1 12 Tf 50 750 Td (PAGE_${n} ${"Paper metadata ".repeat(200)}) Tj ET`;objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 9 0 R >> >> /Contents ${2+n*2} 0 R >>`,`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);}
 objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");let body="%PDF-1.4\n";const offsets=[0];for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${o}\nendobj\n`;}
 const x=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>`${String(o).padStart(10,"0")} 00000 n \n`).join("")+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;writeFileSync(join(root,"paper.pdf"),body);
}
try {
 let py:string|undefined;for(const exe of process.platform==="win32"?["python","py","python3"]:["python3","python"]){const r=spawnSync(exe,["-X","utf8",resolve("scripts/document-read-smoke/fixtures.py"),root],{encoding:"utf8",timeout:20000});if(r.status===0){py=exe;break;}}
 assert.ok(py,"This integration suite requires the existing Python + python-pptx + openpyxl toolchain; nothing is installed automatically");pdf();
 await test("PPTX reader reads actual slides instead of slicing an unsupported collection",async()=>{const r=await read("slides.pptx",{max_slides:1});assert.ok(!r.isError,text(r));assert.ok(text(r).includes("SLIDE_1"));assert.ok(!text(r).includes("SLIDE_2"));});
 await test("PPTX reports page-limit truncation explicitly",async()=>{const r=await read("slides.pptx",{max_slides:1});assert.ok(!r.isError,text(r));assert.match(text(r),/截断|未读取/);});
 await test("PDF reader extracts real fixture text",async()=>{const r=await read("paper.pdf",{max_pages:1});assert.ok(!r.isError,text(r));assert.ok(text(r).includes("PAGE_1"));assert.ok(!text(r).includes("PAGE_2"));});
 await test("PDF reports page-limit truncation instead of presenting total pages as read",async()=>{const r=await read("paper.pdf",{max_pages:1});assert.ok(!r.isError,text(r));assert.match(text(r),/截断|未读取/);});
 for(const file of ["paper.pdf","text.docx","slides.pptx"])await test(file+" respects max_chars=100 including truncation notice",async()=>{const r=await read(file,{max_chars:100});assert.ok(!r.isError,text(r));const t=text(r);assert.ok(t.length<=100,`returned ${t.length}`);assert.match(t,/截断/);assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t),"no split surrogate");});
 await test("DOCX Unicode survives Python pipe decoding",async()=>{const r=await read("text.docx");assert.ok(!r.isError,text(r));assert.ok(text(r).includes("研究😀"),text(r).slice(0,120));});
 await test("Excel selection returns actual Unicode cells and values",async()=>{const r=await read("table.xlsx",{sheet:"Research",range:"A2:B2"});assert.ok(!r.isError,text(r));assert.match(text(r),/研究论文/);assert.match(text(r),/2026/);});
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
 console.log(`Document reading: ${passed} passed, ${failures.length} failed`);if(failures.length)process.exitCode=1;
}finally{rmSync(root,{recursive:true,force:true});}
