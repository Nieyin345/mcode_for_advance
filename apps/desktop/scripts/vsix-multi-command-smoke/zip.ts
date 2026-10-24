/**
 * 【F002】造测试用 VSIX（ZIP）—— 支持 STORE(0) 与 DEFLATE(8)。
 *
 * 自己造而不引包：仓库里没有 zip 库，而 `node:zlib` 的 `deflateRawSync` 就是
 * DEFLATE 主体（与 `inflateRawSync` 对称）。
 */
import { deflateRawSync } from "node:zlib";

export interface ZipEntry { name: string; data: Uint8Array; }

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const v of buf) {
    c ^= v;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return ((c ^ 0xffffffff) >>> 0);
}

function u16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
const enc = new TextEncoder();

/** 造一个 ZIP。`method` 0=STORE, 8=DEFLATE。CRC 对**原始**数据算（ZIP 规范）。 */
export function buildZip(entries: ZipEntry[], method: 0 | 8 = 0): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const body = method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    // local header (30) + name
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);  // compressed size
    lv.setUint32(22, e.data.length, true);// uncompressed size
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const lhFull = new Uint8Array(lh.length + body.length);
    lhFull.set(lh, 0);
    lhFull.set(body, lh.length);
    locals.push(lhFull);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);             // flags
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);       // local header offset
    ch.set(name, 46);
    centrals.push(ch);

    offset += lhFull.length;
  }
  const centralStart = offset;
  const centralSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);

  const out = new Uint8Array(centralStart + centralSize + 22);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}
