/**
 * 【F016】拒绝信息必须说准确：结构性事实 + 两类拒绝可机器区分。
 *
 * ## 这套守的两件事
 *
 * 1. **6 条目的包**原来只说 `"requires exactly two"` —— 用户知道「不是 2」，
 *    但不知道是 6 还是 600，也不知道本宿主支持什么。**「尺寸差一点」和
 *    「结构不支持」对他的下一步动作完全不同**：前者去找更小的版本，
 *    后者只能放弃。所以拒绝信息要带**条目数与解压后总量**。
 * 2. **两类拒绝必须能被机器区分**，不是靠人读英文句子猜。
 *    `VsixRejectError.code` 是给机器看的；`message` 是给人看的。
 *
 * ## 这套**不验**什么
 *
 * 它不验 `require` 扫描的正确性（那是启发式，见源码注释），只验
 * 「扫到就报出来」和「没扫到不许说没问题」这两条**方向**。
 */
import { readMinimalVsix, VsixRejectError } from "@main/modules/vscodeL1Bridge.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zip.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const enc = new TextEncoder();

type Rejected = { ok: false; message: string; code: string | undefined; name: string };
function safeRead(zip: Uint8Array): { ok: true } | Rejected {
  try {
    readMinimalVsix(zip);
    return { ok: true };
  } catch (e) {
    const err = e as VsixRejectError;
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(e),
      code: err instanceof VsixRejectError ? err.code : undefined,
      name: err instanceof Error ? err.name : "unknown",
    };
  }
}

const PKG = { name: "demo", publisher: "acme", version: "1.0.0", main: "./extension.js" };
const pkgBytes = enc.encode(JSON.stringify(PKG));
const srcBytes = enc.encode("exports.activate = () => {};");

function twoEntryZip(src: Uint8Array = srcBytes, method: 0 | 8 = 0): Uint8Array {
  return buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: src },
  ], method);
}

console.log("[1] 正控：正常的 2 条目包仍然能读");
{
  for (const method of [0, 8] as const) {
    const res = safeRead(twoEntryZip(srcBytes, method));
    check(`★ 方法 ${method} 的 2 条目包仍然通过（别把好包也拒了）`, res.ok, res);
  }
}

console.log("[2] 结构不支持：6 条目的包必须说清「有几个文件、多大、本宿主支持什么」");
{
  const six = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: srcBytes },
    { name: "extension/a.js", data: enc.encode("// a") },
    { name: "extension/b.js", data: enc.encode("// b") },
    { name: "extension/c.js", data: enc.encode("// c") },
    { name: "extension/d.js", data: enc.encode("// d") },
  ], 0);
  const res = safeRead(six);
  check("★ 6 条目包被拒", !res.ok, res);
  if (!res.ok) {
    console.log("       " + res.message);
    // 判据 1：说清文件数
    check("★ 错误信息里点名「6 entries」", /\b6 entries\b/.test(res.message), { message: res.message });
    // 判据 1：说清本宿主支持什么
    check("★ 错误信息里说清本宿主只收 2 个条目", /exactly 2 ZIP entries/.test(res.message), { message: res.message });
    // 判据 2：解压后总量
    check("★ 错误信息里有解压后总量（KiB）", /\d+(\.\d+)? KiB unpacked/.test(res.message), { message: res.message });
    // 判据 3：机器可区分
    check("★ 结构问题带 code=VSIX_REJECT_STRUCTURE", res.code === "VSIX_REJECT_STRUCTURE", { code: res.code });
    check("★ 它是 VsixRejectError 而不是裸 Error", res.name === "VsixRejectError", { name: res.name });
  }
}

console.log("[3] 尺寸不够 vs 结构不支持：两类必须能被机器区分");
{
  // 结构不支持：6 条目
  const structRes = safeRead(buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: srcBytes },
    { name: "extension/x.js", data: enc.encode("// x") },
  ], 0));
  // 尺寸不够：2 条目但源码超 24 KiB（STORE 保证包本身不超 128 KiB）
  const bigSrc = enc.encode("//" + "x".repeat(30 * 1024));
  const sizeRes = safeRead(twoEntryZip(bigSrc, 0));

  check("★ 两者都被拒", !structRes.ok && !sizeRes.ok, { structRes, sizeRes });
  if (!structRes.ok && !sizeRes.ok) {
    console.log("       struct: " + structRes.code);
    console.log("       size  : " + sizeRes.code);
    check("★ 结构问题 → VSIX_REJECT_STRUCTURE", structRes.code === "VSIX_REJECT_STRUCTURE", { code: structRes.code });
    check("★ 尺寸问题 → VSIX_REJECT_TOO_LARGE", sizeRes.code === "VSIX_REJECT_TOO_LARGE", { code: sizeRes.code });
    // 判据 3 的核心：机器可区分（不靠读文案）
    check("★ 两个 code 不同（这是本卡的核心判据）", structRes.code !== sizeRes.code,
      { struct: structRes.code, size: sizeRes.code });
    // 尺寸那条仍要保留可读的限额数字（既有套件按它断言）
    check("★ 尺寸那条仍点名 24576 B（既有套件依赖这个子串）", /main entry exceeds 24576 B/.test(sizeRes.message),
      { message: sizeRes.message });
  }
}

console.log("[4] 源码超限时顺带报出「本宿主不放行的 require」");
{
  // 一个 30 KiB 的源码，顶层 require 了 child_process 和一个相对路径
  const src = enc.encode(
    'const cp = require("child_process");\nconst u = require("./utils.js");\n' + "//" + "x".repeat(30 * 1024),
  );
  const res = safeRead(twoEntryZip(src, 0));
  check("★ 被拒", !res.ok, res);
  if (!res.ok) {
    console.log("       " + res.message.slice(0, 260));
    check("★ 报出 child_process", /child_process/.test(res.message), { message: res.message });
    check("★ 报出相对路径 ./utils.js", /\.\/utils\.js/.test(res.message), { message: res.message });
    check("★ 明说这是结构不匹配，不只是尺寸", /structural mismatch/.test(res.message), { message: res.message });
  }
}

console.log("[5] 负控：扫不到 require 时，不许说「没有问题」");
{
  // 代码里没有任何 require，但仍超限 → 只能说尺寸，不能说「安全」
  const plain = enc.encode("//" + "x".repeat(30 * 1024));
  const res = safeRead(twoEntryZip(plain, 0));
  check("★ 被拒", !res.ok, res);
  if (!res.ok) {
    check("★ 没有任何「It also requires」的措辞（扫不到就不说）",
      !/It also requires/.test(res.message), { message: res.message });
    check("★ 也没有「no problems / safe / 没有问题」这类假保证",
      !/no problems|is safe|\bOK\b/i.test(res.message), { message: res.message });
  }
}

console.log("[6] 解压后总量：6 条目包里它是各条目 unpacked 之和");
{
  // 每个文件 4 KiB 文本，6 个文件 → 总量应 > 24 KiB；断言它算的是**总和**而不是单个
  const chunk = enc.encode("y".repeat(4 * 1024));
  const zip = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: srcBytes },
    { name: "extension/f1.js", data: chunk },
    { name: "extension/f2.js", data: chunk },
    { name: "extension/f3.js", data: chunk },
    { name: "extension/f4.js", data: chunk },
  ], 0);
  const res = safeRead(zip);
  check("★ 被拒", !res.ok, res);
  if (!res.ok) {
    const m = /(\d+(?:\.\d+)?) KiB unpacked/.exec(res.message);
    const kib = m ? Number(m[1]) : 0;
    console.log(`       reported ${kib} KiB (4 x 4 KiB chunks + manifest + src)`);
    check("★ 报的是总和（>16 KiB），不是单个条目的大小",
      kib > 16, { kib });
  }
}

console.log("[7] 真实扩展 rainbow-csv：拒绝信息必须提到 child_process（或明说未检查）");
{
  // 判据 4 的直接验证：用真实 package.json + 真实 extension.js 造包。
  // 它 136,516 B，撞源码限额；而它顶层 require 了 child_process —— 那才是根本原因。
  const realDir = join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1");
  if (!existsSync(join(realDir, "extension.js"))) {
    // 找不到就明说「未检查」，不假装通过也不假装失败
    console.log("  skip  本机没有 rainbow-csv，这一组未执行（不是通过，也不是失败）");
  } else {
    const realPkg = new Uint8Array(readFileSync(join(realDir, "package.json")));
    const realSrc = new Uint8Array(readFileSync(join(realDir, "extension.js")));
    const res = safeRead(buildZip([
      { name: "extension/package.json", data: realPkg },
      { name: "extension/extension.js", data: realSrc },
    ], 0));
    check("★ 真实扩展被拒", !res.ok, res);
    if (!res.ok) {
      console.log("       " + res.message.slice(0, 300));
      check("★ 拒绝信息提到 child_process（或明说未检查，但不许沉默）",
        /child_process|not inspected|not checked|unchecked/i.test(res.message),
        { message: res.message });
      check("★ 真实扩展的 code 是 TOO_LARGE（它确实先撞源码限额）",
        res.code === "VSIX_REJECT_TOO_LARGE", { code: res.code });
    }
  }
}

console.log(`\nvsix-reject-reason-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
