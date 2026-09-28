/**
 * 源级不变量:**每一个"能被钩子挂上"的事件,走的那条通路必须真的能到达钩子。**
 *
 * ## 为什么要有这一套
 *
 * 主进程里有**两条**把 `RuntimeEvent` 送到外面去的路:
 *
 *   - `emitExternal` / 会话的 `emit` 闭包 —— 送界面,同时也 `notifySubscribers`;
 *   - `broadcastRuntimeEvent`(`main/lib/sessionSync.ts`)—— **只送界面**。
 *
 * 而钩子(`HookRunner`)与自动化的「事件发生时」触发器**挂在订阅上**
 * (`runtimeManager.subscribe`)—— 也就是说,一个事件只要是用
 * `broadcastRuntimeEvent` 发出去的,用户在设置里把它挂成钩子、写好了命令、
 * 保存成功、界面上一应俱全,**它永远不会响**。
 *
 * 这不是假设:`workflow.node.result` 与 `request.resolved` 都踩过这个坑
 * (两条现在都改成了 `emitExternal`,源码里各留了一段 ⚠️ 注释)。
 * 而它之所以能活下来,是因为**没有任何一套冒烟碰得到真实发出点的通路选择** ——
 * `hook-runner-smoke` 把整个 `RuntimeManager` 换成了桩,`workflow-view-smoke`
 * 只看视图模型。改错一个词,40 套全绿。
 *
 * 所以这一套不测行为,测**结构**:扫主进程源码,把每一个发出点连同它用的通路
 * 一起找出来,再拿 `HOOK_EVENT_OF` 对账。判据只有一条:
 *
 *   > 事件的 `type` 在 `HOOK_EVENT_OF` 里有非 null 的映射 ⇒ 它的发出点不许走
 *   > `broadcastRuntimeEvent`。
 *
 * ## 为什么不写成行为测试
 *
 * 行为级要活的 `RuntimeManager`(它 import 了 `window.js` / `BrowserWindow`),
 * 而更根本的是:**这套东西要防的是"以后新加一个事件时顺手写错通路"**。
 * 行为测试只能覆盖今天已有的那几条,新加的那条照样静默漏掉;源级扫描在
 * 新发出点落地的当下就红。同理,名单是**从代码里读出来的**,不是手抄的 ——
 * 抄一份名单就等于把"以后新加的事件"漏在门外。
 *
 * ## 已知的边界(不是"没验",是"这个形状验不了")
 *
 *  - **跨函数的通路**:只认**同一个函数体里**出现的 `broadcastRuntimeEvent`。
 *    发出点被抽成小函数、通路由调用方决定的那种,这里看不见。今天没有这种形状
 *    已知的 `withAutomationOrigin` 透传包装通过 AST 展开;其它跨函数形状若出现,
 *    要么把发出点收回本函数,要么在这一套里补一条断言。
 *  - **provider 里发的事件**(`SdkMessageAdapter` / `PiMessageAdapter` /
 *    `CodexMessageAdapter`)不走这两条路中的任何一条 —— 它们经 `ctx.emit`,
 *    而 `ctx.emit` **总是** `notifySubscribers`(见 `RuntimeManager.bindSession`
 *    里那个闭包的结尾)。所以那三个文件里的 `emit({ type: ... })` 天然安全,
 *    不扫。
 *  - **发出点是动态的**(`type:` 不是字面量)、或整个文件里找不到任何发出调用 ——
 *    各自留一条哨兵。前者说明扫描器看不懂了,后者说明文件挪走了。
 *
 * Run: scripts/emit-path-smoke/run.sh
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type * as TypeScript from "typescript";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HOOK_EVENT_OF } from "@contracts/hook";

/**
 * 基准目录 = `apps/desktop`。
 *
 * **不能用 `import.meta.url`**:这一套是按 esbuild 打包成单文件、放到临时目录里跑的
 * (见 `run.sh`),那个路径跟源码无关。`run.sh` 已经 `cd` 到 `apps/desktop`,所以用 cwd ——
 * 顺带在下面断言它真的是 `apps/desktop`(不是的话宁可红,也别去扫错的目录然后"全过")。
 */
const DESKTOP = resolve(process.cwd());
const MAIN = join(DESKTOP, "src/main");
const ts = createRequire(join(DESKTOP, "package.json"))("typescript") as typeof TypeScript;

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/* ────────────────── 扫描器:一个发出点 = (文件, 行, 通路, 事件名) ────────────────── */

/**
 * 把字符串字面量挖空(等长占位)。数括号深度时不能把字符串里的 `(` 算进去。
 *
 * ⚠️ **注释也必须一起挖空,而且不是洁癖 —— 少这一步整套会静默失效。**
 *
 * 这个仓库的注释密度很高,里面大量出现英文所有格(`turn's` / `doesn't` /
 * `agent's`)。那个孤撇号在扫描器眼里就是一个**字符串起点**:从它开始往后找
 * 配对的 `'`,一路吞掉几百行真代码挖成空格。实测 `RuntimeManager.ts` 第 39 行
 * `doesn't expose it` 的那一撇,把后面 500 多行全吞了 —— `emitExternal(...)`
 * 连同对象字面量一起消失,于是"扫到了 12 个发出点"里根本没有 `request.resolved`。
 *
 * 而失败的**长相**极具误导性:两条断言报 `— []`(没有发出点),看起来像"代码里
 * 真没有这个调用"或"扫描器的正则写错了",于是去翻源码、去改正则 —— 都白搭,
 * 源码是对的、正则也是对的,是**输入**被提前吃掉了。这个坑从这一套落地那天就在
 * (见 `a900928`),一直红着。
 *
 * 所以顺序是:先按「注释 → 字符串」两种区间一起扫,遇到 `//` 吃到行尾、遇到
 * `/*` 吃到 `*\/`,遇到引号吃到配对引号。挖空的只是内容,`//` 与引号本身留一个
 * 字符占位,免得把两边的 token 粘成一个。
 */
function blankStrings(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < Math.min(to, out.length); k += 1) out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    // 行注释:吃到行尾(不含换行本身,换行留着给下面的行号计算)。
    if (text[i] === "/" && text[i + 1] === "/") {
      const eol = text.indexOf("\n", i);
      const end = eol < 0 ? text.length : eol;
      blank(i, end);
      i = end;
      continue;
    }
    // 块注释:吃到 `*/`。注释里的撇号/反引号从此不再参与配对。
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c) break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** `text[open]` 是 `(`,返回配对括号之间的原文。 */
function balancedArg(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** 配对括号里那个 `)` 的下标(找不到返回 -1)。 */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 这一处是**定义**而不是**调用**吗?
 *
 * `emitExternal(event: RuntimeEvent): void {` 和 `emitExternal({ type: ... })` 的括号
 * 内容长得完全一样,靠参数名分辨不可靠。真正的判据是**括号后面那一个字符**:
 * 定义后面跟 `: 返回类型`,调用后面跟 `;` / `)` / `,` / 换行。
 */
function isDeclaration(text: string, open: number): boolean {
  const close = closingParen(text, open);
  if (close < 0) return false;
  const after = text.slice(close + 1).match(/^\s*(.)/);
  return after !== null && after[1] === ":";
}

/** 对象字面量里**最外层**的 `type` 值。返回 "字面量" 或 null(没有 / 不是字面量)。 */
function typeAtTopLevel(arg: string): string | null {
  const blanked = blankStrings(arg);
  let depth = 0;
  for (let i = 0; i < arg.length; i += 1) {
    const c = blanked[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === "t" && depth === 1 && blanked.startsWith("type", i)) {
      const m = /^\s*:\s*/.exec(blanked.slice(i + 4));
      if (!m) continue;
      const start = i + 4 + m[0].length;
      const q = arg[start];
      if (q === '"' || q === "'") {
        const end = arg.indexOf(q, start + 1);
        return arg.slice(start + 1, end);
      }
      return null; // 有 type 但不是字面量
    }
  }
  return null;
}

/** 从 `text[idx]` 往回走,返回包住它的那个函数的名字。 */
function enclosingFunction(text: string, idx: number): string {
  const blanked = blankStrings(text);
  let depth = 0;
  for (let i = idx; i >= 0; i -= 1) {
    const c = blanked[i];
    if (c === "}" || c === ")") depth += 1;
    else if (c === "{" || c === "(") {
      depth -= 1;
      if (depth < 0) return "";
    } else if (/[\w$]/.test(c)) {
      let s = i;
      while (s > 0 && /[\w$]/.test(blanked[s - 1])) s -= 1;
      let name = text.slice(s, i + 1);
      let k = s - 1;
      while (k >= 0 && /\s/.test(blanked[k])) k -= 1;
      // 跳过 `function` 关键字
      if (blanked[k] === "n" && /function$/.test(blanked.slice(Math.max(0, k - 7), k + 1))) {
        name = `${name} (function)`;
      }
      return name;
    }
  }
  return "";
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

interface Site {
  file: string;
  line: number;
  func: string;
  /** "broadcastRuntimeEvent" | "emitExternal" */
  path: "broadcast" | "external";
  /** 事件名;null = 解析不出来(那本身是一条失败断言)。 */
  type: string | null;
}

const sites: Site[] = [];
const filesWithEmit: string[] = [];
/** 接线点接到的出口名(见 `unwrapMetadataEmitters` 的形状三)。每个注入一条。 */
const wiringSinks: string[] = [];

/** Resolve only the known metadata-preserving wrapper, using AST boundaries.
 * This is scanner input normalization, never executable production code.
 * Both safe and unsafe sinks are preserved. Unknown transformations, escaping
 * aliases, mutable bindings or shadowed names remain unresolved and fail the
 * existing unknown-site assertion rather than being silently skipped. */
function unwrapMetadataEmitters(text: string, wiring?: string[]): string {
  // 三种形状各有自己的触发词,一个都不沾才能提前收工(这里对每个文件都跑一次,
  // 建 AST 不便宜)。两处易错:`withAmbientAutomationOrigin` **不包含**子串
  // `withAutomationOrigin`(中间多了 Ambient),所以统一只认 `AutomationOrigin`;
  // 而形状三**连包装都没有** —— 它认的是 `(e) => sink(e)` 这种裸转发,能当触发词的
  // 只有 sink 名本身。少写一个,对应那段新代码就永远走不到(这一条正是这么栽的)。
  if (!text.includes("AutomationOrigin") && !text.includes("emitExternal")
    && !text.includes("broadcastRuntimeEvent")) return text;
  const tree = ts.createSourceFile("emit-scan.ts", text, ts.ScriptTarget.Latest, true);
  const nodes: TypeScript.Node[] = [];
  const visit = (node: TypeScript.Node): void => { nodes.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  const edits: Array<{ start: number; end: number; sink: string }> = [];
  const replace = (node: TypeScript.Node, sink: string): void => {
    edits.push({ start: node.getStart(tree), end: node.getEnd(), sink });
  };
  // ── 形状二:`withAmbientAutomationOrigin(<事件>)` —— 收一条事件,还回同一条事件 ──
  //
  // 和上面那个柯里化包装**不是一回事**(那个收 sink、还回一个函数;这个收事件、还回事件),
  // 所以得单独认。它做的全部事情是"把当前作用域的来源记进一张 WeakMap":签名是
  // `<E extends RuntimeEvent>(event: E): E`,实现是一次浅拷贝,**一个字都没碰 type**。
  // 对"这条发出去的到底是哪个事件"这个问题,它是纯透传。
  //
  // 展开方式是**把包装的两头挖成空格、参数原样留在中间**,不是像上面那样替换成 sink 名:
  // 这里要让扫描器看见的是内层那个对象字面量。挖空而不是删掉,报出来的行号才还指得准。
  //
  // ⚠️ 这一段是 2026-09-29 补的:`library/broadcast.ts` 那两条导入/下载事件在 09-28 被
  // 加上了这层包装,而扫描器只认形状一 —— 于是它们在这张网里**失明**了两天,`emit-path`
  // 每次都红着报"解析不出事件名"。网认不出的形状必须补进网里,不能反过来要求生产代码
  // 迁就扫描器。
  for (const node of nodes) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)
      || node.expression.text !== "withAmbientAutomationOrigin") continue;
    // 多参数 / 展开参数都不是它的签名。认不出就别猜 —— 留给"无法解析"那条断言去报。
    const arg = node.arguments.length === 1 ? node.arguments[0] : undefined;
    if (!arg || ts.isSpreadElement(arg)) continue;
    edits.push({ start: node.getStart(tree), end: arg.getStart(tree), sink: "" });
    edits.push({ start: arg.getEnd(), end: node.getEnd(), sink: "" });
  }
  // ── 形状三:接线 —— `(e) => sink(e)` 被**当作值传出去** ──
  //
  // `index.ts` 那句 `configureLibraryEvents({ emitExternal: (event) => rm.emitExternal(event) })`
  // 一个事件都不发,它只是把出口**交给**另一个模块。扫描器原样看到的是一句
  // `emitExternal(event)`,于是报"解析不出事件名" —— 而那里本来就没有事件名可解。
  // 真正的发出点在拿到这个出口的那一侧(`library/broadcast.ts`),它们各自会被扫到。
  //
  // 整段挖空,但**把接的是哪个 sink 记下来**:豁免不许变成盲区。万一哪天有人把
  // `broadcastRuntimeEvent` 注入成下游眼里的 `emitExternal`,下游每一个发出点都会被
  // 误判成"走了对的那条路" —— 所以另有一条断言专门盯 `wiring` 这张表。
  for (const node of nodes) {
    if (!ts.isArrowFunction(node) || node.parameters.length !== 1) continue;
    const param = node.parameters[0].name;
    if (!ts.isIdentifier(param) || !ts.isCallExpression(node.body)) continue;
    const callee = node.body.expression;
    const sink = ts.isIdentifier(callee) ? callee.text
      : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (sink !== "emitExternal" && sink !== "broadcastRuntimeEvent") continue;
    // 必须是**原样转发**:`(e) => sink(e)`。中间多一个 transform 就不是接线、是加工,
    // 那种得留给"未知转换不许猜成安全透传"去报。
    if (node.body.arguments.length !== 1 || !ts.isIdentifier(node.body.arguments[0])
      || node.body.arguments[0].text !== param.text) continue;
    const parent = node.parent;
    // 形状一那个箭头长得一模一样,但它归 `withAutomationOrigin` 那段管 —— 别抢。
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)
      && parent.expression.text === "withAutomationOrigin") continue;
    // 只认"被传出去"的两种位置:实参,或对象字面量的属性值(注入 deps 的常见写法)。
    const passedOut = (ts.isCallExpression(parent) && parent.arguments.some((a) => a === node))
      || ts.isPropertyAssignment(parent);
    if (!passedOut) continue;
    wiring?.push(sink);
    replace(node, "");
  }
  for (const node of nodes) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)
      || node.expression.text !== "withAutomationOrigin") continue;
    const fn = node.arguments[0];
    if (!fn || !ts.isArrowFunction(fn) || fn.parameters.length !== 1
      || !ts.isIdentifier(fn.parameters[0].name) || !ts.isCallExpression(fn.body)) continue;
    const forward = fn.body;
    const callee = forward.expression;
    const sink = ts.isIdentifier(callee) ? callee.text
      : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (sink !== "emitExternal" && sink !== "broadcastRuntimeEvent") continue;
    if (forward.arguments.length !== 1 || !ts.isIdentifier(forward.arguments[0])
      || forward.arguments[0].text !== fn.parameters[0].name.text) continue;
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) {
      replace(node, sink); // withAutomationOrigin(...)(literalEvent)
      continue;
    }
    if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)
      || !ts.isVariableDeclarationList(parent.parent)
      || !(parent.parent.flags & ts.NodeFlags.Const)) continue;
    const name = parent.name.text;
    const identifiers = nodes.filter((candidate): candidate is TypeScript.Identifier =>
      ts.isIdentifier(candidate) && candidate.text === name);
    // Every reference must be a direct call of this uniquely named const.
    // In particular, a same-named parameter cannot inherit this sink by guess.
    if (!identifiers.every((identifier) => identifier === parent.name
      || (ts.isCallExpression(identifier.parent) && identifier.parent.expression === identifier))) continue;
    replace(node, sink);
    for (const identifier of identifiers) if (identifier !== parent.name) replace(identifier, sink);
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    // Keep all newlines so reported production line numbers remain truthful.
    const whitespace = text.slice(edit.start, edit.end).replace(/[^\n]/g, " ");
    text = text.slice(0, edit.start) + edit.sink + whitespace + text.slice(edit.end);
  }
  return text;
}

/** 扫一份源码,把发出点找出来。抽成函数是为了让下面那段自检能喂人造样本。 */
function scanSource(text: string, rel: string, wiring?: string[]): Site[] {
  text = unwrapMetadataEmitters(text, wiring);
  const blanked = blankStrings(text);
  const out: Site[] = [];
  for (const m of blanked.matchAll(/(?<![\w$])(broadcastRuntimeEvent|emitExternal)\s*\(/g)) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    if (isDeclaration(text, open)) continue;
    out.push({
      file: rel,
      line: text.slice(0, m.index).split("\n").length,
      func: enclosingFunction(text, m.index),
      path: name === "broadcastRuntimeEvent" ? "broadcast" : "external",
      type: typeAtTopLevel(balancedArg(text, open)),
    });
  }
  return out;
}

for (const file of walk(MAIN)) {
  const rel = relative(MAIN, file).replace(/\\/g, "/");
  const found = scanSource(readFileSync(file, "utf-8"), rel, wiringSinks);
  if (found.length > 0) filesWithEmit.push(rel);
  sites.push(...found);
}

/* ────────────── 检查 0:扫描器自己得能认出坏东西 ────────────── */

// 一套"永远绿"的测试比没有测试更坏 —— 它会让下一个人以为自己有保护。所以这里先拿两份
// **人造样本**喂给同一个扫描器:一份是正确写法,一份是把通路写错(正是本次修掉的那个
// bug 的形状)。第二份**必须**被认成 broadcast,否则总判据根本不会红。
console.log("\n扫描器自检(能不能认出把通路写错的那种)");
{
  const right = scanSource(
    `class X { private m() { this.emitExternal({ type: "turn.done", sessionId: "s" }); } }`,
    "<自检:正确写法>",
  );
  const wrong = scanSource(
    `class X { private m() { broadcastRuntimeEvent({ type: "workflow.node.result", sessionId: "s" }); } }`,
    "<自检:写错通路>",
  );
  const decl = scanSource(
    `  emitExternal(event: RuntimeEvent): void {\n    this.fanOutToClients(e);\n  }`,
    "<自检:定义>",
  );
  check(
    "认得出 emitExternal 调用",
    right.length === 1 && right[0].path === "external" && right[0].type === "turn.done",
    right,
  );
  check(
    "认得出 broadcastRuntimeEvent 调用(这条不认出来,总判据就是摆设)",
    wrong.length === 1 && wrong[0].path === "broadcast" && wrong[0].type === "workflow.node.result",
    wrong,
  );
  check("不把函数定义本身当成一个发出点", decl.length === 0, decl);

  // ⚠️ 这一条是**本套曾经静默失效一整天**的那个原因,单独钉住。
  // 注释里的英文所有格(`doesn't` / `turn's`)是一个孤撇号;老版 `blankStrings`
  // 不看注释,把它当成字符串起点,从那儿往后吞掉几百行真代码挖成空格 ——
  // 于是 `request.resolved` 的发出点连人带对象字面量一起消失,断言报 `— []`,
  // 看起来像"源码里没这个调用"(去翻源码就白搭,源码是对的)。
  const apostropheInComment = scanSource(
    [
      "/** The TurnHandle doesn't expose it. */",
      "class X {",
      "  private m() { this.emitExternal({ type: \"request.resolved\", sessionId: \"s\" }); }",
      "}",
      "// agent's value is monotonic — 中文注释里也可以有",
      "class Y {",
      "  private n() { broadcastRuntimeEvent({ type: \"session.deleted\", sessionId: \"s\" }); }",
      "}",
    ].join("\n"),
    "<自检:注释里有撇号>",
  );
  check(
    "★ 注释里的撇号不许把后面的真代码吞掉(本套就死在这上面)",
    apostropheInComment.length === 2 &&
      apostropheInComment[0].type === "request.resolved" &&
      apostropheInComment[0].path === "external" &&
      apostropheInComment[1].type === "session.deleted" &&
      apostropheInComment[1].path === "broadcast",
    apostropheInComment,
  );

  // 反引号同理:注释里写 `` `turn.done` `` 是老版第二个翻车点。
  const backtickInComment = scanSource(
    [
      "/** Fires at `turn.done`; see `emitExternal` below. */",
      "class X {",
      "  private m() { this.emitExternal({ type: \"turn.done\", sessionId: \"s\" }); }",
      "}",
    ].join("\n"),
    "<自检:注释里有反引号>",
  );
  check(
    "★ 注释里的反引号同理(注释说的事不许影响扫描结果)",
    backtickInComment.length === 1 && backtickInComment[0].type === "turn.done",
    backtickInComment,
  );

  // 反过来也要对:真的写在一对引号**里面**的调用名,得照样不算发出点。
  // (否则修完上面两条会把"字符串里的注释"变成新的一类误报。)
  const nameInsideString = scanSource(
    `const help = "调用 emitExternal({ type: 'nope' }) 就行";\nclass X { private m() { this.emitExternal({ type: "turn.done", sessionId: "s" }); } }`,
    "<自检:字符串里提到调用名>",
  );
  check(
    "★ 字符串字面量里提到的调用名不算发出点(挖空还得挖对)",
    nameInsideString.length === 1 && nameInsideString[0].type === "turn.done",
    nameInsideString,
  );

  // Automation metadata wrappers must not hide the actual sink or its events.
  const immediate = scanSource(
    `withAutomationOrigin((event) => manager.emitExternal(event), origin)({ type: "user.message" } satisfies RuntimeEvent);`,
    "<自检:立即调用的元数据包装>",
  );
  check("包装函数立即调用仍能找到真实事件", immediate.length === 1 && immediate[0].type === "user.message" && immediate[0].path === "external", immediate);
  const localWrapper = scanSource(
    `const send = withAutomationOrigin((event) => manager.emitExternal(event), origin);
     send({ type: "workflow.node.result" }); send({ type: "turn.done" });`,
    "<自检:本地 const 包装>",
  );
  check("本地包装的每个调用都分别扫描", localWrapper.length === 2 && localWrapper[0].type === "workflow.node.result" && localWrapper[1].type === "turn.done" && localWrapper.every((site) => site.path === "external"), localWrapper);
  const wrappedWrong = scanSource(
    `const send = withAutomationOrigin((event) => broadcastRuntimeEvent(event), origin);
     send({ type: "workflow.node.result" });`,
    "<自检:包装内的错误通路>",
  );
  check("包装内误用 broadcast 仍会被发现", wrappedWrong.length === 1 && wrappedWrong[0].path === "broadcast" && wrappedWrong[0].type === "workflow.node.result", wrappedWrong);
  const unknownWrapper = scanSource(
    `const send = withAutomationOrigin((event) => manager.emitExternal(transform(event)), origin);
     send({ type: "workflow.node.result" });`,
    "<自检:不能证明透传的包装>",
  );
  check("未知转换不许猜成安全透传", unknownWrapper.some((site) => site.type === null), unknownWrapper);
  const shadowed = scanSource(
    `const send = withAutomationOrigin((event) => manager.emitExternal(event), origin);
     function nested(send) { send({ type: "workflow.node.result" }); }`,
    "<自检:包装名被参数遮蔽>",
  );
  check("同名参数遮蔽时宁可报无法解析", shadowed.some((site) => site.type === null), shadowed);
  const dynamicWrapped = scanSource(
    `withAutomationOrigin((event) => manager.emitExternal(event), origin)({ type: chooseType() });`,
    "<自检:包装内动态事件类型>",
  );
  check("包装不掩盖动态类型的未知状态", dynamicWrapped.some((site) => site.type === null), dynamicWrapped);
  // 形状二(直接把事件对象包起来)同样不许藏住通路或事件名。
  const ambientWrapped = scanSource(
    `runtimeManager.emitExternal(withAmbientAutomationOrigin({ type: "library.item.imported", sessionId: "(system)" }));`,
    "<自检:直接包裹事件对象的元数据包装>",
  );
  check(
    "★ 认得出 withAmbientAutomationOrigin(它只往 WeakMap 记来源,不碰 type)",
    ambientWrapped.length === 1 && ambientWrapped[0].type === "library.item.imported" && ambientWrapped[0].path === "external",
    ambientWrapped,
  );
  const ambientWrong = scanSource(
    `broadcastRuntimeEvent(withAmbientAutomationOrigin({ type: "workflow.node.result" }));`,
    "<自检:直接包装里的错误通路>",
  );
  check(
    "★ 这层包装不许把走错的那条通路盖住",
    ambientWrong.length === 1 && ambientWrong[0].path === "broadcast" && ambientWrong[0].type === "workflow.node.result",
    ambientWrong,
  );
  const ambientDynamic = scanSource(
    `runtimeManager.emitExternal(withAmbientAutomationOrigin({ type: chooseType() }));`,
    "<自检:直接包装里的动态类型>",
  );
  check("★ 包住的是动态类型时照样报无法解析", ambientDynamic.some((site) => site.type === null), ambientDynamic);
  // 形状三:接线不是发出点 —— 但接错了出口必须看得见。
  const wiredOk: string[] = [];
  const wiredSites = scanSource(
    `configureLibraryEvents({ emitExternal: (event) => runtimeManager.emitExternal(event) });`,
    "<自检:把出口注入给别的模块>",
    wiredOk,
  );
  check("★ 接线点不算发出点(那一行本来就没有事件名可解)", wiredSites.length === 0, wiredSites);
  check("★ 但接的是哪个出口要记下来", wiredOk.length === 1 && wiredOk[0] === "emitExternal", wiredOk);
  const wiredWrong: string[] = [];
  scanSource(
    `configureLibraryEvents({ emitExternal: (event) => broadcastRuntimeEvent(event) });`,
    "<自检:注入了错误的出口>",
    wiredWrong,
  );
  check(
    "★ 注入 broadcast 会被记成 broadcast(豁免不许变成盲区)",
    wiredWrong.length === 1 && wiredWrong[0] === "broadcastRuntimeEvent",
    wiredWrong,
  );
  const notWiring: string[] = [];
  const transformed = scanSource(
    `configureLibraryEvents({ emitExternal: (event) => runtimeManager.emitExternal(transform(event)) });`,
    "<自检:接线里夹了加工>",
    notWiring,
  );
  check(
    "★ 转发中间夹了加工就不算接线(照旧报无法解析)",
    notWiring.length === 0 && transformed.some((site) => site.type === null),
    { notWiring, transformed },
  );
}

/* ────────────────── 检查 1:名字对不上 = 契约表整个漏了 ────────────────── */

console.log("\n扫描器自己(名字对不对得上一件真事)");
check(
  `cwd 就是 apps/desktop(否则下面扫的是别的树,"全过"没有意义)`,
  existsSync(join(DESKTOP, "package.json")) && existsSync(MAIN),
  DESKTOP,
);
const hookEventNames = new Set(Object.keys(HOOK_EVENT_OF));
check(`扫到了发出点(共 ${sites.length} 个,分布在 ${filesWithEmit.length} 个文件)`, sites.length > 0);
check(
  "每条发出点都拿到了事件名(没有解析不出来的)",
  sites.every((s) => typeof s.type === "string" && s.type.length > 0),
  sites.filter((s) => !s.type).map((s) => `${s.file}:${s.line} ${s.func}`),
);
// 接线点被 `unwrapMetadataEmitters` 挖掉了,不会出现在 `sites` 里 —— 但"它接的是哪个
// 出口"必须单独有人看。注入一个 `broadcastRuntimeEvent` 会让下游每一条发出点都被
// 误判成走了对的路,而下游自己一点问题都看不出来。
check(
  `接线点接的都是 emitExternal(共 ${wiringSinks.length} 处注入)`,
  wiringSinks.every((sink) => sink === "emitExternal"),
  wiringSinks,
);
check(
  "拿到的事件名都在 RuntimeEvent 契约表里",
  sites.every((s) => s.type !== null && hookEventNames.has(s.type)),
  sites.filter((s) => s.type !== null && !hookEventNames.has(s.type)).map((s) => s.type),
);
check(
  "已知有发出调用的文件都在扫描范围里",
  filesWithEmit.includes("claude/RuntimeManager.ts") &&
    filesWithEmit.includes("orchestration/runner.ts") &&
    filesWithEmit.includes("library/broadcast.ts"),
  filesWithEmit,
);

/* ────────────────── 检查 2:本次修的那两条 ────────────────── */

console.log("\n本次修的(以前发不出去的两条)");
const byType = (t: string) => sites.filter((s) => s.type === t);
for (const t of ["workflow.node.result", "request.resolved"]) {
  const hits = byType(t);
  check(
    `${t} 有发出点(改了名字或挪走了要跟着改这一套)`,
    hits.length > 0,
    hits.map((h) => `${h.file}:${h.line}`),
  );
  check(
    `${t} 走 emitExternal(走 broadcast 的话钩子永远不响)`,
    hits.length > 0 && hits.every((h) => h.path === "external"),
    hits.map((h) => `${h.file}:${h.line} → ${h.path}`),
  );
}

/* ────────────────── 检查 3:总判据 ────────────────── */

/**
 * `HOOK_EVENT_OF` 是 `Record<RuntimeEvent["type"], HookEvent | null>` —— 键的类型是那一大
 * 堆字面量的联合,拿一个 `string` 直接索引会 typecheck 不过。这里收窄一次,**同时**它
 * 也是"这个名字真的是个 RuntimeEvent 吗"的判据(下面那条断言就靠它)。
 */
function hookEventFor(type: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(HOOK_EVENT_OF, type)) return null;
  return HOOK_EVENT_OF[type as keyof typeof HOOK_EVENT_OF];
}

console.log("\n总判据:钩子挂得上的事件,不许走只发界面的那条路");
const hookable = sites.filter((s) => s.type !== null && hookEventFor(s.type) !== null);
check(`一次扫到 ${hookable.length} 个"钩子挂得上"的发出点`, hookable.length > 0);
const wrongPath = hookable.filter((s) => s.path === "broadcast");
check(
  "没有一个走 broadcastRuntimeEvent",
  wrongPath.length === 0,
  wrongPath.map((s) => `${s.file}:${s.line} ${s.type} ← ${s.func}`),
);

console.log("\n反面:故意不给钩子的那几条,留在 broadcast 上是对的");
// `workflow.node.*` 里只有 `.result` 给了钩子名,另外几条是 null —— 它们是"过程流",
// 走 broadcast 是对的(见 `hook.ts` 里 `HOOK_EVENT_OF` 那几段注释)。这一条钉住的是
// **判据本身**:证明上面那条总判据不是"全都在 external 所以过"。
const stillBroadcast = sites.filter((s) => s.path === "broadcast");
check(
  `确实还有走 broadcast 的发出点(${stillBroadcast.length} 个)`,
  stillBroadcast.length > 0,
  stillBroadcast.map((s) => s.type),
);
check(
  "走 broadcast 的那几条在契约表里都是 null",
  stillBroadcast.every((s) => s.type !== null && hookEventFor(s.type) === null),
  stillBroadcast.filter((s) => s.type !== null && hookEventFor(s.type) !== null).map((s) => s.type),
);

/* ────────────────── 检查 4:无人值守那一段的哨兵 ────────────────── */

console.log("\n哨兵:emitExternal 这个统一出口还在");
check(
  "RuntimeManager.emitExternal 仍然同时做 fanOut 与 notify",
  (() => {
    const src = readFileSync(join(MAIN, "claude/RuntimeManager.ts"), "utf-8");
    const at = src.indexOf("emitExternal(event: RuntimeEvent)");
    if (at < 0) return false;
    const body = src.slice(at, at + 600);
    return body.includes("this.fanOutToClients") && body.includes("this.notifySubscribers");
  })(),
);

/* ────────────────────── 收尾 ────────────────────── */

if (failures > 0) {
  console.error(`\n${failures} failed, ${checks - failures} passed`);
  process.exit(1);
}
console.log(`\n${checks}/${checks} 通过`);
