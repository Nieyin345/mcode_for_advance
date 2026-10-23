/**
 * 【T73】反模式检查器**接进模型链路**了吗 —— 真跑 `documentToolCall`。
 *
 * ## 这张卡与本套件钉的不是同一件事
 *
 * T65 已经证明 `checkDeckPatterns`**算得对**（22/22）。本套件证明的是：
 * **经过真实调用路径，findings 真的到了模型手里。**
 *
 * 反面例子（本套件**刻意不**这么做）：直接 `import { checkDeckPatterns }` 调它。
 * 那样即使生产代码一行没接，断言也全绿 —— 而缺陷正是「没人调用它」。
 *
 * ## 真实路径
 *
 * `documentToolCall({tool:"build_deck", …})` → `executeCliTool` → `buildDeck`
 *   → `readDeckPatterns`（读 spec 目录、跑检查）
 *   → `createDeckFromSpec`（真 CLI 造 pptx）
 *   → `withPatternFindings`（挂到返回的 envelope.detail）
 *   → `DocumentToolCallResult.text`
 *
 * 断言读的是**最后那个 `text`** —— 模型实际拿到的那段字符串。
 *
 * ## 正负控
 *
 *  - 正控：合规 spec → 正文里是「未发现问题」，且没有 `layout.whitespace`；
 *  - 负控：内容只铺 ~68% 的 spec → 正文里出现 `layout.whitespace`；
 *  - 负控 2：没有一个页面文件 → build 失败，且**不声称**_检查通过_；
 *  - 负控 3：页文件形状不符（CLI 会丢掉它继续建）→ 正文点名「有页面文件没被检查」。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 800)}`}`);
  }
}

const REPO_ROOT = process.cwd().replace(/[\\/]apps[\\/]desktop$/, "");
const CLI = join(REPO_ROOT, "genoffice", "packages", "cli", "dist", "genoffice.cjs");

const WORK = mkdtempSync(join(tmpdir(), "t73-work-"));
process.on("exit", () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* 清理失败 */ } });
const workspace = join(WORK, "ws");
const tempRoot = join(WORK, "tmp");
mkdirSync(workspace, { recursive: true });
mkdirSync(tempRoot, { recursive: true });

const runtime = await import("../../src/main/document/documentToolRuntime.js");

const ports = {
  cliPath: CLI,
  withinWorkspace: (p: string) => {
    const n = (x: string): string => x.replace(/\\/g, "/").toLowerCase();
    return n(p).startsWith(n(workspace)) || n(p).startsWith(n(tempRoot));
  },
  rendererOpen: () => false,
  renderTempRoot: () => tempRoot,
};

/* ───────────────────── 夹具 ───────────────────── */

/** 合规页：内容铺满（元素底边接近画布底部），无细竖条、无彩虹。 */
function compliantPage(): unknown {
  return {
    title: "T73 compliant", type: "content", layout: "three_column_cards", background: "#FFFFFF",
    elements: [
      { type: "text", x: 80, y: 60, w: 1120, h: 90,
        paragraphs: [{ runs: [{ text: "T73 COMPLIANT", sizePt: 40, color: "#0E1A2B" }] }] },
      { type: "text", x: 80, y: 200, w: 1120, h: 460,
        paragraphs: [{ runs: [{ text: "body that fills the canvas down to the bottom", sizePt: 20, color: "#0E1A2B" }] }] },
    ],
  };
}

/** 空页：内容只铺到 ~55%，卡片下半截空着（T62 实测的那种丑法）。 */
function sparsePage(): unknown {
  return {
    title: "T73 sparse", type: "content", layout: "three_column_cards", background: "#FFFFFF",
    elements: [
      { type: "text", x: 80, y: 60, w: 1120, h: 90,
        paragraphs: [{ runs: [{ text: "T73 SPARSE", sizePt: 40, color: "#0E1A2B" }] }] },
      // 底边 = 60 + 90 + 340 = 490 → 490/720 = 68%，低于 content 的参考线
      { type: "text", x: 80, y: 200, w: 1120, h: 290,
        paragraphs: [{ runs: [{ text: "short body", sizePt: 20, color: "#0E1A2B" }] }] },
    ],
  };
}

function makeSpec(name: string, page: unknown): string {
  const dir = join(workspace, name);
  mkdirSync(join(dir, "pages"), { recursive: true });
  writeFileSync(join(dir, "pages", "01.json"), JSON.stringify(page), "utf8");
  return dir;
}

async function build(name: string, specDir: string): Promise<{ ok: boolean; route?: string; text: string; reason?: string }> {
  const outPptx = join(workspace, `${name}.pptx`);
  const r = await runtime.documentToolCall(ports as never, {
    tool: "build_deck", app: "slides", filePath: outPptx, input: { specDir },
  });
  const text = r.ok ? r.text : "";
  return { ok: r.ok, ...(r.ok ? { route: r.route } : { reason: (r as { reason?: string }).reason }), text };
}

/**
 * ⚠️ **断言必须读「模型实际看到的正文」，不能读 envelope 里的 JSON。**
 *
 * 第一版这里写的是解析 JSON 字段（`"patternChecked": true`），结果全红 ——
 * `documentToolCall` 交给模型的是 `envelopeText()` **渲染后的几行**，不是 JSON。
 * 这次失败本身就复现了本卡的缺陷：**挂到 `detail` 上 ≠ 模型看得到**，
 * 必须进正文才算数。
 */
const sawCheckRan = (text: string): boolean =>
  text.includes("反模式检查发现") || text.includes("反模式检查未发现问题") || text.includes("反模式检查**没有执行**");
const sawNoFindings = (text: string): boolean => text.includes("反模式检查未发现问题");
const sawNotRun = (text: string): boolean => text.includes("反模式检查**没有执行**");

/* ───────────────────── 1. 负控：空页必须报出来 ───────────────────── */

console.log("\n1. 负控：内容只铺 ~68% 的 spec —— 模型必须看到 layout.whitespace");
{
  const specDir = makeSpec("sparse", sparsePage());
  const r = await build("sparse", specDir);
  check("build_deck 仍然成功（findings 是附加信息，不是新的拒绝条件）", r.ok === true, r);
  console.log(`     text 长度=${r.text.length}`);
  // ⚠️ 这条**故意**在三种情况都绿：「发现问题」「未发现问题」「没有执行」。
  // 它验的是「正文里有一条关于检查的结论」（不静默），不是「检查跑了」——
  // 后者由下面的 layout.whitespace / 「未发现问题」两条断言分工证明。
  // （第一版名字写成「证明检查真的跑了」，变异时它对着「没有执行」仍然绿 —— 名不副实。）
  check("★ 正文里有一条关于反模式检查的结论（不静默）", sawCheckRan(r.text), { sample: r.text.slice(0, 400) });
  check("★ 返回里出现 layout.whitespace",
    r.text.includes("layout.whitespace"), { sample: r.text.slice(0, 600) });
  check("★ 正文里点名了 finding 的数量与等级",
    /发现 \d+ 个 error \/ \d+ 个 warning/.test(r.text), { sample: r.text.slice(0, 400) });
  check("★ 给了可执行的提示（改 pages/NN.json 后重建）",
    r.text.includes("pages/NN.json") || r.text.includes("slides replace"), { sample: r.text.slice(0, 500) });
}

/* ───────────────────── 2. 正控：合规页不报 ───────────────────── */

console.log("\n2. 正控：合规页 —— 检查跑了、但没有 whitespace finding");
{
  const specDir = makeSpec("compliant", compliantPage());
  const r = await build("compliant", specDir);
  check("build_deck 成功", r.ok === true, r);
  check("★ 正文里有「未发现问题」", sawNoFindings(r.text), { sample: r.text.slice(0, 400) });
  check("★ 没有 layout.whitespace",
    !r.text.includes("layout.whitespace"), { sample: r.text.slice(0, 400) });
  check("★ 也没有误报「检查没有执行」", !sawNotRun(r.text));
}

/* ───────────────────── 3. 失败要显式：读不到页面不许当作通过 ───────────────────── */

console.log("\n3. 负控：没有一个页面文件 —— 必须明说「没有执行」");
{
  // 空页面目录：存在但没有 .json。build 自己会失败（CLI: no page files），
  // 重点是**不能**声称检查通过 —— 失败路径上 `withPatternFindings` 原样返回，
  // 所以这里验的是「失败原因里不含任何『检查通过』的措辞」。
  const empty = join(workspace, "empty-pages");
  mkdirSync(join(empty, "pages"), { recursive: true });
  const outPptx = join(workspace, "empty.pptx");
  const r = await runtime.documentToolCall(ports as never, {
    tool: "build_deck", app: "slides", filePath: outPptx, input: { specDir: empty },
  });
  const text = r.ok ? r.text : (r as { reason?: string }).reason ?? "";
  check("没有页面文件时 build 失败", r.ok === false, { text: text.slice(0, 300) });
  check("且不会声称「检查通过」", !sawNoFindings(text), { text: text.slice(0, 300) });
}

/* ───────────────────── 4. 页文件被跳过时要显式说出来 ───────────────────── */

console.log("\n4. 页文件形状不符 —— CLI 会丢掉它继续建；检查侧必须说「这页没被查」");
{
  // 一个合法页 + 一个形状不符的页文件。CLI 的 `parseDeckSpec` 只在**一页都不剩**
  // 时才报错，所以这份 spec 仍然能 build 出 1 页 —— 但第 2 个文件从没被检查过。
  const mixed = join(workspace, "mixed");
  mkdirSync(join(mixed, "pages"), { recursive: true });
  writeFileSync(join(mixed, "pages", "01.json"), JSON.stringify(sparsePage()), "utf8");
  writeFileSync(join(mixed, "pages", "02.json"), JSON.stringify({ not: "a page" }), "utf8");
  const r = await build("mixed", mixed);
  check("形状不符的页不影响 build 成功（与 CLI 一致）", r.ok === true, r);
  check("★ 检查整体没执行（页序不可信，不许给错位页号的 finding）", sawNotRun(r.text), { sample: r.text.slice(0, 700) });
  check("★ 点名了是哪个文件", r.text.includes("02.json"), { sample: r.text.slice(0, 800) });
}

/* ───────────────────── 5. 页号不许错位 ───────────────────── */

console.log("\n5. 两个页文件、坏页在第二个 —— finding 必须说「第 2 页」");
{
  const two = join(workspace, "two");
  mkdirSync(join(two, "pages"), { recursive: true });
  // 数字序：01 合规、02 空页。若按字典序或从 0 起的文件下标算，就会报成第 1 页。
  writeFileSync(join(two, "pages", "01.json"), JSON.stringify(compliantPage()), "utf8");
  writeFileSync(join(two, "pages", "02.json"), JSON.stringify(sparsePage()), "utf8");
  const r = await build("two", two);
  check("两页 build 成功", r.ok === true, r);
  check("★ 报出把 whitespace", r.text.includes("layout.whitespace"), { sample: r.text.slice(0, 600) });
  check("★ 而且是「第 2 页」，不是第 1 页",
    r.text.includes("第 2 页"), { sample: r.text.slice(0, 600) });
  check("★ 没有把合规的第 1 页误报成 whitespace",
    !/layout\.whitespace · 第 1 页/.test(r.text), { sample: r.text.slice(0, 600) });
}

/* ───────────────────── 6. 文件名排序是数字序 ───────────────────── */

console.log("\n6. 不补零的页名（1 / 2 / 10）—— 字典序会把 10 排到 2 前面");
{
  const many = join(workspace, "many");
  mkdirSync(join(many, "pages"), { recursive: true });
  // ⚠️ 必须**不补零**：`01/02/…/10` 在字典序下也恰好有序，那样这条断言分不出
  // 「数字序」和「字典序」（T73 第一版就是这个错，10 页全绿却什么都没验）。
  // 不补零时：字典序 = 1, 10, 2（坏页成第 3 页）；数字序 = 1, 2, 10（第 2 页）。
  writeFileSync(join(many, "pages", "1.json"), JSON.stringify(compliantPage()), "utf8");
  writeFileSync(join(many, "pages", "2.json"), JSON.stringify(sparsePage()), "utf8");
  for (let i = 3; i <= 10; i++) {
    writeFileSync(join(many, "pages", `${i}.json`), JSON.stringify(compliantPage()), "utf8");
  }
  const r = await build("many", many);
  check("10 页 build 成功", r.ok === true, r);
  check("★ 坏页仍报「第 2 页」（数字序生效，字典序会是第 3 页）",
    r.text.includes("第 2 页"), { sample: r.text.slice(0, 600) });
  check("★ 并且没有报成「第 3 页」", !r.text.includes("第 3 页"), { sample: r.text.slice(0, 600) });
}

/* ───────────────────── 7. `type` 透传：closing 页走 55% 而不是 80% ───────────────────── */

console.log("\n7. ★ `type` 透传正控：同一份内容，标成 closing 就不该按 content 的 80% 判");
{
  // 底边 490/720 = 68%：
  //   content → 参考线 80% → **报**
  //   closing → 参考线 55% → **不报**
  // 如果转换层丢了 `type`（比如只挑 elements 重建对象），两页会报一样的结论 ——
  // 而 build 照样成功、页号照样对，套件全绿也发现不了。这就是「接上了但不工作」。
  const contentSpec = makeSpec("type-content", { ...(sparsePage() as object), type: "content" });
  const closingSpec = makeSpec("type-closing", { ...(sparsePage() as object), type: "closing" });
  const asContent = await build("type-content", contentSpec);
  const asClosing = await build("type-closing", closingSpec);
  check("content 页（68% < 80%）→ 报 layout.whitespace",
    asContent.ok && asContent.text.includes("layout.whitespace"), { sample: asContent.text.slice(0, 500) });
  check("★ closing 页（68% > 55%）→ 不报（证明 `type` 真的透传到了判据）",
    asClosing.ok && !asClosing.text.includes("layout.whitespace"), { sample: asClosing.text.slice(0, 500) });
}

/* ───────────────────── 8. 页文件名代替页号 ───────────────────── */

console.log("\n8. ★ finding 的位置给的是文件名，不是要换算的页号");
{
  const specDir = makeSpec("named", sparsePage());
  const r = await build("named", specDir);
  check("★ 正文里出现 pages/01.json", r.text.includes("pages/01.json"), { sample: r.text.slice(0, 600) });
  check("★ 不再只给「第 1 页」让模型自己换算", !/· 第 1 页：/.test(r.text), { sample: r.text.slice(0, 600) });
}

/* ───────────────────── 9. 坏 JSON → 整体 fail-closed ───────────────────── */

console.log("\n9. ★ 负控：一个页文件写坏 → 整次检查不执行（页序不可信）");
{
  const broken = join(workspace, "broken");
  mkdirSync(join(broken, "pages"), { recursive: true });
  // 01 合规、02 写了一半、03 有真缺陷。若跳过 02，03 的索引会变成 1，
  // 报成「第 2 页」→ 模型去改 02.json（正是那个坏文件），改完还是解析不了。
  writeFileSync(join(broken, "pages", "01.json"), JSON.stringify(compliantPage()), "utf8");
  writeFileSync(join(broken, "pages", "02.json"), '{"elements": [', "utf8");
  writeFileSync(join(broken, "pages", "03.json"), JSON.stringify(sparsePage()), "utf8");
  const r = await build("broken", broken);
  // ⚠️ **实测纠正了一条原假设**：坏 JSON 会让 CLI **自己就拒绝 build**
  // （`02.json: invalid JSON (Unexpected end of JSON input)`），根本走不到我们这层。
  // 所以这条负控真正能验的是：**即使 build 失败，也绝不出现一条页号可能错位的
  // finding** —— 而 `withPatternFindings` 对失败结果原样返回，正好保证这一点。
  const text = r.ok ? r.text : (r.reason ?? "");
  check("build 被 CLI 拒绝（坏 JSON 轮不到我们判）", r.ok === false, { reason: r.reason });
  check("★ 失败原因里点名了坏掉的文件", text.includes("02.json"), { sample: text.slice(0, 400) });
  check("★ 一条 finding 都没有（第 3 页的缺陷不该以错位的页号出现）",
    !text.includes("layout.whitespace"), { sample: text.slice(0, 400) });
  check("★ 也没有谎称「检查通过」", !sawNoFindings(text), { sample: text.slice(0, 400) });
}

/* ───────────────────── 9b. 形状不符（能 build）→ 整体 fail-closed ───────────────────── */

console.log("\n9b. ★ 形状不符的页文件（CLI 会丢掉它继续建）→ 我们的检查必须整体停");
{
  // 与第 4 节同一份夹具，但验的是**这里的**语义：形状不符会让页号错位，
  // 所以不许给 finding，只许说「整体未执行」。
  const mixed = join(workspace, "mixed2");
  mkdirSync(join(mixed, "pages"), { recursive: true });
  writeFileSync(join(mixed, "pages", "01.json"), JSON.stringify(compliantPage()), "utf8");
  writeFileSync(join(mixed, "pages", "02.json"), JSON.stringify({ not: "a page" }), "utf8");
  writeFileSync(join(mixed, "pages", "03.json"), JSON.stringify(sparsePage()), "utf8");
  const r = await build("mixed2", mixed);
  check("build 成功（CLI 丢掉坏页继续建）", r.ok === true, r);
  check("★ 检查整体未执行", sawNotRun(r.text), { sample: r.text.slice(0, 700) });
  check("★ 第 3 页的缺陷没有以「第 2 页」的身份出现",
    !/layout\.whitespace · 第 2 页|layout\.whitespace · pages\/02\.json/.test(r.text), { sample: r.text.slice(0, 700) });
}

/* ───────────────────── 10. 跨页判据说「整份」不说「第 1 页」 ───────────────────── */

console.log("\n10. ★ header.bar / layout.repeated 是「全篇」问题，位置必须渲染成「整份」");
{
  // 三页同构 + 每页同位置一条扁条 → 两条跨页判据都命中。
  const bar = (i: number): unknown => ({
    title: `P${i}`, type: "content", layout: "three_column_cards", background: "#FFFFFF",
    elements: [
      // 全篇同一位置的扁 rect（h<80，非满版）→ header.bar
      { type: "shape", shape: "rect", x: 0, y: 0, w: 1280, h: 56, fill: "#123456" },
      { type: "text", x: 80, y: 600, w: 1120, h: 100,
        paragraphs: [{ runs: [{ text: `page ${i}`, sizePt: 20, color: "#0E1A2B" }] }] },
    ],
  });
  const same = join(workspace, "same");
  mkdirSync(join(same, "pages"), { recursive: true });
  for (let i = 1; i <= 3; i++) writeFileSync(join(same, "pages", `0${i}.json`), JSON.stringify(bar(i)), "utf8");
  const r = await build("same", same);
  check("三页同构 build 成功", r.ok === true, r);
  check("报出了 header.bar", r.text.includes("header.bar"), { sample: r.text.slice(0, 700) });
  check("★ header.bar 的位置是「整份」，不是「第 1 页」",
    /header\.bar · 整份/.test(r.text), { sample: r.text.slice(0, 700) });
  check("★ message 里列出了具体页号（1、2、3）",
    /第 1、2、3 页|第 1–3 页/.test(r.text), { sample: r.text.slice(0, 700) });
}

console.log(`\nt73-pattern-wiring-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
