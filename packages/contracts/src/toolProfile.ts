/**
 * **ToolProfile —— 「按任务,哪些工具**应该**可见」的声明式选择层**(MC-100 第二步)。
 *
 * 台账 MC-100 的修复方向是建立统一 **Discovery → Ranking → Context Injection** 链路。
 * `@contracts/effectiveToolInventory` 回答的是链路的第一步(「裁剪之前模型**会**看到哪些
 * 工具、有多大」);这份模块回答第二步的**选择侧**:给定一份有效工具清单与一个「任务画像」,
 * 算出该任务**应该**暴露的**工具名子集**。
 *
 * ## 它是选择层,不是执行层(边界,别越)
 *
 * - **是声明式、纯粹的选择**:只吃 {@link EffectiveToolInventory} 与一个 {@link ToolProfile},
 *   回一串工具名。纯函数,无 I/O,不 import 主进程,不 import `node:crypto`。
 * - **不是**把工具真正塞进/拿出的那一步。Pi 的 `setActiveToolsByName`、Claude 的
 *   `Options.tools`、Codex 的 `dynamicTools` 装配是**后续切片**(见文末 remaining)。
 *   本轮**不改变任何 provider 运行时行为**。
 * - 桶的判定**复用清单已有事实**:清单里每条工具**已经带了**来源标签
 *   ({@link EffectiveToolSource};由装配层 `orchestration/effectiveToolInventory.ts` 算好,
 *   即 `toolNamesOfSource` 用的同一份事实)。这里只做「来源标签 + 名字族 → 桶」的映射,
 *   **绝不另造一份工具名单**(硬规矩 2)。
 *
 * ## 桶与画像(规则显式、可测)
 *
 * 六个桶:{@link ToolBucket}。六个画像:{@link ToolProfileName}。
 *
 * - `minimal`  —— 只留 **always-on 必需集**({@link ESSENTIAL_TOOL_NAMES}):统一发现通道
 *   `app_api_list → app_api_describe → app_api_call`。任何画像都**不会**把它裁掉。
 * - `chat`     —— 会话/规划/UI 类(提问、进出计划模式、待办、子代理、网页读写、UI 口令、技能)。
 * - `code`     —— 文件/编辑/终端(shell)类。
 * - `research` —— 资料库 + 记忆(`library_*` / `memory_*`,或 Claude 的 `mcp:mcode-library` /
 *   `mcp:mcode-memory` 标签)。
 * - `browser`  —— 内建浏览器(`browser_*`,或 `mcp:mcode-browser` 标签)。
 * - `workflow` —— 工作流工具(`workflow_*` / `node_type*` / `session_*` 等,或
 *   `mcp:mcode-workflow` 标签)。
 *
 * 每个画像 = **必需集(floor)** + 自己的桶。这是**最小化**的方向:默认只给最小集,任务需要
 * 更多就换画像或由 `userOverride` 显式追加。
 *
 * ## 安全约束(计划模式 / 审批中,不许被画像裁掉)
 *
 * {@link ESSENTIAL_TOOL_NAMES} 是 **floor**:它在每个画像的允许桶里都恒含,`userOverride`
 * 也**只能加不能减**({@link ToolProfileUserOverride} 只提供 `add`)。这条约束的用意:画像
 * 切换**不能**把「运行时在计划模式/审批中仍需要的工具」藏掉 —— 例如审批流程要用发现通道
 * 回读方法、计划模式要用进出计划模式的工具。选择层据此**永远**保留 floor;真正的装配层
 * (后续切片)还须把「当前正处于审批中」的工具与画像结果做**并集**,这个约束在此显式记录。
 */

import type { EffectiveToolInventory } from "./effectiveToolInventory.js";

/** 任务画像名。决定「除必需集外还允许哪些桶」(见 {@link ToolProfile} 与 `PROFILE_BUCKETS`)。 */
export type ToolProfileName = "minimal" | "chat" | "code" | "research" | "browser" | "workflow";

/** 工具归属的**桶**。画像按桶放行;判定见 {@link classifyToolBucket}。 */
export type ToolBucket = "essential" | "chat" | "code" | "research" | "browser" | "workflow";

/**
 * 用户对画像的**显式追加**。刻意**只有 `add`,没有 `remove`** —— 这是安全设计,不是省事:
 * 若允许 remove,就能削弱 floor、把审批中仍需要的工具从上下文里拿掉。要「少给」请换更小的
 * 画像(如 `minimal`);要「多给」才用这里。`add` 里的名字只有**确实存在于清单**时才会被采纳
 * (不凭空暴露一个清单里没有的工具 —— 见 remaining)。
 */
export interface ToolProfileUserOverride {
  /** 追加暴露的工具名。只增不减;不在清单里的名字被忽略(不静默、但也不虚增)。 */
  add?: readonly string[];
}

/** 一份任务画像:基础画像名 + 可选用户追加。 */
export interface ToolProfile {
  name: ToolProfileName;
  userOverride?: ToolProfileUserOverride;
}

/**
 * **always-on 必需集**(floor)。统一发现通道的三件套 —— 让任何画像都能**按需**把更多能力
 * 找回来(`app_api_list` 查有哪些方法 → `app_api_describe` 看参数 → `app_api_call` 调)。
 * 这正是 MC-100 要的 Discovery 层:最小上下文 + 按需发现,而不是把所有 schema 常驻。
 *
 * 任何画像都**不会**裁掉它们;`userOverride` 也**不能**移除。
 */
export const ESSENTIAL_TOOL_NAMES: readonly string[] = ["app_api_call", "app_api_describe", "app_api_list"];

/**
 * 每个画像**特有**的允许桶。刻意**不含** `essential` —— 必需集(floor)由
 * {@link selectToolsForProfile} 里那个「与画像无关、恒加 {@link ESSENTIAL_TOOL_NAMES}」的
 * 循环单独保证。若在这里再列一遍 `essential`,就是同一条不变量的**两份实现**:画像表改错一项
 * (比如漏掉)会静默藏掉发现通道,而兜底循环本可挡住 —— 留一份、且让它可被冒烟钉住。
 */
const PROFILE_BUCKETS: Record<ToolProfileName, readonly ToolBucket[]> = {
  minimal: [],
  chat: ["chat"],
  code: ["code"],
  research: ["research"],
  browser: ["browser"],
  workflow: ["workflow"],
};

/** 来源标签 → 桶。Claude 侧 MCP server 的工具直接按来源落桶(不按名字猜)。 */
const SOURCE_BUCKET: Record<string, ToolBucket> = {
  "mcp:mcode-browser": "browser",
  "mcp:mcode-library": "research",
  "mcp:mcode-memory": "research",
  "mcp:mcode-workflow": "workflow",
};

const ESSENTIAL_NAMES = new Set<string>(ESSENTIAL_TOOL_NAMES);

/** MCP 工具在 Claude 侧的名字形态:`mcp__<server>__<tool>`。server 名按仓库约定是小写字母/数字/
 *  连字符(如 `mcode-app`)。这里剥掉前缀,把「裸工具名」还给按名的桶判定 —— 否则 Claude 侧
 *  `mcp__mcode-app__app_api_call` 既匹配不上 {@link ESSENTIAL_TOOL_NAMES},又落不进任何名字族,
 *  会被**所有**画像挡在外面(连发现通道都藏了),那是 bug。 */
const MCP_PREFIX = /^mcp__[a-z0-9-]+__/i;

/** 取「裸工具名」:若是 `mcp__<server>__<tool>` 形态则剥前缀,否则原样。 */
export function bareToolName(name: string): string {
  return name.replace(MCP_PREFIX, "");
}

/**
 * 名字族 → 桶的**前缀**规则(按序,先命中先用)。给**没有 MCP 来源标签**的引擎兜底:
 * Codex/Pi 的工具全标 `dynamic`,来源分不出库 / 记忆 / 浏览器,只能按名字族分。判定用的是
 * {@link bareToolName}(剥过 MCP 前缀)。
 */
const NAME_PREFIX_BUCKETS: ReadonlyArray<readonly [string, ToolBucket]> = [
  ["library_", "research"],
  ["memory_", "research"],
  ["browser_", "browser"],
  ["workflow_", "workflow"],
  ["node_type", "workflow"],
  ["session_", "workflow"],
  // `agent_` 成族的文件/进程/ssh 工具 —— 默认归 code(少数几个非 code 的在下面按整名列出)。
  ["agent_", "code"],
];

/** 精确名 → 桶。补前缀规则盖不到的零散工具(整名优先于前缀)。 */
const NAME_EXACT_BUCKETS: Record<string, ToolBucket> = {
  // 文件/编辑/终端(各引擎内置 + Pi 内置)。
  Bash: "code", BashOutput: "code", KillShell: "code",
  Read: "code", Edit: "code", Write: "code", MultiEdit: "code", NotebookEdit: "code",
  Glob: "code", Grep: "code",
  read: "code", write: "code", edit: "code", bash: "code", grep: "code", find: "code", ls: "code",
  // 会话/规划/UI/网页端。
  AskUserQuestion: "chat", EnterPlanMode: "chat", ExitPlanMode: "chat", TodoWrite: "chat", Task: "chat",
  WebFetch: "chat", WebSearch: "chat",
  app_ui_state: "chat", app_ui: "chat", app_panel_api_list: "chat",
  app_session_new: "chat", app_session_send: "chat",
  agent_skill_list: "chat", agent_skill_read: "chat",
  // 环境/资料概况 —— 偏研究侧(列当前项目与资料库有哪些条目)。
  agent_context: "research",
  // 工作流桶里名字不带 `workflow_`/`node_type`/`session_` 前缀的几件。
  agent_profiles_list: "workflow", agent_profile_save: "workflow", agent_profile_remove: "workflow",
  agent_peers: "workflow", agent_notify: "workflow", agent_ask: "workflow",
  app_workflow_run: "workflow",
};

/**
 * 把一条工具归桶。**先看来源标签**(可靠),再看名字(内置 / 动态注入的各族)。认不出 →
 * 回 `null`(未知),任何画像都**不会**自动选中它 —— 「未知名字绝不静默加入」。
 */
export function classifyToolBucket(name: string, source: string): ToolBucket | null {
  const bySource = SOURCE_BUCKET[source];
  if (bySource) return bySource;
  // 按名判定统一用裸名(剥掉 Claude 的 `mcp__<server>__` 前缀),这样内置/动态/MCP 三形态同判。
  const bare = bareToolName(name);
  if (ESSENTIAL_NAMES.has(bare)) return "essential";
  const exact = NAME_EXACT_BUCKETS[bare];
  if (exact) return exact;
  for (const [prefix, bucket] of NAME_PREFIX_BUCKETS) {
    if (bare.startsWith(prefix)) return bucket;
  }
  return null;
}

/**
 * **按画像选工具名**。给定有效工具清单与画像,回该任务**应该**暴露的工具名(升序、去重)。
 *
 * 规则:
 *  1. 清单里每条工具按其桶是否属于该画像的允许桶而定(见 `PROFILE_BUCKETS`)。
 *  2. `essential`(floor)**与画像无关,恒含** —— 单独一条规则,不写进画像表。这条保证任何
 *     画像切换都不会藏掉发现通道(计划模式/审批中的安全约束)。
 *  3. 认不出桶的工具**永不自动加入**(未知名字不静默暴露)。
 *  4. `profile.userOverride.add` 里的名字**追加**暴露 —— 只在它确实存在于清单时生效;不会
 *     移除任何东西,故 floor 不受影响(安全约束)。
 */
export function selectToolsForProfile(
  inventory: EffectiveToolInventory,
  profile: ToolProfile,
): string[] {
  const allowed = new Set<ToolBucket>(PROFILE_BUCKETS[profile.name]);
  const present = new Set(inventory.tools.map((t) => t.name));
  const selected = new Set<string>();

  for (const tool of inventory.tools) {
    const bucket = classifyToolBucket(tool.name, tool.source);
    // floor:必需集与画像无关,恒含(与 PROFILE_BUCKETS 那张表分开,确保改画像表也藏不掉
    // 发现通道)。这条只此一处,不在画像表里再列一遍同一事实。
    if (bucket === "essential") {
      selected.add(tool.name);
      continue;
    }
    if (bucket !== null && allowed.has(bucket)) selected.add(tool.name);
  }
  // 用户追加:只加不删;只认清单里存在的名字(不凭空暴露不存在的工具)。
  for (const name of profile.userOverride?.add ?? []) {
    if (present.has(name)) selected.add(name);
  }

  return [...selected].sort();
}

/**
 * 便捷:某画像**有效**的桶 = `essential`(floor)+ 该画像特有的桶。供诊断 / 冒烟断言。
 * 注意 floor 单独加,与 {@link selectToolsForProfile} 里那条恒定规则同源(PROFILE_BUCKETS
 * 本身不含 `essential`)。
 */
export function bucketsForProfile(name: ToolProfileName): readonly ToolBucket[] {
  return ["essential", ...PROFILE_BUCKETS[name]];
}
