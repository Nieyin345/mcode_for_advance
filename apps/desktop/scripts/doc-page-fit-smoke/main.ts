/**
 * 【T109】文档页面适配 —— 生成的表格有没有超出可打印区。
 *
 * ## 这一套的由来
 *
 * 2026-10-24 第一次**真的把渲染出来的 PNG 读进来看**（而不是只看 JSON），
 * 发现表格右边框贴着页面边缘。解 zip 一查：
 *
 * ```
 * <w:pgSz w:w="11906"/>                      ← A4
 * <w:pgMar w:left="1440" w:right="1440"/>    ← 可用 9026
 * <w:tblW w:w="9360"/>                       ← 表 9360
 * ```
 *
 * 根因在上游：`genoffice/packages/docx-engine/src/generate.ts:2497`
 * `const totalWidth = 9360 // 6.5in content width on US Letter` ——
 * **按 Letter 算表宽，产出 A4 页面。**
 *
 * ## 钉三件事
 *
 * | # | 断言 | 为什么值得钉 |
 * |---|---|---|
 * | 1 | A4 页面 + 9360 表 → **报超宽 334** | 这是用户真的会遇到的形态 |
 * | 2 | **同一张表**在 Letter 页面上 → **不报** | 负控：证明判据分得清超与不超，不是恒报 |
 * | 3 | **3 列的窄表也超** | 证明这是系统性的（表宽与列数无关），不是"表太宽" |
 *
 * ## 第 2 条是这一套的关键
 *
 * **没有它，第 1 条和第 3 条在「判据恒返回一条 issue」时也全绿。** 三条一起，
 * 才说得清「判据真的在量，而且量对了」。
 *
 * ## 判据是 import 来的真身
 *
 * `checkPageFit` / `checkDocxPageFit` 来自 `src/main/document/pageFitCheck.ts`。
 * **套件里不重写一份** —— 那样验的是副本（CLAUDE.md 硬规矩 26）。
 *
 * ## 不需要 Electron、不需要数据库
 *
 * 全套只读两个 `.docx` 文件的字节。数据根不参与 —— 这一层没有持久化。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkDocxPageFit, checkPageFit, readTableWidths } from "../../src/main/document/pageFitCheck.js";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

// `run.sh` 会 `cd apps/desktop`（esbuild 要在这个包里找依赖），而 `genoffice/`
// 在**仓库根** = `apps/desktop` 往上**两级**（`apps` 是一级，`mcode` 才是根）。
const APP_DIR = process.cwd();
const ROOT = resolve(APP_DIR, "../..");
const CLI = resolve(ROOT, "genoffice/packages/cli/dist/genoffice.cjs");
if (!existsSync(CLI)) {
  console.log(`  SKIP genoffice CLI 不在：${CLI}`);
  console.log("\ndoc-page-fit-smoke: 0/0（跳过）");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "mcode-doc-page-fit-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

const run = (args: string[]): void => {
  execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: "pipe" });
};

/* ── fixture：一份 6 列中文表 + 一份 3 列窄表 ─────────────────────────── */

const wideHtml = join(work, "wide.html");
writeFileSync(wideHtml, `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<h1>季度数据报告</h1>
<table border="1"><thead><tr><th>月份</th><th>收入</th><th>成本</th><th>毛利率</th><th>同比</th><th>环比</th></tr></thead>
<tbody><tr><td>2026-07</td><td>1284.50</td><td>892.30</td><td>30.53%</td><td>+12.4%</td><td>+3.1%</td></tr></tbody></table>
</body></html>`, "utf8");

const narrowHtml = join(work, "narrow.html");
writeFileSync(narrowHtml, `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<h1>窄表</h1>
<table border="1"><thead><tr><th>月份</th><th>收入</th><th>成本</th></tr></thead>
<tbody><tr><td>07</td><td>1284</td><td>892</td></tr></tbody></table>
</body></html>`, "utf8");

const wideDocx = join(work, "wide.docx");
const narrowDocx = join(work, "narrow.docx");
run(["create", "--type", "docx", "--from", wideHtml, "--out", wideDocx, "--force"]);
run(["create", "--type", "docx", "--from", narrowHtml, "--out", narrowDocx, "--force"]);

console.log("\n① 真生成的 docx：A4 页面 + 9360 表 → 超宽");
{
  check("fixture 生成成功", existsSync(wideDocx) && existsSync(narrowDocx), { wideDocx, narrowDocx });
  const issues = checkDocxPageFit(wideDocx);
  check("★ 报出了超宽", issues.length === 1, issues.length);
  check("超出 334 twips（9360 − 9026）", issues[0]?.detail.overflowTwips === 334, issues[0]?.detail);
  check("可用宽 9026（11906 − 1440 − 1440）", issues[0]?.detail.availableWidthTwips === 9026, issues[0]?.detail);
  check("规则名固定（调用方据此辨认）", issues[0]?.rule === "layout.table-overflow", issues[0]?.rule);
  check("message 里带得出数字（用户能读懂）",
    (issues[0]?.message ?? "").includes("9360") && (issues[0]?.message ?? "").includes("9026"),
    issues[0]?.message);
}

console.log("\n② ★ 负控：同一张表放到 Letter 页面上 → **不报**");
{
  // 用上游自己的 `set_page_setup` 把页面改成 Letter —— 不改表宽。
  // Letter 可用宽 = 12240 − 2880 = 9360，与 tblW 恰好相等。
  //
  // **这一条是判据的判别力所在**：没有它，①在「判据恒返回一条」时也全绿。
  const letterDocx = join(work, "letter.docx");
  const opsFile = join(work, "ops.json");
  writeFileSync(opsFile, JSON.stringify([{ op: "set_page_setup", paper: "Letter" }]), "utf8");
  run(["docs", "apply", narrowDocx, "--ops", opsFile, "--out", letterDocx, "--force"]);
  check("Letter 版生成成功", existsSync(letterDocx));
  const issues = checkDocxPageFit(letterDocx);
  check("★ Letter 页面上不报超宽（9280 恰好装下 9360？不，是 9360 装下 9360）",
    issues.length === 0, issues);

  // 对照的另一半：**同一份文件**在改页面之前是报的。
  // 两个结果只有「页面」这一个变量不同 —— 差异不能归给别的东西。
  const before = checkDocxPageFit(narrowDocx);
  check("对照：同一份文件改页面**之前**是报的", before.length === 1, before.length);
}

console.log("\n③ ★ 窄表也超 —— 证明与列数无关（系统性，不是「表太宽」）");
{
  const issues = checkDocxPageFit(narrowDocx);
  check("★ 3 列的表仍然超宽", issues.length === 1, issues.length);
  // 与 6 列那份同一个数字 —— 表宽是被写死的，不随内容变。
  const wide = checkDocxPageFit(wideDocx);
  check("★ 6 列与 3 列的表宽完全相同（9360 是常量）",
    issues[0]?.detail.tableWidthTwips === wide[0]?.detail.tableWidthTwips,
    { narrow: issues[0]?.detail.tableWidthTwips, wide: wide[0]?.detail.tableWidthTwips });
}

console.log("\n④ 判据的边界：读不到就说「不报」，不崩也不猜");
{
  check("不存在的路径 → 空（不抛）", checkDocxPageFit(join(work, "nope.docx")).length === 0);
  check("不是 zip 的文件 → 空（不抛）", checkDocxPageFit(wideHtml).length === 0);
  // 页面设置读不到时**不能**报超宽 —— 否则「不知道」被当成「有问题」。
  const noPage = checkPageFit("<w:document><w:body><w:tbl><w:tblW w:w=\"99999\"/></w:tbl></w:body></w:document>");
  check("★ 没有 pgSz 时不报（拿不到可用宽就不判）", noPage.length === 0, noPage);
  // 有页面、表恰好等于可用宽 → 不报（边界是「大于」不是「大于等于」）。
  const exact = checkPageFit(
    '<w:pgSz w:w="11906"/><w:pgMar w:left="1440" w:right="1440"/>' +
    '<w:tbl><w:tblW w:w="9026"/></w:tbl>',
  );
  check("★ 表宽恰好等于可用宽 → 不报", exact.length === 0, exact);
}

console.log("\n⑤ 多表：只报超的那些，序号按出现顺序");
{
  const xml =
    '<w:pgSz w:w="11906"/><w:pgMar w:left="1440" w:right="1440"/>' +
    '<w:tbl><w:tblW w:w="5000"/></w:tbl>' +
    '<w:tbl><w:tblW w:w="9360"/></w:tbl>';
  check("读到两张表的宽度", readTableWidths(xml).length === 2, readTableWidths(xml));
  const issues = checkPageFit(xml);
  check("只报第二张", issues.length === 1 && issues[0]?.detail.tableIndex === 2, issues.map((i) => i.detail.tableIndex));
}

console.log("\n⑥ ★ 渲染确定性 —— 这决定上面能不能用字节级判据");
{
  // 总控要的第一件事：同一份 docx 渲染两次，PNG 是否逐字节相同。
  // 如果不同（比如 PDF 引擎写时间戳），「看图」这件事就只能靠人眼，
  // 无法变成断言。**先测它，它决定所有视觉断言的形态。**
  const r1 = join(work, "r1");
  const r2 = join(work, "r2");
  run(["render", wideDocx, "--out", r1, "--scale", "2"]);
  run(["render", wideDocx, "--out", r2, "--scale", "2"]);
  const p1 = join(r1, "wide-01.png");
  const p2 = join(r2, "wide-01.png");
  if (!existsSync(p1) || !existsSync(p2)) {
    check("★ 渲染产出 PNG", false, { p1: existsSync(p1), p2: existsSync(p2) });
  } else {
    const h1 = createHash("sha256").update(readFileSync(p1)).digest("hex");
    const h2 = createHash("sha256").update(readFileSync(p2)).digest("hex");
    check("★ 同一份 docx 渲染两次 → PNG 逐字节相同", h1 === h2, { h1, h2 });
  }
}

console.log(`\ndoc-page-fit-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
