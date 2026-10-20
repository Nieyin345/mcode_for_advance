import { readResponseWithinBudget, type ReadBudget } from "@main/lib/readBudget.js";
let checks = 0, failures = 0;
function test(label: string, ok: boolean, detail?: unknown) {
  checks++;
  console.log((ok ? "  ok  " : "  FAIL ") + label + (ok ? "" : " " + JSON.stringify(detail)));
  if (!ok) failures++;
}
const budget = (bytes:number,chars:number): ReadBudget => ({maxRawBytes:1024*1024,maxDecodedBytes:bytes,maxOutputChars:chars,maxTimeMs:1000});
const stream = (chunks:Uint8Array[])=> new Response(new ReadableStream<Uint8Array>({start(c){ for(const b of chunks)c.enqueue(b); c.close(); }}));
{
  const huge = new Uint8Array(200_000).fill(65);
  const out = await readResponseWithinBudget(stream([huge]),budget(8,300_000));
  test("★ oversized single network chunk is truncated before UTF8 decode by byte cap",
    out.kind==="TRUNCATED_BY_BUDGET" && out.text.length<=8 && out.charsRead<=8,
    {kind:out.kind,chars:out.charsRead,textLength:out.text.length});
  test("huge body cannot force decoded string to exceed byte cap",out.bytesRead<=8,
    {bytes:out.bytesRead});
}
{
  const huge = new Uint8Array(180_000).fill(66);
  const out = await readResponseWithinBudget(stream([huge]),budget(500_000,7));
  test("★ oversized single network chunk is truncated before decode by char cap",
    out.kind==="TRUNCATED_BY_BUDGET" && out.charsRead<=7,
    {kind:out.kind,chars:out.charsRead});
  test("bounded response text matches explicit char cap",out.text==="B".repeat(7),{len:out.text.length});
}
{
  const utf8 = new TextEncoder().encode("ééé");
  const out = await readResponseWithinBudget(stream([utf8]),budget(3,100));
  test("★ truncated UTF8 multibyte prefix never decodes outside byte budget",
    out.kind==="TRUNCATED_BY_BUDGET" && out.text==="é" && out.bytesRead<=3,
    {text:out.text,bytes:out.bytesRead});
}
{
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const unfinished = new Response(new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(new TextEncoder().encode("five!"));}}));
  // The server may keep the connection open forever after exactly N bytes.
  // Reaching the explicit quota must cancel immediately, not await its EOF.
  const outPromise = readResponseWithinBudget(unfinished,budget(5,100));
  const outcome = await Promise.race([
    outPromise.then(out=>({kind:"done" as const,out})),
    new Promise<{kind:"timeout";out:null}>(r=>setTimeout(()=>r({kind:"timeout",out:null}),80)),
  ]);
  test("★ budget exactly consumed without EOF ends immediately",outcome.kind==="done" &&
    outcome.out?.kind==="TRUNCATED_BY_BUDGET",
    {kind:outcome.kind,value:outcome.out?.kind});
  try {controller.close();} catch {/* stream was already cancelled */ }
  await outPromise.catch(()=>{});
}
{
  const out=await readResponseWithinBudget(stream([
    new TextEncoder().encode("hello "),
    new TextEncoder().encode("world"),
  ]),budget(100,100));
  test("ordinary two-chunk UTF8 response still returns COMPLETE",out.kind==="COMPLETE" && out.text==="hello world",out);
}
console.log(`read-budget-chunk-smoke:${checks-failures}/${checks} PASS`);
if(failures)process.exitCode=1;
