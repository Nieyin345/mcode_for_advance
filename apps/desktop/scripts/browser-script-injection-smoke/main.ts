/**
 * 页内注入脚本的**槽位填充**回归 —— `main/browser/snapshotScript.ts`。
 *
 * ## 它治的是哪一类 bug
 *
 * 这个文件把十个 IIFE 写成字符串常量,每个留 `%XXX_JSON%` 槽,`build*Script()` 往里填
 * `JSON.stringify(JSON.stringify(value))`。文件头自称「quotes / backslashes / newlines
 * … can never break out of the script syntax」。
 *
 * 但填槽用的是 **`String.prototype.replace(pattern, string)`** —— 替换**串**里的
 * `$$` / `` $` `` / `$&` / `$'` 会被当成替换**模式**解释,于是模型给的值会被改写:
 *
 *   - `browser_evaluate` 传 `` `Total: $${cost}` ``(模板字面量里转义一个字面 `$`)
 *     → 页面真正执行的代码变成 `` `Total: ${cost}` ``,**语义被静默改掉**;
 *   - 选择器/文本里含 `` $` `` → 页面侧 `SyntaxError`;
 *   - 含 `$&` → 占位符原文被串进去。
 *
 * 修法:替换第二参用**函数** `() => json`(函数不会被解释成模式)。
 *
 * ## 判据立在哪
 *
 * 立在**模型给的东西有没有原样到达页面**上:含 `$` 序列的输入走一遍 `build*Script`,
 * 生成的脚本文本里必须**逐字含** `JSON.stringify(JSON.stringify(value))` 这个 JS 字符串
 * 字面量。填槽一旦被 `$` 模式改写,那个字面量就不会完整出现 —— 判据不依赖实现对错,
 * 只问"该在的东西在不在"。
 *
 * 这个文件**零 import、纯字符串**,所以本套不需要任何桩、不碰数据根、不起 Electron。
 *
 * Run: scripts/browser-script-injection-smoke/run.sh
 */
import {
  buildClickScript,
  buildEvaluateScript,
  buildTypeScript,
  buildSelectScript,
  buildFindScript,
  buildScrollScript,
  buildWaitScript,
  buildCheckFileInputScript,
  buildElementCenterScript,
  fillSlot,
} from "../../src/main/browser/snapshotScript.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** 值在该是的样子:两层 stringify 后的 JS 字符串字面量。 */
const lit = (v: unknown): string => JSON.stringify(JSON.stringify(v));

/* ── 0. 槽位填充本身:替换函数不吃 `$` 序列 ── */

console.log("\n槽位填充");

{
  check(
    "★ fillSlot:$$ 不被当成替换模式(字面 $ 保得住)",
    fillSlot("X%S%Y", "%S%", '"$${cost}"') === 'X"$${cost}"Y',
    fillSlot("X%S%Y", "%S%", '"$${cost}"'),
  );
  check(
    "★ fillSlot:$& 不被替换成占位符原文",
    fillSlot("X%S%Y", "%S%", '"$&"') === 'X"$&"Y',
    fillSlot("X%S%Y", "%S%", '"$&"'),
  );
  check(
    "fillSlot:`$` 不被替换成前文",
    fillSlot("X%S%Y", "%S%", '"$`"') === 'X"$`"Y',
    fillSlot("X%S%Y", "%S%", '"$`"'),
  );
}

/* ── 1. 每个 builder:模型给的值原样到页面 ── */

console.log("\nbuilder 的值原样进页面");

// 含全部四种 `$` 序列 + 中文 + 引号 + 反斜杠 —— 一网打尽。
const NASTY = 'a"b\\c$${x}$&$`$\'中';

{
  const single: Array<[string, string]> = [
    ["browser_click.selector", buildClickScript(NASTY)],
    ["browser_checkFileInput.selector", buildCheckFileInputScript(NASTY)],
    ["browser_evaluate.code", buildEvaluateScript(NASTY)],
    ["browser_elementCenter.selector", buildElementCenterScript(NASTY)],
  ];
  for (const [label, script] of single) {
    check(`★ ${label} 原样到达(含 $ 序列/引号/反斜杠)`, script.includes(lit(NASTY)), {
      want: lit(NASTY),
      gotStart: script.slice(0, 160),
    });
  }
}

{
  const script = buildTypeScript(NASTY, NASTY, true);
  check("★ browser_type.selector 原样到达", script.includes(lit(NASTY)), script.slice(0, 160));
  check("★ browser_type.text 原样到达", script.includes(lit(NASTY)), script.slice(0, 160));
}

{
  const nasty = 'v$$&$`$\'中';
  const script = buildSelectScript("body", nasty);
  check("★ browser_select.value 原样到达", script.includes(lit(nasty)), script.slice(0, 200));
}

console.log("\n复杂参数(builder 拼的 object)");

{
  const arg = { text: "he$$llo", selector: "p$a&b" };
  const script = buildFindScript(arg);
  check("★ browser_find 的整份参数原样到达(text/selector 的 $ 序列都在)", script.includes(lit(arg)), script.slice(0, 220));
  check("★ browser_find 没有占位符原文残留", !script.includes("%ARG_JSON%"));
}

{
  const arg = { selector: "div$x&y", dir: "down", pages: 2 };
  const script = buildScrollScript({ selector: "div$x&y", direction: "down", pages: 2 });
  check("★ browser_scroll 的参数原样到达", script.includes(lit(arg)), script.slice(0, 220));
  check("★ browser_scroll 没有占位符原文残留", !script.includes("%ARG_JSON%"));
}

{
  const arg = { selector: undefined, text: "wait$$here" };
  const script = buildWaitScript({ text: "wait$$here" });
  check("★ browser_wait 的参数原样到达", script.includes(lit(arg)), script.slice(0, 220));
}

/* ── 2. 没有槽被漏填(占位符不该留在生成的脚本里)── */

console.log("\n没有占位符残留");

{
  const all: Array<[string, string]> = [
    ["click", buildClickScript("a")],
    ["evaluate", buildEvaluateScript("1")],
    ["type", buildTypeScript("a", "b", true)],
    ["select", buildSelectScript("a", "b")],
    ["find", buildFindScript({ text: "x" })],
    ["scroll", buildScrollScript({ selector: "a", direction: "up", pages: 1 })],
    ["wait", buildWaitScript({ text: "x" })],
    ["checkFileInput", buildCheckFileInputScript("a")],
    ["elementCenter", buildElementCenterScript("a")],
  ];
  const leaks = all.filter(([, s]) => /%[A-Z_]+_JSON%/.test(s)).map(([n]) => n);
  check("★ 生成的脚本里没有残留的 %XXX_JSON%", leaks.length === 0, leaks);
}

console.log(`\nbrowser-script-injection-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
