/**
 * 【F002】VSIX 的 DEFLATE 读取。
 *
 * ## 这套守的是「读这一层」的四件事
 *
 * 1. **DEFLATE 能读**（市场扩展一律 method 8；只认 STORE 等于一个都进不来）；
 * 2. **STORE 没被弄坏**（正控 —— 不能为了加 DEFLATE 破坏原路径）；
 * 3. **CRC 必须验**（解压后按解压结果算）；
 * 4. **尺寸/entry 限制一点没放宽**（本卡只做读，不放宽）。
 *
 * ## 第 4 条是防止「顺手放宽」
 *
 * 放宽尺寸会让失败点从「包读不进来」变成「读进来了但 vscode API 全缺」——
 * 后者难诊断得多。所以套件里有一条**只验上限仍在**的负控，变异里也有一条
 * 「把 128 KiB 改成 16 MiB」必须让它红。
 *
 * ## 三种拒绝必须能分辨
 *
 * 解压失败 / 声明尺寸不符 / CRC 不符 —— 三种病因，三条不同的错误信息。
 * 笼统的「VSIX invalid」会让人查不到源头。
 */
import { readMinimalVsix } from "@main/modules/vscodeL1Bridge.js";
import { buildZip } from "./zip.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * ⚠️ **所有「期望成功」的读取都必须走这里。**
 *
 * 第一版直接调 `readMinimalVsix(zip)`，结果变异「只认 STORE」让它在 [2] 组抛出未捕获异常，
 * **整个套件当场终止，后面 19 条一条都没跑** —— 输出看起来像「0 条红」，
 * 而不是「红了几条 + 其余仍跑过」。这正是 CLAUDE.md 第八条形态 #7 的变体：
 * **没跑的断言和不存在的断言，在输出上分不开。**
 *
 * 包成 `{ ok, value | error }` 之后，失败会变成一条 **FAIL**，其余组继续跑。
 */
function safeRead(zip: Uint8Array): { ok: true; value: { packageJson: unknown; source: string } } | { ok: false; error: string } {
  try {
    return { ok: true, value: readMinimalVsix(zip) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const PKG = { name: "demo", publisher: "acme", version: "1.0.0", main: "./extension.js" };
const pkgBytes = enc.encode(JSON.stringify(PKG));
const srcText = "exports.activate = () => {};";
const srcBytes = enc.encode(srcText);

const pair = (): { name: string; data: Uint8Array }[] => [
  { name: "extension/package.json", data: pkgBytes },
  { name: "extension/extension.js", data: srcBytes },
];

console.log("[1] 正控：STORE（method 0）仍然能读");
{
  const zip = buildZip(pair(), 0);
  const res = safeRead(zip);
  check("★ STORE 包读取成功（未抛错）", res.ok, { error: res.ok ? undefined : res.error });
  if (res.ok) {
    check("★ STORE 包读出 package.json", JSON.stringify(res.value.packageJson) === JSON.stringify(PKG), { got: res.value.packageJson });
    check("★ STORE 包读出 extension.js", res.value.source === srcText);
  }
}

console.log("[2] DEFLATE（method 8）能读 —— 本卡的核心");
{
  const zip = buildZip(pair(), 8);
  // 先自证这个包确实是 DEFLATE：中央目录第一个 entry 的 method 字段应为 8
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const centralStart = v.getUint32(zip.length - 22 + 16, true);
  check("★ 测试包确实是 method=8（否则这套什么都没验）", v.getUint16(centralStart + 10, true) === 8, {
    method: v.getUint16(centralStart + 10, true),
  });
  const res = safeRead(zip);
  check("★ DEFLATE 包读取成功（未抛错）", res.ok, { error: res.ok ? undefined : res.error });
  if (res.ok) {
    check("★ DEFLATE 包读出 package.json", JSON.stringify(res.value.packageJson) === JSON.stringify(PKG), { got: res.value.packageJson });
    check("★ DEFLATE 包读出 extension.js", res.value.source === srcText);
  }
}

console.log("[3] 解压后内容确实被解压了（不是把原始字节当结果）");
{
  // 造一个**内容可压缩**的条目：压缩后应明显小于原始，若实现把 raw 当结果，长度就对不上
  const big = enc.encode("A".repeat(4000));
  const zip = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: big },
  ], 8);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const centralStart = v.getUint32(zip.length - 22 + 16, true);
  // ⚠️ 中央目录里**第一条是 package.json**，要跳到第二条才读得到 extension.js 的尺寸。
  // 第一条的固定头 46 字节 + 文件名长度。
  const first = centralStart;
  const second = first + 46 + v.getUint16(first + 28, true) + v.getUint16(first + 30, true) + v.getUint16(first + 32, true);
  const compressed = v.getUint32(second + 20, true);
  const unpacked = v.getUint32(second + 24, true);
  check("★ 该条目压缩后确实变小（4000 个 A 应压到很小）", compressed < unpacked / 4, { compressed, unpacked });

  const res = safeRead(zip);
  check("★ 该包读取成功（未抛错）", res.ok, { error: res.ok ? undefined : res.error });
  if (res.ok) {
    check("★ 解压出完整的 4000 字节（不是压缩后的几百字节）", res.value.source.length === 4000, { len: res.value.source.length });
    check("★ 解压内容正确", res.value.source === "A".repeat(4000));
  }
}

console.log("[4] CRC 必须验（解压后按解压结果算）");
{
  const zip = buildZip(pair(), 8);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const centralStart = v.getUint32(zip.length - 22 + 16, true);
  const local = v.getUint32(centralStart + 42, true);
  // 两处 CRC 一起改，让它们仍互相一致、但都与解压结果不符 —— 这样只拦 CRC，不拦 header mismatch
  v.setUint32(centralStart + 16, 0xdeadbeef, true);
  v.setUint32(local + 14, 0xdeadbeef, true);
  let msg = "";
  let threw = false;
  try { readMinimalVsix(zip); } catch (e) { threw = true; msg = String(e); }
  check("★ CRC 不匹配时抛错", threw, { threw });
  check("★ 错误信息说清是 CRC（不是笼统 invalid）", /CRC mismatch/.test(msg), { msg });
}

console.log("[5] 解压失败要显式（损坏的 deflate 流）");
{
  const zip = buildZip(pair(), 8);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const centralStart = v.getUint32(zip.length - 22 + 16, true);
  const local = v.getUint32(centralStart + 42, true);
  const nameLen = v.getUint16(local + 26, true);
  const dataStart = local + 30 + nameLen;
  zip[dataStart] = 0xff;
  zip[dataStart + 1] = 0xff;
  let msg = "";
  let threw = false;
  try { readMinimalVsix(zip); } catch (e) { threw = true; msg = String(e); }
  check("★ 损坏的 deflate 流抛错", threw, { threw });
  check("★ 错误信息点名是 DEFLATE 解压失败", /DEFLATE inflate failed/.test(msg), { msg });
}

console.log("[6] 声明尺寸不符要显式");
{
  const zip = buildZip(pair(), 8);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const centralStart = v.getUint32(zip.length - 22 + 16, true);
  const local = v.getUint32(centralStart + 42, true);
  // 两处 unpacked 一起改成 999，一致但与真实解压长度不符
  v.setUint32(centralStart + 24, 999, true);
  v.setUint32(local + 22, 999, true);
  let msg = "";
  let threw = false;
  try { readMinimalVsix(zip); } catch (e) { threw = true; msg = String(e); }
  check("★ 声明尺寸不符时抛错", threw, { threw });
  check("★ 错误信息说清是尺寸不符（含实际值）", /size mismatch/.test(msg) && /999/.test(msg), { msg });
}

console.log("[7] 负控：尺寸与 entry 数限制**没有**被放宽");
{
  // 7a: 3 个 entry 仍拒绝（本卡没放宽 entry 数）
  const three = buildZip([
    ...pair(),
    { name: "extension/readme.md", data: enc.encode("x") },
  ], 8);
  let threw = false;
  let msg = "";
  try { readMinimalVsix(three); } catch (e) { threw = true; msg = String(e); }
  check("★ 3 个 entry 仍被拒（entry 数没放宽）", threw && /two plain ZIP entries/.test(msg), { msg });

  // 7b: 总量超过 128 KiB 仍拒绝（本卡没放宽总尺寸）
  //
  // ⚠️ **必须验「被哪一道限制拒的」，不能只验「抛错了」**。
  // 变异 M3 把总尺寸放宽到 16 MiB 之后，这个包仍然会被**后面的
  // 24 KiB 条目限额**拒掉 —— 只验「抛错」的话断言照样绿，而放宽是真的发生了。
  // 要区分：错误信息必须是 `size out of L1 bounds`（总尺寸那道），
  // 不能是 `exceeds L1 bound` / `Missing or oversized`（条目那道）。
  const huge = new Uint8Array(200 * 1024).fill(65);
  const bigZip = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: huge },
  ], 0); // STORE 保证包本身够大
  check("★ 构造的总包确实 >128 KiB", bigZip.length > 128 * 1024, { zipLen: bigZip.length });
  const bigRes = safeRead(bigZip);
  check("★ 总包 >128 KiB 被拒绝", !bigRes.ok, { error: bigRes.ok ? "unexpectedly accepted" : bigRes.error });
  check(
    "★ 拒绝理由是「总尺寸超限」而不是条目限额（区分是哪道限制）",
    !bigRes.ok && /size out of L1 bounds/.test(bigRes.error) && !/exceeds L1 bound|Missing or oversized/.test(bigRes.error),
    { error: bigRes.ok ? undefined : bigRes.error },
  );

  // 7c: 单条目解压后超过 24 KiB 仍拒绝（main 的限额没放宽）
  //     用 DEFLATE 让包本身很小、但解压后很大 —— 这正是「放宽只会让失败更晚更难查」的场景
  const bigSrc = enc.encode("A".repeat(30 * 1024));
  const deflatedBig = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: bigSrc },
  ], 8);
  check("★ 该包本身在 128 KiB 内（说明卡的是条目限额而非总尺寸）", deflatedBig.length <= 128 * 1024, {
    zipLen: deflatedBig.length,
  });
  let threw3 = false;
  let msg3 = "";
  try { readMinimalVsix(deflatedBig); } catch (e) { threw3 = true; msg3 = String(e); }
  check("★ 解压后 >24 KiB 的 main 仍被拒（单条目限额没放宽）", threw3 && /exceeds L1 bound/.test(msg3), { msg3 });
}

console.log("[8] 负控：允许的 method 之外仍拒绝");
{
  const zip = buildZip(pair(), 8);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const centralStart = v.getUint32(zip.length - 22 + 16, true);
  const local = v.getUint32(centralStart + 42, true);
  // method 12 = bzip2，本实现不支持
  v.setUint16(centralStart + 10, 12, true);
  v.setUint16(local + 8, 12, true);
  let threw = false;
  let msg = "";
  try { readMinimalVsix(zip); } catch (e) { threw = true; msg = String(e); }
  check("★ 不支持的压缩方法仍被拒", threw && /Unsupported VSIX ZIP entry/.test(msg), { msg });
}

console.log(`\nvsix-deflate-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
