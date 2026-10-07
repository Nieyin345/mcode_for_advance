/**
 * `browserPure.ts`(从 `BrowserManager` 抽出的无头纯函数)的回归网。
 *
 * ## 为什么单开一套
 *
 * `BrowserManager.ts` 顶层 `import ... from "electron"`,任何 import 它的无头脚本都起不来
 * —— 所以里面这几个**不碰 Electron** 的真逻辑从前**一套测试都没有**(C1)。抽出来之后
 * 直接 import 即可断言。
 *
 * 判据立在**用户看到的行为**上:
 *   - 模型给的 `Control+Shift+Enter` 到底按出了什么键(组合键解析 + 键名映射);
 *   - 被 Cloudflare/Google 登录挡不挡,取决于抽出来的 UA 是不是"普通 Chrome";
 *   - 两个同名下载会不会互相覆盖(落嗓去重 + 文件名清洗)。
 *
 * `uniqueDownloadPath` 的主干(磁盘去重 / 并发预留 / 组合)由 `maint-m11-smoke` 用 AST 提取法
 * 覆盖;这里补它**没测**的那半:**文件名里的非法字符要清洗**(否则 `join` 出来是个坏路径)。
 *
 * Run: scripts/browser-pure-smoke/run.sh
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  urlOrigin,
  chromeLikeUserAgent,
  normalizeKeyName,
  parseKeyCombo,
  uniqueDownloadPath,
  isMobileUa,
  withTimeout,
} from "@main/browser/browserPure.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function deepEq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ─────────────────────── normalizeKeyName ─────────────────────── */
console.log("\nnormalizeKeyName(模型给的键名 → sendInputEvent 的键码)");
{
  // KeyboardEvent.key 风格与 accelerator 风格**都要认**(注释明说)。
  eq("Enter → Enter", normalizeKeyName("enter"), "Enter");
  eq("Return 也认(两种写法同一件事)", normalizeKeyName("return"), "Enter");
  eq("ArrowUp → Up", normalizeKeyName("ArrowUp"), "Up");
  eq("Up 也认", normalizeKeyName("up"), "Up");
  eq("Escape → Esc", normalizeKeyName("escape"), "Esc");
  eq("Delete → Del(Electron 的键码是 Del 不是 Delete)", normalizeKeyName("delete"), "Del");
  eq("Space → Space", normalizeKeyName("space"), "Space");
  eq("spacebar 也认", normalizeKeyName("spacebar"), "Space");
  eq("裸空格 → null(先 trim,空白被当空串)", normalizeKeyName(" "), null);
  eq("F12 → F12", normalizeKeyName("f12"), "F12");
  eq("F1 → F1", normalizeKeyName("F1"), "F1");
  // 单字符:小写透传(shift 由组合键显式带)。
  eq("单字符 A → a", normalizeKeyName("A"), "a");
  // 边界:空 / 认不出 → null。
  eq("空串 → null", normalizeKeyName(""), null);
  eq("纯空白 → null", normalizeKeyName("   "), null);
  eq("认不出的名字 → null", normalizeKeyName("NoSuchKey"), null);
  eq("F25 超界 → null(只到 F24)", normalizeKeyName("f25"), null);
  eq("多字符非名字 → null", normalizeKeyName("ab"), null);
}

/* ─────────────────────── parseKeyCombo ─────────────────────── */
console.log("\nparseKeyCombo(组合键 → modifiers + key)");
{
  // CmdOrCtrl 的平台分支:非 darwin → control(darwin 分支由平台决定,这里跑在本机平台)。
  const expectedCmdOrCtrl = process.platform === "darwin" ? "meta" : "control";
  deepEq("Control+Shift+Enter → [control, shift] + Enter", parseKeyCombo("Control+Shift+Enter"), {
    modifiers: ["control", "shift"],
    key: "Enter",
  });
  const coc = parseKeyCombo("CmdOrCtrl+K");
  check("CmdOrCtrl 落在当前平台的约定档", JSON.stringify(coc) === JSON.stringify({ modifiers: [expectedCmdOrCtrl], key: "k" }), coc);
  deepEq("Ctrl 与 Control 同义", parseKeyCombo("ctrl+a"), { modifiers: ["control"], key: "a" });
  deepEq("Cmd/cmd/Command 都映射 meta", parseKeyCombo("Cmd+b"), { modifiers: ["meta"], key: "b" });
  deepEq("Option 映射 alt", parseKeyCombo("Option+x"), { modifiers: ["alt"], key: "x" });
  deepEq("无修饰键也可以(裸主键)", parseKeyCombo("Enter"), { modifiers: [], key: "Enter" });
  // ★ 错误路径:每一条都该给**人话**,而不是静默一个非法组合。
  check("空组合 → 报错(不是空 modifiers)", "error" in parseKeyCombo(""), parseKeyCombo(""));
  check("缺主键 → 报错(只说 modifiers 不算组合)", "error" in parseKeyCombo("Control+Shift"), parseKeyCombo("Control+Shift"));
  check("两个主键 → 报错", "error" in parseKeyCombo("a+b"), parseKeyCombo("a+b"));
  check("认不出的键 → 报错", "error" in parseKeyCombo("Control+Nope"), parseKeyCombo("Control+Nope"));
}

/* ─────────────────────── chromeLikeUserAgent ─────────────────────── */
console.log("\nchromeLikeUserAgent(剥掉 Electron/应用尾串 → 普通 Chrome)");
{
  // 真实形状:Electron 在 **Safari 标记之后**追加 `AppName/ver Electron/ver`(见实现注释)。
  const real = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 mcode/1.0.0 Electron/33.0.0";
  const cleaned = chromeLikeUserAgent(real);
  eq("★ 剥到 Safari 标记为止", cleaned, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  check("★ Electron 尾巴被剥掉", !cleaned.includes("Electron"), cleaned);
  check("★ 应用名也被剥掉", !cleaned.includes("mcode/"), cleaned);
  check("真实 Chrome 版本号保留(genuine)", cleaned.includes("Chrome/124.0.0.0"), cleaned);
  // 没有 Safari 标记时退回:删掉末尾的 `AppName/ver Electron/ver`。
  eq("无 Safari 标记 → 删尾串", chromeLikeUserAgent("SomeAgent/1.0 Electron/33.0.0"), "");
  // 已经不带的原样返回(没有 Electron 尾 = 没什么可剥)。
  eq("本来就是干净 UA → 原样", chromeLikeUserAgent("Mozilla/5.0 Safari/537.36"), "Mozilla/5.0 Safari/537.36");
}

/* ─────────────────────── urlOrigin ─────────────────────── */
console.log("\nurlOrigin(取 origin,坏 URL 不抛)");
{
  eq("https 取 origin", urlOrigin("https://example.com/a/b?c=1"), "https://example.com");
  eq("带端口", urlOrigin("http://127.0.0.1:3000/x"), "http://127.0.0.1:3000");
  eq("坏 URL → 空串(不抛)", urlOrigin("not a url"), "");
  eq("空串 → 空串", urlOrigin(""), "");
}

/* ─────────────────────── isMobileUa ─────────────────────── */
console.log("\nisMobileUa(设备档 → 是否用移动版 UA)");
{
  eq("desktop → 不是", isMobileUa("desktop", 1440), false);
  eq("现成移动档 → 是", isMobileUa("iphone", 393), true);
  eq("android 档 → 是", isMobileUa("android", 412), true);
  eq("custom 且窄 → 是", isMobileUa("custom", 800), true);
  eq("custom 且宽(>1024)→ 不是", isMobileUa("custom", 1440), false);
  eq("custom 正好 1024 → 是(边界 <=)", isMobileUa("custom", 1024), true);
}

/* ─────────────────────── withTimeout ─────────────────────── */
console.log("\nwithTimeout(超时保护,正常/超时/拒绝三条路)");
{
  const fast = await withTimeout(Promise.resolve("done"), 1000, "不该超时");
  eq("按时完成 → 拿回值", fast, "done");
  let timedOut = false;
  try {
    await withTimeout(new Promise((r) => setTimeout(r, 200)), 20, "超时了");
  } catch (err) {
    timedOut = true;
    eq("超时 → 抛的是给的那句", (err as Error).message, "超时了");
  }
  check("★ 慢 promise 会被超时挡下", timedOut, timedOut);
  let propagated = false;
  try {
    await withTimeout(Promise.reject(new Error("内部炸了")), 1000, "不该走到这里");
  } catch (err) {
    propagated = true;
    eq("★ 内部拒绝原样透传(不是被超时那句话吞掉)", (err as Error).message, "内部炸了");
  }
  check("内部拒绝确实传出来了", propagated, propagated);
}

/* ─────────────────────── uniqueDownloadPath(补:文件名清洗) ─────────────────────── */
console.log("\nuniqueDownloadPath(文件名里的非法字符要清洗)");
{
  const dir = mkdtempSync(join(tmpdir(), "mcode-browser-pure-"));
  try {
    // 路径分隔符 / 通配符等若不清洗,join 出来就是个坏路径(或跨目录写)。
    const p = uniqueDownloadPath(dir, "a/b:c*d?e.pdf");
    check("★ 非法字符被换成下划线", p === join(dir, "a_b_c_d_e.pdf"), p);
    check("★ 落点在给定目录里(没被路径分隔符带出去)", p.startsWith(dir + (process.platform === "win32" ? "\\" : "/")), p);
    // 纯非法/空白 → 回落到 "download"。
    const q = uniqueDownloadPath(dir, "   ");
    check("全空白 → 回落成 download", q === join(dir, "download"), q);
    // 磁盘上已存在 → 加 -1(与 maint-m11 同口径,这里补个正控)。
    writeFileSync(join(dir, "x.pdf"), "y");
    eq("已存在 → -1", uniqueDownloadPath(dir, "x.pdf"), join(dir, "x-1.pdf"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nbrowser-pure-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
