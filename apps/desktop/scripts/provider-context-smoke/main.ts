import { automaticMemoryForTurn } from "@main/memory/policy.js";
/** Provider-neutral prompt/context wiring smoke.
 *
 * 这套专门钉三件很容易“只修 Claude”的事：工作流/角色/主对话记忆三层上下文，
 * 必须由 host 解析一次、三个 provider 各自只负责用同一组 sections 注入。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
check("RuntimeManager 不再读取会话插件名单", !runtime.includes("session.activePluginNames"));
check("工作流逐轮插件名单原样交给 provider", runtime.includes("pluginNames: input.pluginNames,"));
check("Session 契约不再包含会话插件名单", !source("../../packages/contracts/src/session.ts").includes("activePluginNames"));
check("会话持久化不再迁移/读写插件名单", !source("src/main/store/sessionSchema.ts").includes("active_plugin_names"));
check("全局插件 handler 继续注册", source("src/main/ipc/index.ts").includes("registerPluginsHandlers(ipc)"));

console.log("\n三引擎一致消费");
// Codex 请求超时定时器必须 unref,否则一个未回应的请求会把进程钉住最多 120s(退出被拖)。
check("Codex app-server 请求超时定时器 unref(不拖住进程退出)", source("src/main/providers/codex-sdk/CodexAppServerClient.ts").includes("timer.unref"));
// usageHistory 每轮追加一条、整份写回会话行 —— 必须有上限,否则长命对话只涨不落。
check("★ usageHistory 每轮追加时有上限(不无界增长)", runtime.includes("USAGE_HISTORY_LIMIT") && /usageHistory = \[\.\.\.rt\.usageHistory, record\]\.slice\(-USAGE_HISTORY_LIMIT\)/.test(runtime));
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
