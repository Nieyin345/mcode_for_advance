import { OutBuf, markTruncatedTail } from "@main/lib/outBuf.js";
let n = 0, failed = 0;
const check = (label: string, ok: boolean, evidence?: unknown) => {
  n++;
  console.log(`${ok ? "ok" : "FAIL"} ${label}${ok || evidence === undefined ? "" : " — " + String(evidence)}`);
  if (!ok) failed++;
};
const mutable = Buffer.from("start");
const isolated = new OutBuf(32);
isolated.push(mutable);
mutable.fill(0x58);
check("★ captured byte chunks are immutable snapshots of received output", isolated.text() === "start", isolated.text());
const backing = Buffer.alloc(8 * 1024 * 1024, 0x51);
backing.write("TRAIL", backing.length - 5);
const bounded = new OutBuf(8);
bounded.push(backing);
const chunks = (bounded as unknown as { chunks: Buffer[] }).chunks;
check("tail remains correct when input chunk is much larger than budget", bounded.text() === "QQQTRAIL", bounded.text());
check("★ bounded tail does not retain original multi-MB backing ArrayBuffer", chunks.length === 1 && chunks[0]!.buffer.byteLength <= 64 * 1024, chunks[0]?.buffer.byteLength);
check("large chunk marks truncated", bounded.truncated);
const zero = new OutBuf(0);
zero.push(Buffer.from("no-capture"));
check("★ zero-capacity tail remains empty", zero.text() === "");
check("zero-capacity reports discarded output", zero.truncated);
for (const bad of [-1, Infinity, NaN, 1.3]) {
  let refused = false;
  try { new OutBuf(bad); } catch (err) { refused = err instanceof RangeError; }
  check(`★ invalid byte budget is rejected: ${String(bad)}`, refused);
}
const chinese = new OutBuf(6);
const chineseBytes = Buffer.from("你好", "utf8");
chinese.push(chineseBytes.subarray(0, 4));
chinese.push(chineseBytes.subarray(4));
check("UTF-8 characters split across chunks remain intact", chinese.text() === "你好", chinese.text());
check("truncation marker accurately describes the byte cap", markTruncatedTail("tail", 8).includes("8 字节"));
console.log(`output-buffer-integrity-smoke:${n - failed}/${n} PASS`);
if (failed) process.exitCode = 1;
