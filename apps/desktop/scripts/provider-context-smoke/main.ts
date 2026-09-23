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
import { formatEnvSections } from "@main/providers/envPromptFormat.js";

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

const root = resolve(process.cwd());
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const runtime = source("src/main/claude/RuntimeManager.ts");
const claude = source("src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts");
const pi = source("src/main/providers/pi-sdk/PiAgentSdkProvider.ts");
const piBridge = source("src/main/providers/pi-sdk/piSkillBridge.ts");
const codex = source("src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");
const memoryServer = source("src/main/mcp/memoryServer.ts");

console.log("\n主对话记忆边界");
check("只给 chat 自动注记忆", runtime.includes('session.kind === "chat"'));
check("RuntimeManager 把记忆作为独立 memoryPrompt 下传", runtime.includes("memoryPrompt,"));
check("RuntimeManager 把环境作为独立 envPrompt 下传", runtime.includes("envPrompt,") && runtime.includes("buildEnvPrompt("));
check(
  "…且按内容指纹去重（内容没变不重复灌）",
  runtime.includes("envPromptFingerprint") && runtime.includes("lastEnvFingerprint"),
);
check("普通聊天记忆走 memorySectionFrom + memorySnapshotFor", runtime.includes("memorySectionFrom") && runtime.includes("memorySnapshotFor"));

console.log("\nsession-scoped plugin residency");
check("RuntimeManager reads persisted session plugin binding", runtime.includes("session.activePluginNames"));
check("per-turn plugin override wins over session binding", runtime.includes("input.pluginNames ??"));
check("legacy NULL/empty binding stays unrestricted", runtime.includes("session.activePluginNames.length > 0"));

console.log("\n三引擎一致消费");
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

console.log(`\nprovider-context smoke: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
