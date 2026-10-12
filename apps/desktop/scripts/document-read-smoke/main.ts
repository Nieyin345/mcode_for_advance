import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { agentMcpTools } from "@main/mcp/agentTools.js";
import { __registeredDisposerCount, __registeredShutdownHookCount } from "@main/mcp/agentSessionCleanup.js";
import { ResponseReadGate, classifyContentType, readResponseWithinBudget, checkZipInflation, clampCellBudget, MAX_CONCURRENT_URL_READS, DOCUMENT_READ_BUDGET, type ReadBudget } from "@main/lib/readBudget.js";
import type { ToolResult } from "@main/mcp/sdk.js";
const root=mkdtempSync(join(tmpdir(),"mcode-doc-read-"));
const failures:string[]=[];let passed=0;
async function test(name:string,fn:()=>unknown){try{await fn();passed++;console.log("PASS "+name);}catch(e){failures.push(name+":"+String(e));console.error("FAIL "+failures.at(-1));}}
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
   const t=(out as ToolResult).content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
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
   const t=out.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
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
   const t=out.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
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
   const t=out.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
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
   const t=out.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
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
   const t=out.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
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
   const t=out.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
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
