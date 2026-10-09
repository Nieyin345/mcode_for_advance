/**
 * 源级不变量:**同一件浏览器工具,三个 provider 报给模型的入参必须一模一样。**
 *
 * ## 它治的是哪一类 bug
 *
 * 浏览器工具在三个 provider 里各有一份**手抄**的入参声明(`browser/agentBrowserTools.ts`
 * 只共享了工具级的 `description` / `promptSnippet`,**没共享每个参数的声明**):
 *
 *   - `claude-sdk/ClaudeAgentSdkProvider.ts` —— zod 对象(`z.string().describe(...)`)
 *   - `codex-sdk/CodexAgentSdkProvider.ts`   —— JSON Schema(`{ type, description }`)
 *   - `pi-sdk/mcodeExtension.ts`             —— TypeBox(`Type.String({...})`)
 *
 * 三种写法没法直接共用一份,于是**每加/改一个参数要抄三遍**。少抄一遍的表现不是报错,
 * 而是:模型看工具说明里写着能传这个参数,传了,而某个 provider 的 schema 里**根本没声明
 * 它** → 严格校验的引擎直接拒掉这次调用(或者按默认值走)。用户在 Codex 引擎下看到
 * 「这个参数不生效」,而 Claude 引擎下好好的 —— 引擎相关的幽灵 bug。
 *
 * 本仓库**已经发生过一次**:`browser_navigate` 的 `newTab` 在 Claude/Pi 两份里都声明了、
 * 说明文字(`BROWSER_TOOL_SPECS.browser_navigate.description`)也明确让模型用
 * `newTab=true 强制新开标签`,而 Codex 的 schema 里**漏了这一格**;Codex 的 handler
 * 又**照样读** `args.newTab` —— 声明与实现各写一半,谁都不觉得自己错。
 *
 * ## 判据立在哪
 *
 * 两条,都从**各自文件的源码**里按**各自写法**扫:
 *
 *   1. 三个 provider 里**同名工具**的**入参名集合**必须相等(claude == codex == pi);
 *   2. Codex 的 handler 里读到的每个 `args.X`,必须在**它自己的 schema** 里声明过
 *      (`provider` 那一侧"读了没声明"就是这次那个 bug 的形状)。
 *
 * 命令**不跑代码、不装 Electron**:纯文本扫描三份源码。换掉这几种写法(比如动态拼
 * schema)会让扫描器「扫不到」而以红的形式告诉你 —— 那正是要的。
 *
 * ## 已知边界
 *
 *  - **只比参数名,不比每个参数的类型/说明文字。** 说明文字的漂移(同一参数三份描述
 *    措辞不同)也真发生过(`browser_type.clear` 的"追加" vs "追加到现有内容之后"、
 *    `browser_evaluate.script`),但那属于"文档不一致"而非"功能坏掉",不在这里硬卡 ——
 *    它会让断言对措辞过于敏感、一改文案就红。这里只管"参数在不在"。
 *  - 工具集合本身(18 个)也钉一下:三个 provider 必须都注册同一批,少一个 = 那个引擎
 *    下这个能力**不存在**。
 *
 * Run: scripts/browser-tool-parity-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** run.sh 里 `cd apps/desktop` 再跑,所以 `process.cwd()` 就是 apps/desktop
 *  —— 与 `ipc-wiring-smoke` 同一套相对根的办法。 */
const SRC = resolve(process.cwd(), "src", "main", "providers");

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

/** 从 `{` 匹配到配对的 `}`(含嵌套对象)。返回末尾下标;找不到返回 -1。 */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j += 1) {
    if (s[j] === "{") depth += 1;
    else if (s[j] === "}") {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * 取 `body` 里**深度 1** 的键名 —— 只认直接属于这个对象的那几格,不抓嵌套对象里的
 * (`items: { type: "string" }` 的 `type` 不算属性名,`items` 本身才算)。
 */
function topLevelKeys(body: string): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  for (let j = 0; j < body.length; j += 1) {
    const ch = body[j];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === "(" && depth === 0) {
      // 跳过一对调用括号里的内容(zod 的 `.describe("…")` 之类),免得把参数说明里的
      // 中文引号、逗号误当成属性。
      let pd = 1;
      while (j + 1 < body.length && pd > 0) {
        j += 1;
        if (body[j] === "(") pd += 1;
        else if (body[j] === ")") pd -= 1;
      }
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const m = /^([A-Za-z_]\w*)\s*:/.exec(body.slice(j));
      if (m) {
        out.add(m[1]);
        j += m[0].length - 1;
      }
    }
  }
  return out;
}

/** 扫 `name: "browser_xxx"` → inputSchema/parameters 对象里的深度-1 键。 */
function scanTools(src: string, schemaKey: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const nameRe = /name:\s*"(browser_\w+)"/g;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(src)) !== null) {
    const name = m[1]!;
    const at = src.indexOf(schemaKey, m.index);
    if (at < 0 || at > m.index + 3000) continue;
    const open = src.indexOf("{", at);
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open + 1, close);
    const keys = topLevelKeys(body);
    // Codex 的 `browserId: optId` 是一个短变量(不是内联对象)—— 深度-1 扫得到键名 `browserId`。
    out.set(name, keys);
  }
  return out;
}

/** 扫 handler 里 `case "browser_xxx":` 之后、下一个 case 之前读到的 `args.X`。 */
function scanArgsReads(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const caseRe = /case\s*"(browser_\w+)":/g;
  let m: RegExpExecArray | null;
  const marks: Array<{ name: string; at: number }> = [];
  while ((m = caseRe.exec(src)) !== null) marks.push({ name: m[1]!, at: m.index });
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i]!.at;
    const end = i + 1 < marks.length ? marks[i + 1]!.at : src.length;
    const seg = src.slice(start, end);
    const read = new Set<string>();
    const argRe = /args\.(\w+)/g;
    let a: RegExpExecArray | null;
    while ((a = argRe.exec(seg)) !== null) read.add(a[1]!);
    out.set(marks[i]!.name, read);
  }
  return out;
}

const claudeSrc = readFileSync(join(SRC, "claude-sdk", "ClaudeAgentSdkProvider.ts"), "utf8");
const codexSrc = readFileSync(join(SRC, "codex-sdk", "CodexAgentSdkProvider.ts"), "utf8");
const piSrc = readFileSync(join(SRC, "pi-sdk", "mcodeExtension.ts"), "utf8");

const claude = scanTools(claudeSrc, "inputSchema:");
const codex = scanTools(codexSrc, "inputSchema:");
const pi = scanTools(piSrc, "parameters:");

console.log("\n1. 三个 provider 都扫到同一批浏览器工具");
check("扫描器认得 Claude 的工具(不该是 0)", claude.size > 0, claude.size);
check("扫描器认得 Codex 的工具", codex.size > 0, codex.size);
check("扫描器认得 Pi 的工具", pi.size > 0, pi.size);

{
  const all = new Set([...claude.keys(), ...codex.keys(), ...pi.keys()]);
  const missing: Record<string, string[]> = {};
  for (const t of all) {
    const miss = ["claude", "codex", "pi"].filter((p) => !({ claude, codex, pi }[p] as Map<string, Set<string>>).has(t));
    if (miss.length) missing[t] = miss;
  }
  check("每个工具三个 provider 都注册了(少一个 = 那个引擎下没这个能力)", Object.keys(missing).length === 0, missing);
}

console.log("\n2. 同名工具的入参名集合三份一致(手抄漂移就红)");

{
  const all = [...claude.keys()].filter((t) => codex.has(t) && pi.has(t)).sort();
  const diffs: Record<string, { claude: string[]; codex: string[]; pi: string[] }> = {};
  for (const t of all) {
    const a = claude.get(t)!;
    const b = codex.get(t)!;
    const c = pi.get(t)!;
    if (!(sameSet(a, b) && sameSet(b, c))) {
      diffs[t] = { claude: [...a].sort(), codex: [...b].sort(), pi: [...c].sort() };
    }
  }
  check("★ 每个浏览器工具的入参在 Claude/Codex/Pi 三份里完全一致", Object.keys(diffs).length === 0, diffs);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

console.log("\n3. Codex 的 handler 只读自己 schema 里声明过的参数");

{
  const declared = codex;
  const reads = scanArgsReads(codexSrc);
  check("扫描器认得 Codex 的 handler", reads.size > 0, reads.size);
  const undeclared: Record<string, string[]> = {};
  for (const [tool, args] of reads) {
    const props = declared.get(tool);
    if (!props) continue; // 工具集那条断言管
    const gap = [...args].filter((a) => !props.has(a));
    if (gap.length) undeclared[tool] = gap.sort();
  }
  check("★ Codex 没有『handler 读 args.X 而 schema 没声明 X』(newTab 那个 bug 的形状)", Object.keys(undeclared).length === 0, undeclared);
}

console.log("\nbrowser:event 的每个类型消费端都有人处理");

{
  // 主进程发出去的 browser:event 类型,渲染端 BrowserPanel 必须**每一种都有分支** ——
  // 少了哪一种,那一类事件就是"发了没人听"的静默失败。实测 `crashed` 从前正是如此:
  // 页面渲染进程崩了(render-process-gone),主进程一直发,而渲染端没有分支 → 用户看到
  // 一块永久空白、无报错也无重载入口。
  const panel = readFileSync(join(process.cwd(), "src/renderer/components/browser/BrowserPanel.tsx"), "utf8");
  // 主进程侧发的事件类型:find(`type: "<x>"` 里那几个 browser:event 的)。
  const mgr = readFileSync(join(process.cwd(), "src/main/browser/BrowserManager.ts"), "utf8");
  const produced = new Set<string>();
  // push("navigation" ...) / type: "crashed" 两种写法都抓。
  for (const m of mgr.matchAll(/push\(\s*"(\w+)"/g)) produced.add(m[1]!);
  for (const m of mgr.matchAll(/type:\s*"(\w+)"/g)) produced.add(m[1]!);
  // 只保留渲染端**认识**的那几类事件名(过滤掉 push() 抓到的别的字符串)。
  const KNOWN = ["navigation", "loading", "tabOpened", "pickResult", "download", "authRequest", "crashed"];
  const events = KNOWN.filter((k) => produced.has(k));
  check("扫到主进程发的 browser:event 类型(防断言空过)", events.length >= 5, events);
  const unhandled = events.filter((k) => !panel.includes(`msg.type === "${k}"`));
  check("★ 每种 browser:event 渲染端都有分支(不然就是发了没人听的静默失败)", unhandled.length === 0, unhandled);
  check("★ crashed 有消费端(从前没有 → 崩溃=永久空白)", panel.includes('msg.type === "crashed"'));
}

console.log("\n浏览器工具的**广告**也得按同一个开关来");

{
  // 工具定义按"内建浏览器开没开"砍;而**系统提示里那段工具用法**是一份**广告** ——
  // 工具没注册就不能广告,否则关掉浏览器后模型照提示去调一个不存在的工具。
  // 三引擎各自拼自己的提示词,所以这条是**跨引擎不变量**:每处 `browserToolsUsagePrompt()`
  // 都必须被 `browserToolsEnabled`(或等价的开关)守着。
  const claudeSrc = readFileSync(join(process.cwd(), "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"), "utf8");
  const codexSrc = readFileSync(join(process.cwd(), "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"), "utf8");
  const piSrc = readFileSync(join(process.cwd(), "src/main/providers/pi-sdk/mcodeExtension.ts"), "utf8");

  // 每处调用点,取它所在那一行的上下文,必须能看到开关守卫。
  const usageCallers = (src: string): string[] =>
    src.split("\n").filter((l) => l.includes("browserToolsUsagePrompt()"));
  const guarded = (l: string): boolean => /browserToolsEnabled|browserDisabled|BROWSER_MCP_SERVER/.test(l);

  for (const [name, src] of [["Claude", claudeSrc], ["Codex", codexSrc], ["Pi", piSrc]] as const) {
    const callers = usageCallers(src);
    // Claude 走 MCP 注入表,可能根本不出现这个符号 —— 出现的那几处才要守。
    const unguarded = callers.filter((l) => !guarded(l));
    check(`★ ${name}:浏览器工具广告都被开关守着(没注册就不广告)`, unguarded.length === 0, { callers, unguarded });
  }
  // 防断言空过:至少有一处真的调了这个函数(否则上面全是空判)。
  check(
    "对照:确实扫到了 browserToolsUsagePrompt 的调用点",
    usageCallers(claudeSrc).length + usageCallers(codexSrc).length + usageCallers(piSrc).length > 0,
    { claude: usageCallers(claudeSrc).length, codex: usageCallers(codexSrc).length, pi: usageCallers(piSrc).length },
  );
}

console.log(`\nbrowser-tool-parity-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
