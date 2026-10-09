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
  SNAPSHOT_SCRIPT,
} from "../../src/main/browser/snapshotScript.js";
import { PICKER_INJECT_SCRIPT } from "../../src/main/browser/pickerScript.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/* ── 3. 注入脚本里的错误消息是中文(它们原样回给模型)── */

console.log("\n注入脚本的错误消息是中文");

{
  // 这些 `{ error: '…' }` 经 `agentBrowserTools` 原样回给模型,而同一个文件里
  // WAIT/SELECT/文件输入框那几条一直是中文 —— 中英混杂没有理由,统一成中文。
  // 判据:生成的脚本里,`error: '…'` 那些字符串不得是纯英文。
  const all = [
    buildClickScript("a"),
    buildEvaluateScript("1"),
    buildTypeScript("a", "b", true),
    buildSelectScript("a", "b"),
    buildFindScript({ text: "x" }),
    buildScrollScript({ selector: "a", direction: "up", pages: 1 }),
    buildWaitScript({ text: "x" }),
    buildCheckFileInputScript("a"),
    buildElementCenterScript("a"),
  ].join("\n");
  const errs = [...all.matchAll(/error:\s*'([^']*)'/g)].map((m) => m[1]!);
  const english = errs.filter((t) => /[A-Za-z]{3}/.test(t) && !/[一-鿿]/.test(t));
  check("★ 注入脚本里没有纯英文的 error 消息", english.length === 0, english);
}

/* ── 4. 选择器构造器三个入口共用一份(不许再各抄一份)── */

console.log("\nbuildSelector 三个入口共用一份");

{
  // `buildSelector` 从前在 SNAPSHOT / FIND / PICKER 三份脚本里各内联一份,注释口头声称
  // "Mirrors",而已经漂过(深度 5 vs 4)。现在三份都插同一段,判据:
  //   ① 三份生成的脚本里都能摘出一段 `function buildSelector`;
  //   ② 三段**逐字相同**(同一段源码);③ 深度上限是 5(统一后那个值)。
  const dump = (s: string): string | null => {
    const i = s.indexOf("function buildSelector(");
    if (i < 0) return null;
    const b = s.indexOf("{", i);
    let d = 0;
    for (let j = b; j < s.length; j += 1) {
      if (s[j] === "{") d += 1;
      else if (s[j] === "}") {
        d -= 1;
        if (d === 0) return s.slice(i, j + 1).replace(/\s+/g, " ");
      }
    }
    return null;
  };
  const a = dump(SNAPSHOT_SCRIPT);
  const b = dump(buildFindScript({ text: "x" }));
  const c = dump(PICKER_INJECT_SCRIPT);
  check("三份脚本都有 buildSelector", a !== null && b !== null && c !== null, { a: !!a, b: !!b, c: !!c });
  check("★ 三份 buildSelector 逐字相同(同一段源码,不再各抄一份)", a === b && b === c, {
    snapshot: a?.slice(0, 80),
    find: b?.slice(0, 80),
    picker: c?.slice(0, 80),
  });
  check("★ 深度上限统一为 5(漂过一次的 4 不许回来)", !!a && a.includes("parts.length >= 5"), a?.slice(-60));

  // ★★ 判据不能只停在"三份逐字相同" —— 三份**同样错**时那条照样绿。
  //   这里把 `buildSelector` **真的跑一遍**,喂一个"同标签兄弟之间夹着别的标签"的
  //   DOM,断言生成的选择器**真的命中那个元素**。
  //
  //   曾经的写法是 `:nth-child(sameTag.indexOf(node)+1)` —— 位置算的是同标签兄弟里的
  //   第几个,而 `:nth-child` 数的是**全部**元素子节点。`<div><h1/><p/><p/></div>` 里
  //   第二个 `<p>` 会算出 `:nth-child(2)`,而 `:nth-child(2)` 命中的是第一个 `<p>`。
  //   模型拿这个选择器去 click 就落到错的元素上。正确的 CSS 是 `:nth-of-type`。
  {
    type FakeEl = {
      tagName: string; id: string; classList: string[]; nodeType: number;
      parentElement: FakeEl | null; children: FakeEl[];
    };
    const el = (tagName: string, children: FakeEl[] = []): FakeEl => {
      const node: FakeEl = { tagName, id: "", classList: [], nodeType: 1, parentElement: null, children };
      for (const c of children) c.parentElement = node;
      return node;
    };
    // <div><h1/><p/><p/></div> —— 两个 <p> 之间/之前夹着 <h1>。
    const p1 = el("P");
    const p2 = el("P");
    const root = el("DIV", [el("H1"), p1, p2]);

    // 提取真正的 buildSelector 源码(**保留换行** —— 折叠成一行会让 `//` 注释把整行吞掉),
    // 在一个提供了假 document/CSS 的作用域里跑。
    const dumpRaw = (s: string): string => {
      const i = s.indexOf("function buildSelector(");
      const b = s.indexOf("{", i);
      let d = 0;
      for (let j = b; j < s.length; j += 1) {
        if (s[j] === "{") d += 1;
        else if (s[j] === "}") {
          d -= 1;
          if (d === 0) return s.slice(i, j + 1);
        }
      }
      return "";
    };
    const snippet = dumpRaw(SNAPSHOT_SCRIPT).replace(/function buildSelector/, "return function buildSelector");
    const fakeDocument = { documentElement: el("HTML") };
    const fakeCss = { escape: (s: string) => s };
    const buildSelector = new Function("document", "CSS", snippet)(fakeDocument, fakeCss) as (n: FakeEl) => string;

    const sel2 = buildSelector(p2);
    check("同标签兄弟夹着别的标签时,生成的是 nth-of-type(不是 nth-child)", sel2.includes(":nth-of-type(2)") && !sel2.includes(":nth-child("), sel2);

    // 用一个**真的** CSS 选择器匹配器验证它命中的是 p2 而不是 p1 —— 免得只是字符串对。
    // 极简匹配:只支持 `tag > tag:nth-of-type(n)` 这种本用例会产生的形状。
    const matches = (sel: string, target: FakeEl, sibling: FakeEl): boolean => {
      const last = sel.split(" > ").pop() ?? "";
      const m = /^p:nth-of-type\((\d+)\)$/i.exec(last);
      if (!m) return false;
      const parent = target.parentElement!;
      const sameTag = parent.children.filter((c) => c.tagName === target.tagName);
      const idx = sameTag.indexOf(target) + 1;
      return sameTag.includes(target) && idx === Number(m[1]) && sibling !== target;
    };
    check("★ 该选择器真的命中目标元素(不是命中的第一个同标签兄弟)", matches(sel2, p2, p1), { sel2, p2IsFirst: false });

    const sel1 = buildSelector(p1);
    check("第一个同标签兄弟依然可选中", matches(sel1, p1, p2) && sel1.includes(":nth-of-type(1)"), sel1);
  }
}

/* ── 5. 主进程侧的两条源码不变量(要真 BrowserWindow,无头跑不了行为) ── */

console.log("\nBrowserManager 源码不变量");

{
  const mgrSrc = readFileSync(join(process.cwd(), "src/main/browser/BrowserManager.ts"), "utf8");

  // ★ `waitForLoad` 的 did-fail-load 必须**只看主文档**。子框架(广告/跟踪 iframe、
  //   跨域嵌入、子资源被打断时的 -3 ERR_ABORTED)失败同样会触发 did-fail-load,不看
  //   `isMainFrame` 就会把一个**主文档已经加载好**的页面判成"加载失败"报给模型,模型
  //   于是重试/放弃一个其实打开了的页面。
  {
    // 取 `onFail` 那段(从 did-fail-load 的 onFail 定义到它的 finish 调用)。
    const i = mgrSrc.indexOf("const onFail = (");
    const body = i >= 0 ? mgrSrc.slice(i, i + 400) : "";
    // 判据钉在**守卫本身**(`isMainFrame === false` 时 return),不是只看到参数名 ——
    // 只查名字的话,签名里留着参数、函数体里却不用它,照样"绿"。
    check("★ waitForLoad 的 onFail 在子框架失败时直接放过(子框架失败不算这一页)", /isMainFrame === false\)\s*return/.test(body), body.slice(0, 220));
  }

  // ★ 选取结果的二次裁剪上限不能与 pickerScript 的常量各写一份 —— 那边改了这边会静默裁错。
  check("★ PICK_HTML_CAP 由 PICKER_HTML_CAP 现填(不是第二个字面量)", mgrSrc.includes("PICK_HTML_CAP = PICKER_HTML_CAP"), mgrSrc.match(/PICK_HTML_CAP = [^\n]+/)?.[0]);
  check("…且真的从 pickerScript 导入了那个常量", mgrSrc.includes("PICKER_HTML_CAP") && mgrSrc.includes("./pickerScript.js"));

  // ★ `waitForLoad` 的 backstop 定时器必须在**结算时**被清掉。它原来是一个裸
  //   `setTimeout(...)` 表达式语句:页面正常加载(did-finish-load)时它照样挂到
  //   `timeoutMs`(默认 8s)——既白占事件循环,更糟的是回调**先算参数再进 finish**,
  //   参数里有 `wc.getURL()`/`wc.getTitle()`;标签被关掉销毁 webContents 之后定时器
  //   才到点,就对已销毁的 webContents 调 `getURL()` → 抛 "Object has been destroyed",
  //   而抛出发生在 setTimeout 回调里 = 主进程未捕获异常。
  //   判据钉在结构上:① 定时器的句柄被**赋值给一个变量**(裸语句根本 clear 不了);
  //   ② `finish` 的函数体里调了 `clearTimeout` 清那个句柄。
  {
    const wi = mgrSrc.indexOf("async waitForLoad(");
    const wbody = wi >= 0 ? mgrSrc.slice(wi, wi + 4500) : "";
    // ① 句柄被接住:`<name> = setTimeout(...)`(不是 `setTimeout(...)` 当一个语句丢掉返回值)。
    const handle = /\b(\w+)\s*=\s*setTimeout\s*\(/.exec(wbody)?.[1] ?? "";
    check("★ waitForLoad 的 backstop 定时器句柄被接住(不是裸 setTimeout 丢掉)", handle.length > 0, wbody.slice(0, 200));
    // ② `finish` 里清掉它 —— 取 finish 定义到下一个 `};` 的块。
    const fi = wbody.indexOf("const finish = ");
    const fend = fi >= 0 ? wbody.indexOf("};", fi) : -1;
    const fbody = fi >= 0 && fend >= 0 ? wbody.slice(fi, fend) : "";
    check(
      `★ waitForLoad 结算时清掉 backstop 定时器(clearTimeout(${handle || "<handle>"}))`,
      handle.length > 0 && new RegExp(`clearTimeout\\s*\\(\\s*${handle}\\s*\\)`).test(fbody),
      { handle, finishBody: fbody.slice(0, 260) },
    );
  }
}

console.log(`\nbrowser-script-injection-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;