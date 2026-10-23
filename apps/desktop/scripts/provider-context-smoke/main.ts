import { automaticMemoryForTurn } from "@main/memory/policy.js";
/** Provider-neutral prompt/context wiring smoke.
 *
 * 这套专门钉三件很容易“只修 Claude”的事：工作流/角色/主对话记忆三层上下文，
 * 必须由 host 解析一次、三个 provider 各自只负责用同一组 sections 注入。
 */
// 【T64】用 TypeScript 编译器 API 做 AST 判据，替代 `includes(源码)` 的文本匹配。
//
// 为什么要运行时 resolve 而不是顶层 `import ts from "typescript"`：
// 这套 smoke 被 esbuild 打进临时目录跑，那里没有 node_modules —— 静态 import 会在
// 运行时抛 ERR_MODULE_NOT_FOUND。用 createRequire 从**项目根**解析，路径稳定。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import type * as TS from "typescript";
const requireFromHere = createRequire(resolve(process.cwd(), "package.json"));
const ts = requireFromHere("typescript") as typeof TS;
// 【T68】6 条剩余文本断言共用这一套 AST 判据（抽出而非重写第二份解析器）。
import {
  parseSource, parseFile, findPropertyAssignments, findPropertyAccesses,
  findIdentifiers, findConstDeclarations, findSliceWithNegated, fakeSourceWithTextOnly,
} from "./astAssertions.js";
type RuntimeManagerSingleton = typeof import("@main/claude/RuntimeManager.js").runtimeManager;
import type { ClaudeAgentSdkProvider } from "@main/providers/claude-sdk/ClaudeAgentSdkProvider.js";
import type { PiAgentSdkProvider } from "@main/providers/pi-sdk/PiAgentSdkProvider.js";
import type { CodexAgentSdkProvider } from "@main/providers/codex-sdk/CodexAgentSdkProvider.js";
import type { BuildPiSkillLoaderOptions } from "@main/providers/pi-sdk/piSkillBridge.js";
import { turnContextSections } from "@main/providers/contextPrompt.js";
// 从**纯的那个模块**导入 —— `envPrompt.ts` 拉了 repositories(→ db → electron),
// 这套 smoke 没桩它。格式化那半本来就是纯的,拆出来才测得到。
import { formatEnvSections, selectVisibleItems } from "@main/providers/envPromptFormat.js";
// 三引擎"上下文快照带模型名"的一致性 ---------- 真适配器 + 纯换算,不起模型。
import { buildCodexTokenSnapshot } from "@main/providers/codex-sdk/codexTokenUsage.js";
import { buildPiTokenSnapshot } from "@main/providers/pi-sdk/piTokenUsage.js";
import { CodexMessageAdapter } from "@main/providers/codex-sdk/CodexMessageAdapter.js";

void (0 as unknown as RuntimeManagerSingleton | ClaudeAgentSdkProvider | PiAgentSdkProvider | CodexAgentSdkProvider | BuildPiSkillLoaderOptions);

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

console.log("共享上下文分层");same(
  "优先级固定：环境 → 记忆背景 → 角色身份 → 当前工作流",
  turnContextSections({
    envPrompt: "  环境  ",
    memoryPrompt: "  旧背景  ",
    agentPrompt: "角色",
    workflowPrompt: "流程",
  }),
  ["环境", "旧背景", "角色", "流程"],
);
same(
  "环境块排在**最前**（它是「我在什么机器上」这种最底层事实）",
  turnContextSections({ envPrompt: "环境", workflowPrompt: "流程" })[0],
  "环境",
);
same(
  "优先级固定：记忆背景 → 角色身份 → 当前工作流",
  turnContextSections({ memoryPrompt: "  旧背景  ", agentPrompt: "角色", workflowPrompt: "流程" }),
  ["旧背景", "角色", "流程"],
);
same(
  "空白层被过滤，不制造空 section",
  turnContextSections({ memoryPrompt: " ", agentPrompt: undefined, workflowPrompt: "流程" }),
  ["流程"],
);

console.log("\n环境背景（项目 + 文档库）");
// 核心价值:库里给的是**标题**,不是 sha256 文件名。库文件是内容寻址的
// (`papers/ab/cd/<sha256>.pdf`),给路径的话 agent 认不出哪篇是哪篇。
const envWithItems = formatEnvSections({
  currentProjectPath: "D:/proj/cur",
  projects: [
    { name: "当前项目", path: "D:/proj/cur" },
    { name: "另一个", path: "D:/proj/other" },
  ],
  libraryRoot: "C:/data/library",
  items: [
    { title: "Attention Is All You Need", kind: "paper", year: 2017, venue: "NeurIPS", pdfPath: "papers/ab/cd/9f2a.pdf" },
    { title: "A Textbook", kind: "textbook", mdPath: "markdown/12/34/abcd.md" },
  ],
  totalItems: 2,
});
check("环境块里有项目清单", !!envWithItems && envWithItems.includes("D:/proj/other"), envWithItems);
check("环境块里有库根", !!envWithItems && envWithItems.includes("C:/data/library"), envWithItems);
check(
  "库里给的是**标题**（不是 sha256 文件名）",
  !!envWithItems && envWithItems.includes("Attention Is All You Need"),
  envWithItems,
);
check("标题下附了文件路径（读正文要用）", !!envWithItems && envWithItems.includes("papers/ab/cd/9f2a.pdf"), envWithItems);
check(
  "有 md 时优先给 md（比 pdf 好读）",
  !!envWithItems && envWithItems.includes("markdown/12/34/abcd.md"),
  envWithItems,
);
check("写清了库只读", !!envWithItems && envWithItems.includes("只读"), envWithItems);

same(
  "什么都没变、也没内容 → 返回 null（不注入空块）",
  formatEnvSections({ currentProjectPath: null, projects: [], libraryRoot: "", items: [], totalItems: 0 }),
  null,
);
const truncated = formatEnvSections({
  currentProjectPath: null,
  projects: [],
  libraryRoot: "C:/data/library",
  items: [{ title: "只有一条" }],
  totalItems: 500,
});
check("截断时仍报出总数", !!truncated && truncated.includes("共 500 条"), truncated);
check("…并说明只列了前几条", !!truncated && truncated.includes("前 1 条"), truncated);
check("空库时明说库是空的", (formatEnvSections({ currentProjectPath: null, projects: [], libraryRoot: "C:/lib", items: [], totalItems: 0 }) ?? "").includes("库是空的"));

const envItems = [
  { id: "a", title: "可见" },
  { id: "b", title: "被屏蔽" },
  { id: "c", title: "在回收站" },
  { id: "d", title: "也可见" },
];
const keptEnvItems = selectVisibleItems(
  envItems,
  (id) => id === "c", // 回收站
  (id) => id === "b", // 屏蔽
);
same("回收站与被屏蔽的条目都不进环境块", keptEnvItems.map((i) => i.id), ["a", "d"]);
same(
  "上限在过滤之后生效（筛掉的不占名额）",
  selectVisibleItems(envItems, () => false, () => false, 2).map((i) => i.id),
  ["a", "b"],
);
const root = resolve(process.cwd());
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const runtime = source("src/main/claude/RuntimeManager.ts");
const claude = source("src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts");
const pi = source("src/main/providers/pi-sdk/PiAgentSdkProvider.ts");
const piBridge = source("src/main/providers/pi-sdk/piSkillBridge.ts");
const codex = source("src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");
const memoryServer = source("src/main/mcp/memoryServer.ts");

console.log("\n环境块的屏蔽与回收站过滤");
// 环境块是**面向 AI**的出口:被屏蔽(设置里"不给 AI 看")与回收站里的条目
// 绝不能进系统提示词。曾经这里直接列 LibraryRepo.list 的全部,漏了这层过滤。
const envModule = source("src/main/providers/envPrompt.ts");
check("envPrompt 把屏蔽/回收站过滤接到查库那一侧", envModule.includes("selectVisibleItems(") && envModule.includes("suppressionReasonOfItem(") && envModule.includes("trashedItemIds("));

console.log("\n主对话记忆边界");
check("普通 chat 自动注记忆", automaticMemoryForTurn("chat"));
check("工作流拥有 chat 轮次时不自动叠加", !automaticMemoryForTurn("chat", true));
for (const kind of ["side", "node", "automation"] as const) check(`${kind} 不继承主聊天自动注入`, !automaticMemoryForTurn(kind));
check("模型回退保留工作流记忆所有权", runtime.includes("memoryManagedByWorkflow: input.memoryManagedByWorkflow"));
check("RuntimeManager 把记忆作为独立 memoryPrompt 下传", runtime.includes("memoryPrompt,"));
check("RuntimeManager 把环境作为独立 envPrompt 下传", runtime.includes("envPrompt,") && runtime.includes("buildEnvPrompt("));
check(
  "…且按内容指纹去重（内容没变不重复灌）",
  runtime.includes("envPromptFingerprint") && runtime.includes("lastEnvFingerprint"),
);
// 指纹必须**等回合真起来了才记**。记在算的时候(从前是),引擎没起成(配置/桥/引擎抛错,
// `handle === null`)那一轮一个字都没发出去,指纹却已经写进表 —— 用户改好配置重试时
// `envPromptFingerprint(built) === lastEnvFingerprint` 为真,**环境块再也不注入**,而模型
// 不会报错,只是从此不知道有哪些项目、库在哪。判据:写表只出现在 `handle !== null` 那一支。
check(
  "环境块指纹等到回合真起来才提交（失败那一轮不吞注入）",
  /handle !== null && envFingerprintToCommit !== undefined[\s\S]{0,200}lastEnvFingerprint\.set\(/.test(runtime),
);
check("普通聊天记忆走 memorySectionFrom + scopedMemorySnapshot", runtime.includes("memorySectionFrom") && runtime.includes("scopedMemorySnapshot"));

check("工作流控制的轮次不叠加聊天自动记忆", runtime.includes("input.memoryManagedByWorkflow") && runtime.includes("automaticMemoryForTurn"));

console.log("\n失败回退重发:标记随调用走,不挂会话共享状态");
// 「下一轮该用回退模型」曾经挂在 `rt.fallbackRetryModel`(会话级共享状态)上,会被**任何
// 先到**的 sendTurnBound 抢先消费 —— 失败那轮之后排队的用户消息(或手快再发一条)先跑,
// 就会把用户那一轮悄悄换成回退模型。判据:标记从**入参**取、且不再有 `rt.fallbackRetryModel`。
// 剥掉注释再查 —— 源码注释里专门**提到**这个旧名字来解释改动,那不是代码。
const runtimeCode = runtime.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
check("回退标记从这次调用的入参取(不是会话级共享状态)", runtimeCode.includes("input.fallbackRetryModel !== undefined"));
check("…且不再有 rt.fallbackRetryModel 这种会话级残留", !runtimeCode.includes("fallbackRetryModel") || !/rt\.fallbackRetryModel/u.test(runtimeCode));
check("重发时把回退模型随入参带上", runtimeCode.includes("fallbackRetryModel: nextModel"));
const runner = source("src/main/orchestration/runner.ts");
check("图型主对话节点明确交接记忆所有权", runner.includes("memoryManagedByWorkflow: true"));

console.log("\n插件边界：仅保留全局启用和工作流逐轮覆盖");
/* 【T68】这 4 条原本是 `includes(源码)` 的文本匹配，正负方向都不可靠：
 *   - 肯定断言在代码被**注释掉**时仍为真（注释里有那个字符串）；
 *   - 否定断言在名字被写进**注释/字符串**时也为真。
 * 全部换成 AST 判据，每条带正控（证明 finder 能工作）与反控（证明它不认文本）。 */
{
  // ── ① `!runtime.includes("session.activePluginNames")`（否定） ──
  const rtSf = parseSource("src/main/claude/RuntimeManager.ts", runtime);
  const hits = findPropertyAccesses(rtSf, "session", "activePluginNames")
    .concat(findIdentifiers(rtSf, "activePluginNames").map((h) => ({ called: false, optional: false, line: h.line })));
  check("★ RuntimeManager 不再读取会话插件名单（AST：找不到 activePluginNames 标识符）",
    hits.length === 0, { found: hits.length, at: hits.slice(0, 3) });
  // 正控：同一个 finder 去一个**确定含**它的输入上跑，必须命中。
  const knownHit = findIdentifiers(parseSource("control.ts", `const x = { activePluginNames: [] };`), "activePluginNames");
  check("★ 正控①：同一 finder 在已知含该名字的源码上能命中（证明它不是恒假）",
    knownHit.length >= 1, { found: knownHit.length });
  // 反控：把名字塞进字符串字面量，必须不命中（`includes` 会在这里假绿）。
  const strOnly = findIdentifiers(fakeSourceWithTextOnly("string", "session.activePluginNames"), "activePluginNames");
  check("★ 反控①：字符串字面量里的同名文本不算命中（`includes` 犯的错）",
    strOnly.length === 0, { found: strOnly.length });

  // ── ② `runtime.includes("pluginNames: input.pluginNames,")`（肯定） ──
  // 注意同文件里还有 `pluginNames?: string[];`（PropertySignature，类型注解）—— 不能算命中。
  const assignments = findPropertyAssignments(rtSf, "pluginNames");
  const withInputValue = assignments.filter((a) => a.valueText === "input.pluginNames");
  check("★ 工作流逐轮插件名单原样交给 provider（AST：PropertyAssignment，不是类型注解）",
    withInputValue.length >= 1, { all: assignments });
  // 正控：PropertySignature（类型注解）必须**不**被这条 finder 计入。
  const sigOnly = findPropertyAssignments(parseSource("sig.ts", `interface X { pluginNames?: string[]; }`), "pluginNames");
  check("★ 正控②：类型注解 pluginNames?: string[] 不被当成赋值（证明区分了 PropertySignature）",
    sigOnly.length === 0, { found: sigOnly.length });
  // 反控：赋值形状只出现在注释里时，必须不命中。
  const cmtOnly = findPropertyAssignments(fakeSourceWithTextOnly("comment", "pluginNames: input.pluginNames,"), "pluginNames");
  check("★ 反控②：注释里的赋值形状不算命中", cmtOnly.length === 0, { found: cmtOnly.length });

  // ── ③ `!source(".../session.ts").includes("activePluginNames")`（否定） ──
  const contractSf = parseFile("../../packages/contracts/src/session.ts");
  const contractHits = findIdentifiers(contractSf, "activePluginNames");
  check("★ Session 契约不再包含会话插件名单（AST：标识符零命中）",
    contractHits.length === 0, { found: contractHits.length });
  check("★ 正控③：同一 finder 在已知含该名字的源码上能命中",
    findIdentifiers(parseSource("c.ts", `type T = { activePluginNames: string[] };`), "activePluginNames").length >= 1);
  check("★ 反控③：注释里的同名文本不算命中",
    findIdentifiers(fakeSourceWithTextOnly("comment", "activePluginNames"), "activePluginNames").length === 0);

  // ── ④ `!source(".../sessionSchema.ts").includes("active_plugin_names")`（否定） ──
  const schemaSf = parseFile("src/main/store/sessionSchema.ts");
  const schemaHits = findIdentifiers(schemaSf, "active_plugin_names");
  check("★ 会话持久化不再迁移/读写插件名单（AST：标识符零命中）",
    schemaHits.length === 0, { found: schemaHits.length });
  check("★ 正控④：同一 finder 在已知含该名字的源码上能命中",
    findIdentifiers(parseSource("s.ts", `const active_plugin_names = 1;`), "active_plugin_names").length >= 1);
  check("★ 反控④：字符串字面量里的同名文本不算命中",
    findIdentifiers(fakeSourceWithTextOnly("string", "active_plugin_names"), "active_plugin_names").length === 0);
}

// 【T64】「全局插件 handler 继续注册」这条从 `includes(源码)` 改成 **AST 判据**。
//
// 原来的写法 `source("src/main/ipc/index.ts").includes("registerPluginsHandlers(ipc)")`
// 是**空过**的（T61 变异实测：把这一行注释掉，套件仍 56/56 全绿）——因为
// `// registerPluginsHandlers(ipc);` 里那个字符串照样能被 `includes` 命中。
//
// 现在用 TypeScript 编译器 API 解析出 AST，只认**真实的 CallExpression 节点**：
//   - 注释 → 不在 AST 里，匹配不到 ✓
//   - 字符串字面量 → 是 StringLiteral 节点，不是 CallExpression ✓
//   - 被注释掉的代码 → 不在 AST 里 ✓
// 这样「注释掉这行」会让断言真的变红。
{
  const rel = "src/main/ipc/index.ts";
  const text = source(rel);
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  /** 找出所有「叫 <name> 的调用表达式」，返回参数个数与首参文本（用于断言形状）。 */
  const findCalls = (name: string): Array<{ argCount: number; firstArg: string }> => {
    const out: Array<{ argCount: number; firstArg: string }> = [];
    const visit = (node: TS.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const calleeName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (calleeName === name) {
          out.push({
            argCount: node.arguments.length,
            firstArg: node.arguments[0]?.getText(sf) ?? "",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  };

  const pluginCalls = findCalls("registerPluginsHandlers");
  // ① 必须**恰好一次**真实调用（不是 0 次 = 被注释/删掉，也不是 2 次 = 重复注册）
  check("★ 全局插件 handler 继续注册（AST：真实调用恰好 1 次，不是注释里的字符串）",
    pluginCalls.length === 1,
    { found: pluginCalls.length, hint: pluginCalls.length === 0 ? "被注释或删除了" : "重复调用" });
  // ② 形状：拿 IpcMain 当唯一参数（`registerPluginsHandlers(ipc)`）
  check("★ 插件 handler 的调用形状是 registerPluginsHandlers(ipc)",
    pluginCalls.length === 1 && pluginCalls[0]!.argCount === 1 && pluginCalls[0]!.firstArg === "ipc",
    pluginCalls);

  // ③ 正控：同一个 AST 解析器在同一份文件里必须能找到确定存在的调用 ——
  // 否则「找不到 registerPluginsHandlers」可能只是解析器坏了，而不是代码没了。
  const controlCalls = findCalls("registerDocumentHandlers");
  check("★ 正控：AST 解析器在同一文件里能找到另一处真实调用（证明判据不是恒假）",
    controlCalls.length >= 1, { found: controlCalls.length });

  // ④ 反控：把这段源码**当成字符串**传进来，结论必须是「找不到调用」——
  // 证明判据确实区分「代码」与「文本里出现这个名字」。
  const asStringSf = ts.createSourceFile("probe.ts", `const x = "registerPluginsHandlers(ipc)";`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let stringHits = 0;
  const visitStr = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      const n = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
      if (n === "registerPluginsHandlers") stringHits++;
    }
    ts.forEachChild(node, visitStr);
  };
  visitStr(asStringSf);
  check("★ 反控：字符串字面量里的同名文本**不算**调用（这正是 includes 犯的错）",
    stringHits === 0, { hits: stringHits });
}


console.log("\n三引擎一致消费");
// 【T68】「Codex 请求超时定时器 unref」从 `includes("timer.unref")` 改成 AST 判据。
//
// ⚠️ 这条的原位证据：`CodexAppServerClient.ts:165` 的**注释**里就写着 `.unref()` ——
// 一行注释就能让 `includes` 永远为真。AST 里注释根本不存在，骗不过去。
{
  const codexSf = parseFile("src/main/providers/codex-sdk/CodexAppServerClient.ts");
  const unrefs = findPropertyAccesses(codexSf, "timer", "unref");
  check("★ Codex app-server 请求超时定时器 unref（AST：真实的 timer.unref 调用）",
    unrefs.length >= 1 && unrefs.some((u) => u.called),
    { found: unrefs });
  // 正控：同一 finder 在已知含该调用的源码上必须命中。
  check("★ 正控⑤：同一 finder 在已知含 timer.unref() 的源码上能命中",
    findPropertyAccesses(parseSource("u.ts", `timer.unref();`), "timer", "unref").some((u) => u.called));
  // 反控：**只出现在注释里**时，必须不命中 —— 这正是原断言的假绿来源。
  const commentOnly = findPropertyAccesses(fakeSourceWithTextOnly("comment", "timer.unref()"), "timer", "unref");
  check("★ 反控⑤：注释里的 timer.unref() 不算命中（原 `includes` 在这里假绿）",
    commentOnly.length === 0, { found: commentOnly.length });
}

// 【T68】「usageHistory 有上限」拆成**两条独立断言**（总控要求：各自能单独红）。
//
// 原来是一条复合断言：`includes("USAGE_HISTORY_LIMIT")` **且** 一段正则。
// 它有两个问题：
//   ① 前半段是文本匹配，常量只被声明/只被注释提到也会绿；
//   ② 后半段的正则把「切片真的用了它」写死了形状，改个写法就红，是脆的。
{
  const rtSf = parseSource("src/main/claude/RuntimeManager.ts", runtime);

  // ⑤-a 声明：常量真的被声明了，且值是个合理的正整数。
  const decls = findConstDeclarations(rtSf, "USAGE_HISTORY_LIMIT");
  const declaredValue = decls.length === 1 ? Number(decls[0]!.initializerText) : NaN;
  check("★ usageHistory 上限常量已声明且值是正整数（AST：const 声明）",
    decls.length === 1 && Number.isInteger(declaredValue) && declaredValue > 0,
    { declarations: decls, parsed: declaredValue });
  check("★ 正控⑥a：同一 finder 在已知含 const 声明的源码上能命中",
    findConstDeclarations(parseSource("d.ts", `const USAGE_HISTORY_LIMIT = 200;`), "USAGE_HISTORY_LIMIT").length === 1);
  check("★ 反控⑥a：注释里的同名声明不算命中",
    findConstDeclarations(fakeSourceWithTextOnly("comment", "const USAGE_HISTORY_LIMIT = 200;"), "USAGE_HISTORY_LIMIT").length === 0);

  // ⑤-b 使用：`slice(-USAGE_HISTORY_LIMIT)` 真的以该常量为界。
  // **这条与上面独立**：常量声明了但没人用，这里会单独红。
  const sliceUses = findSliceWithNegated(rtSf, "USAGE_HISTORY_LIMIT");
  check("★ usageHistory 追加时真的以该常量为界（AST：slice(-USAGE_HISTORY_LIMIT)）",
    sliceUses.length >= 1, { found: sliceUses });
  check("★ 正控⑥b：同一 finder 在已知含该切片的源码上能命中",
    findSliceWithNegated(parseSource("sl.ts", `x = y.slice(-USAGE_HISTORY_LIMIT);`), "USAGE_HISTORY_LIMIT").length === 1);
  check("★ 反控⑥b：字符串里的切片形状不算命中",
    findSliceWithNegated(fakeSourceWithTextOnly("string", "slice(-USAGE_HISTORY_LIMIT)"), "USAGE_HISTORY_LIMIT").length === 0);
}
// peekBackflow 是死 import(只有注释按名字提到它),不该挂在 import 里。
check("RuntimeManager 不再 import 用不到的 peekBackflow", !/import \{[^}]*\bpeekBackflow\b[^}]*\} from "@main\/lib\/pendingBackflow/.test(runtime));
for (const [name, text] of [["Claude", claude], ["Pi", pi], ["Codex", codex]] as const) {
  check(`${name} 用共享 turnContextSections`, text.includes("turnContextSections(req)"));
}
check("Pi 把共享 sections 交给 resource loader 的 system prompt", pi.includes("systemPromptAppends:"));
check("Pi loader 有 systemPromptAppends 入口", piBridge.includes("systemPromptAppends"));
check("Codex 用 developerInstructions 承载共享上下文", codex.includes("developerInstructions"));

console.log("\n记忆敏感信息保护");
check(
  "memory_write 明确禁止密码/API Key/secret 入库",
  memoryServer.includes("密码") && memoryServer.includes("API Key") && /secret/i.test(memoryServer),
);
check("敏感信息只允许记位置/读取方式", memoryServer.includes("只记") && memoryServer.includes("怎么读"));

console.log("\n翻译桥失败不能伪装成登录失败");
// 「handle 丢失时自愈重建」的判据换过一次写法(2026-09 重构):早先是
// `rt.bridgeConfigId && !rt.bridgeHandle` 一个表达式,现在拆成了
// 「已持有(configId 在)→ refreshHeld → localUrl 变了就换 handle」那一路。
// 断言跟着改成匹配现在的形状 —— **不是功能没了,是文本匹配过时了**:
// 那段逻辑在 RuntimeManager 的 `refreshHeld` 分支里(见 `rt.bridgeHandle.localUrl !==`)。
check(
  "bridge handle 丢失时会自愈重建",
  runtime.includes("refreshHeld(") && runtime.includes("rt.bridgeHandle.localUrl !== handle.localUrl"),
);
check("bridge 没 localUrl 时不静默退回上游地址", !runtime.includes("baseUrl: localUrl ?? cfg.baseUrl"));
check("bridge 启动失败给用户真实原因", runtime.includes("自定义模型翻译桥启动失败"));

console.log("\n三引擎一致:上下文快照都带模型名");
// 用量面板 / 上下文环 / 每轮用量记录都读 `snapshot.model`(见 ContextRing 的
// `chat.context.modelLine`、usageStats 的按模型分桶)。Claude 与 Pi 的适配器都往
// 快照里写了模型名,只有 Codex 这条**从来没写过** —— 于是 Codex 会话在用量面板里
// 永远落进"未知模型"那一类,上下文环也不显示模型行。这是"字段一个适配器写了、
// 另一个从来不写"的跨引擎缺口。
{
  const u = { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 500, reasoningOutputTokens: 0 };
  const direct = buildCodexTokenSnapshot(u, 200_000, null, "openai/gpt-5-codex");
  check("Codex 快照带模型名(纯换算)", direct?.model === "openai/gpt-5-codex", direct?.model);

  // 端到端:真适配器收一条 tokenUsage 通知,发出的快照要带模型名。
  const events: Array<{ type: string; snapshot?: { model?: string } }> = [];
  const mkCtx = () => ({ emit: (e: never) => events.push(e), log: { info() {}, warn() {}, error() {}, debug() {} } });
  const snap = { setTurnDiff() {}, async freeze() { return []; } };
  const adapter = new CodexMessageAdapter(
    mkCtx() as never, "s1", snap as never, undefined, undefined, "openai/gpt-5-codex",
  );
  adapter.setMainThreadId("thr-main");
  adapter.handleNotification({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thr-main", turnId: "t", tokenUsage: { last: u, total: u, modelContextWindow: 100_000 } },
  } as never);
  adapter.handleNotification({ method: "turn/completed", params: { threadId: "thr-main", turn: { id: "t", status: "completed" } } } as never);
  const tu = events.filter((e) => e.type === "token-usage.updated");
  check("Codex 适配器发出快照", tu.length > 0, tu.length);
  check("★ Codex 快照带模型名(端到端)", tu[tu.length - 1]?.snapshot?.model === "openai/gpt-5-codex", tu[tu.length - 1]?.snapshot?.model);
}

// 反向钉住:另两家确实都写了(这条能红即说明"一致"这个前提本身被破坏)。
{
  const pi = buildPiTokenSnapshot({ tokens: 3000, contextWindow: 200_000, percent: 1.5 }, undefined, "openai/gpt-4o");
  check("对照:Pi 快照带模型名", pi?.model === "openai/gpt-4o", pi?.model);
}

console.log(`\nprovider-context smoke: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
