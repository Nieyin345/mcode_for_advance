/**
 * 【F003】VSIX 单文件限额：放宽 manifest、**不放宽 main**。
 *
 * ## 这套守的核心是一条不对称
 *
 * `package.json` 是**声明**：变大只多了命令、配置项、activationEvents，不引入新能力。
 * `extension.js` 是**可执行入口**：它一旦能进，用户就会期望它能跑，而
 * `require` 白名单里只有 `"vscode"`、53 个 `vscode.*` 成员没有一个是完整实现。
 * **放宽它等于承诺一个跑不起来的运行时** —— 装得进、列得出、一调用就崩。
 *
 * 所以：manifest 64 KiB（放），main 24 KiB（**没放**）。
 * 这套里有一条断言专门守「main 那道墙还在」，变异表第二条就是冲它去的。
 *
 * ## 另一个核心：四种拒绝必须可区分
 *
 * 改之前是两句笼统的话，其中 `Missing or oversized VSIX manifest/entry` 把
 * 「缺了 / manifest 超 / main 超」三件事混在一起 —— 那让「被哪道限制拒的」无法断言。
 * 现在四种各自可区分，这套逐条验。
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

function safeRead(zip: Uint8Array):
  { ok: true; value: { packageJson: unknown; source: string } } | { ok: false; error: string } {
  try {
    return { ok: true, value: readMinimalVsix(zip) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const PKG = { name: "demo", publisher: "acme", version: "1.0.0", main: "./extension.js" };
const pkgBytes = enc.encode(JSON.stringify(PKG));
const srcBytes = enc.encode("exports.activate = () => {};");

/** 造一个 manifest 内容恰好 `n` 字节的合法 JSON（用填充字段撑到指定长度）。 */
function manifestOfSize(n: number): Uint8Array {
  const base = { ...PKG, padding: "" };
  const withoutPad = enc.encode(JSON.stringify(base)).length;
  const pad = n - withoutPad;
  if (pad < 0) throw Error("manifestOfSize: " + n + " 太小，基准就要 " + withoutPad);
  return enc.encode(JSON.stringify({ ...PKG, padding: "x".repeat(pad) }));
}

console.log("[1] 正控：正常的 STORE / DEFLATE 包仍能读");
{
  for (const method of [0, 8] as const) {
    const zip = buildZip([
      { name: "extension/package.json", data: pkgBytes },
      { name: "extension/extension.js", data: srcBytes },
    ], method);
    const r = safeRead(zip);
    check(`★ method=${method} 读取成功`, r.ok, { error: r.ok ? undefined : r.error });
  }
}

console.log("[2] manifest 放宽到 64 KiB（本卡的核心改动）");
{
  const LIMIT = 64 * 1024;

  // 2a: 旧限额 4096 **不够** —— 造一个 4097 字节的 manifest，现在应当通过
  const over4096 = manifestOfSize(4097);
  check("★ 构造的 manifest 确实 >4096 B", over4096.length === 4097, { len: over4096.length });
  const zip4097 = buildZip([
    { name: "extension/package.json", data: over4096 },
    { name: "extension/extension.js", data: srcBytes },
  ], 8);
  const r4097 = safeRead(zip4097);
  check("★ 4097 B 的 manifest 现在能读（旧限 4096 会拒）", r4097.ok, { error: r4097.ok ? undefined : r4097.error });

  // 2b: 真实扩展的 package.json 大小（17021 B）也要能读
  const atReal = manifestOfSize(17021);
  const zipReal = buildZip([
    { name: "extension/package.json", data: atReal },
    { name: "extension/extension.js", data: srcBytes },
  ], 8);
  const rReal = safeRead(zipReal);
  check("★ 17021 B（rainbow-csv 的 package.json 实测大小）能读", rReal.ok, {
    error: rReal.ok ? undefined : rReal.error,
  });

  // 2c: 恰好在限额上通过、超一字节拒绝（边界）
  const atLimit = manifestOfSize(LIMIT);
  const zipAt = buildZip([
    { name: "extension/package.json", data: atLimit },
    { name: "extension/extension.js", data: srcBytes },
  ], 8);
  check("★ manifest == 65536 B 恰好通过（含边界）", safeRead(zipAt).ok, { len: atLimit.length });

  const overLimit = manifestOfSize(LIMIT + 1);
  // ⚠️ **必须用 STORE 造这个包。** DEFLATE 路径在**解压前**就用 `limitFor()` 卡了声明尺寸
  // （避免有人声称解压出 4 GiB 把内存撑爆），所以它根本走不到最后那道 `manifest.byteLength` 校验。
  // 第一版用 DEFLATE 造，结果变异「把限额改回 4096 / 把错误信息退回笼统一句」都验不到
  // 最终校验那一层 —— 那是**死代码**，正常路径不可达。
  // STORE 没有「声明尺寸」这一步，因此这里的校验是它唯一的一道。
  const zipOver = buildZip([
    { name: "extension/package.json", data: overLimit },
    { name: "extension/extension.js", data: srcBytes },
  ], 0 /* STORE */);
  const rOver = safeRead(zipOver);
  check("★ manifest == 65537 B（STORE 路径）被拒", !rOver.ok, { len: overLimit.length });
  check("★ 拒绝信息点名 manifest 与 65536", !rOver.ok && /manifest/.test(rOver.error) && /65536/.test(rOver.error), {
    error: rOver.ok ? undefined : rOver.error,
  });
}

console.log("[3] main 保持 24 KiB —— 本卡**没有**放宽这道墙");
{
  const LIMIT = 24 * 1024;

  // 3a: 恰好 24576 通过
  const at = enc.encode("A".repeat(LIMIT));
  const zipAt = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: at },
  ], 8);
  check("★ main == 24576 B 恰好通过（含边界）", safeRead(zipAt).ok, { len: at.length });

  // 3b: 超一字节拒绝
  const over = enc.encode("A".repeat(LIMIT + 1));
  const zipOver = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: over },
  ], 8);
  const rOver = safeRead(zipOver);
  check("★ main == 24577 B 被拒（24 KiB 这道墙还在）", !rOver.ok, { len: over.length });
  check("★ 拒绝信息点名 main 与 24576", !rOver.ok && /main entry/.test(rOver.error) && /24576/.test(rOver.error), {
    error: rOver.ok ? undefined : rOver.error,
  });

  // 3c: 真实扩展的 extension.js（136516 B）仍读不出 —— 这是有意的，不是缺陷
  const real = enc.encode("A".repeat(136516));
  const zipReal = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: real },
  ], 8);
  const rReal = safeRead(zipReal);
  check("★ 136516 B（rainbow-csv 的 extension.js 实测大小）仍被拒 —— 有意为之", !rReal.ok, {
    error: rReal.ok ? "unexpectedly accepted" : undefined,
  });
  check("★ 且拒绝理由是 main 限额（不是别的道）", !rReal.ok && /main entry/.test(rReal.error), {
    error: rReal.ok ? undefined : rReal.error,
  });
}

console.log("[4] 四种拒绝各自可区分");
{
  const err = (zip: Uint8Array): string => {
    const r = safeRead(zip);
    return r.ok ? "<accepted>" : r.error;
  };

  // 4a: 总尺寸（>128 KiB）
  const hugeZip = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: new Uint8Array(200 * 1024).fill(65) },
  ], 0);
  const eTotal = err(hugeZip);

  // 4b: manifest 超（65537 B）—— **用 STORE**，理由见 [2] 组：DEFLATE 会在解压前就卡住，
  // 走不到最后那道 `manifest.byteLength` 校验。
  const eManifest = err(buildZip([
    { name: "extension/package.json", data: manifestOfSize(65537) },
    { name: "extension/extension.js", data: srcBytes },
  ], 0));

  // 4c: main 超（24577 B）—— 同样用 STORE 覆盖最终校验
  const eMain = err(buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: enc.encode("A".repeat(24577)) },
  ], 0));

  // 4d: CRC 不符
  const crcZip = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: srcBytes },
  ], 8);
  {
    const v = new DataView(crcZip.buffer, crcZip.byteOffset, crcZip.byteLength);
    const cs = v.getUint32(crcZip.length - 22 + 16, true);
    const lc = v.getUint32(cs + 42, true);
    v.setUint32(cs + 16, 0xdeadbeef, true);
    v.setUint32(lc + 14, 0xdeadbeef, true);
  }
  const eCrc = err(crcZip);

  console.log(`      总尺寸: ${eTotal}`);
  console.log(`      manifest: ${eManifest}`);
  console.log(`      main: ${eMain}`);
  console.log(`      CRC: ${eCrc}`);

  check("★ 总尺寸那条说 size out of L1 bounds", /size out of L1 bounds/.test(eTotal), { eTotal });
  check("★ manifest 那条说 manifest + 65536", /manifest/.test(eManifest) && /65536/.test(eManifest), { eManifest });
  check("★ main 那条说 main entry + 24576", /main entry/.test(eMain) && /24576/.test(eMain), { eMain });
  check("★ CRC 那条说 CRC mismatch", /CRC mismatch/.test(eCrc), { eCrc });

  // 最关键的一条：四条消息**两两不同**。这是「可区分」的机器表达。
  const all = [eTotal, eManifest, eMain, eCrc];
  check("★ 四种拒绝的错误信息两两不同（真的可区分）", new Set(all).size === 4, { all });

  // 且每条**只**命中自己那类的关键词，不串味
  check(
    "★ manifest 那条不含 main/CRC 的字样",
    !/main entry|CRC/.test(eManifest),
    { eManifest },
  );
  check(
    "★ main 那条不含 manifest/CRC 的字样",
    !/manifest|CRC/.test(eMain),
    { eMain },
  );
}

console.log("[5] 负控：entry 数与其他限制没被顺手改掉");
{
  const three = buildZip([
    { name: "extension/package.json", data: pkgBytes },
    { name: "extension/extension.js", data: srcBytes },
    { name: "extension/readme.md", data: enc.encode("x") },
  ], 8);
  const r = safeRead(three);
  check("★ 3 个 entry 仍被拒（entry 数没放宽）", !r.ok && /two plain ZIP entries/.test(r.error), {
    error: r.ok ? undefined : r.error,
  });
}

console.log(`\nvsix-size-limits-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
