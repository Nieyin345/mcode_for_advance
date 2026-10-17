/**
 * 「能力 × 引擎」矩阵 —— **一处集中说明**三个引擎各自支持哪些能力面。
 *
 * ## 为什么要有它
 *
 * 三个引擎（Claude / Codex / Pi）的能力面并不对等：谁支持斜杠命令、谁支持子代理、
 * 谁支持 MCP、谁带引擎原生 hooks —— 这些事实**散在各处**（技能页的技能矩阵、MCP 页的
 * 引擎可见矩阵、插件页的投递表、引擎工具页的「Codex 不支持勾选」提示）。想让用户
 * 「一眼看清某个引擎到底能干什么」，得先把这些页翻一遍拼起来。这一份数据就是那个
 * 拼好的结果，`EngineToolsPanel` 把它渲染成一张只读表。
 *
 * ## 它是什么、不是什么
 *
 * - **只读的说明**，不是控件。它不改变任何投递逻辑，也不新增 IPC —— 开关仍在各自的
 *   面板里（技能矩阵在技能页、引擎可见性在 MCP 页、内置工具在下面的引擎卡片里）。
 * - 数据本身的**真相在各 provider / 各矩阵模块**，这一份是它们的**汇总视图**。
 *   `scripts/engine-capability-matrix-smoke` 会把它与真实来源对账：任一处能力翻转、
 *   这里没跟着改，套件就红 —— 汇总视图不许与来源漂移。
 *
 * ## 纯模块
 *
 * 不 import React / `api` / i18n **运行时**（只 `import type` 取 `MessageId`，编译期
 * 擦除）。所以无头 smoke 可以直接 bundle 本文件在 node 下跑，不起浏览器、不碰 Electron。
 */
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { BASE_TOOL_CAPABILITIES, type BaseToolCapabilityRow } from "@contracts/baseToolCapabilities";
import type { EngineToolEngineId } from "@contracts/ipc/engineTools";

/** 矩阵的列（引擎），顺序 = 界面列顺序。 */
export const ENGINE_CAPABILITY_ENGINES = ["claude", "codex", "pi"] as const;
export type MatrixEngineId = (typeof ENGINE_CAPABILITY_ENGINES)[number];

/** 一行能力：一行标签 + 每个引擎的「支持 / 不支持」。 */
export interface CapabilityRow {
  /** 行标签的词条键（`settings.engineMatrix.cap.*`）。 */
  labelKey: MessageId;
  /** 可选的补充说明词条键，渲染在标签下方的小字。 */
  noteKey?: MessageId;
  /** 每个引擎的支持情况，键与 {@link ENGINE_CAPABILITY_ENGINES} 对齐。 */
  support: Record<MatrixEngineId, boolean>;
}

/**
 * 能力 × 引擎矩阵。**每格的事实出处**（改这里前先回去核对）：
 *
 * - 技能：`lib/skillEngines.ts` 的 `SKILL_ENGINES`（claude/codex/pi 三引擎共用一个技能库）。
 * - 斜杠命令：各 provider 的 `listCommands()` —— 只有 Claude 返回 `supported: true`
 *   （走 SDK 的 `supportedCommands()`）；Codex / Pi 明确返回 `supported: false`
 *   （它们的命令由各自 TUI 本地解析，不经过 Mcode 走的协议）。
 * - 子代理：`ProviderCapabilities.supportsCustomSubagents` —— 只有 Claude 声明（读
 *   `claude.subagents` 交给 SDK 的 `Options.agents`）。
 * - MCP：`ProviderCapabilities.supportsMcp` + `lib/mcpEngines.ts` 的 `MCP_ENGINES`
 *   —— claude/codex 有；pi 没有（用 extension，不用 MCP server）。
 * - 引擎原生 / 插件钩子：`@contracts/plugin` 说明 v1 里 claude 侧用 `disableAllHooks`
 *   一律关掉，「没有哪个 Mcode 引擎能跑它们」；Codex / Pi 的清单里 hooks 也只是展示。
 *   三个引擎都**不执行**。
 * - 按名禁用内置工具：`lib/engineToolPolicy.ts` 的 `engineSupportsToolExclusion`
 *   —— Claude（disallowedTools）、Pi（excludeTools）能；Codex 只有沙箱/审批档，不能。
 */
export const ENGINE_CAPABILITY_MATRIX: readonly CapabilityRow[] = [
  {
    labelKey: "settings.engineMatrix.cap.skills",
    support: { claude: true, codex: true, pi: true },
  },
  {
    labelKey: "settings.engineMatrix.cap.commands",
    support: { claude: true, codex: false, pi: false },
  },
  {
    labelKey: "settings.engineMatrix.cap.subagents",
    noteKey: "settings.engineMatrix.cap.subagentsNote",
    support: { claude: true, codex: false, pi: false },
  },
  {
    labelKey: "settings.engineMatrix.cap.mcp",
    support: { claude: true, codex: true, pi: false },
  },
  {
    labelKey: "settings.engineMatrix.cap.hooks",
    noteKey: "settings.engineMatrix.cap.hooksNote",
    support: { claude: false, codex: false, pi: false },
  },
  {
    labelKey: "settings.engineMatrix.cap.toolExclusion",
    support: { claude: true, codex: false, pi: true },
  },
];

/** 某一行在某引擎上是否支持 —— 纯粹是给渲染与断言用的读法，
 *  避免调用方各自 `row.support[engine]` 拼下标。 */
export function supportsCapability(row: CapabilityRow, engine: MatrixEngineId): boolean {
  return row.support[engine] === true;
}

/* ── 【ARC-003】基础能力语义表（读写/搜索/命令/联网/浏览器/文档读取）───────────
 *
 * 上面那张矩阵回答「引擎**层面**支持什么」（技能/命令/子代理/MCP/hooks/按名禁用）；
 * 它回答不了用户更常问的那句「这个引擎的**读文件/跑命令/上网**到底用哪个工具」。
 * 那一层的事实声明在契约 `@contracts/baseToolCapabilities`（三家共享一份），这里只做
 * 视图适配：
 *   - 行：稳定能力 ID → 词条键；
 *   - 格：`native` / `bridge` / `none` 三态（**不再是布尔**——"引擎没有原生工具但
 *     宿主桥补上了"与"真的没有"是两件事，UI 必须分得开，这是台账要求
 *     "展示原生/宿主桥/不支持"）。
 */

/** 一行基础能力的展示视图。 */
export interface BaseToolCapabilityViewRow {
  /** 词条键 `settings.engineMatrix.base.<id>`。 */
  labelKey: MessageId;
  /** 契约那一行（原样引用，不复制——唯一事实源仍在契约包）。 */
  source: BaseToolCapabilityRow;
}

const BASE_CAPABILITY_LABEL_KEYS: Record<BaseToolCapabilityRow["id"], MessageId> = {
  "file.read": "settings.engineMatrix.base.fileRead",
  "file.write": "settings.engineMatrix.base.fileWrite",
  "file.edit": "settings.engineMatrix.base.fileEdit",
  "file.search": "settings.engineMatrix.base.fileSearch",
  "shell.run": "settings.engineMatrix.base.shellRun",
  "web.fetch": "settings.engineMatrix.base.webFetch",
  "web.search": "settings.engineMatrix.base.webSearch",
  "browser.navigate": "settings.engineMatrix.base.browserNavigate",
  "document.read": "settings.engineMatrix.base.documentRead",
};

/** 基础能力表的渲染视图（与契约同一顺序、同一数据，只补词条键）。 */
export const BASE_TOOL_CAPABILITY_VIEW: readonly BaseToolCapabilityViewRow[] = BASE_TOOL_CAPABILITIES.map((source) => ({
  labelKey: BASE_CAPABILITY_LABEL_KEYS[source.id],
  source,
}));

/** 某引擎在某能力上的形态 —— 给 UI 与断言用的读法（与契约字段同名同义）。 */
export function baseCapabilityCell(
  row: BaseToolCapabilityRow,
  engine: MatrixEngineId,
): BaseToolCapabilityRow["engines"][EngineToolEngineId] {
  return row.engines[engine];
}

/** 按能力 ID 取视图行（转出契约的读法，让渲染端测试不必再 import 契约模块两次）。 */
export function baseCapabilityRow(id: BaseToolCapabilityRow["id"]): BaseToolCapabilityRow | undefined {
  return BASE_TOOL_CAPABILITIES.find((r) => r.id === id);
}
