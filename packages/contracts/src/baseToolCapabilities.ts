/**
 * **基础能力语义表** —— 「读/写/编辑/搜索/命令/联网/浏览器/文档」这类跨引擎能力，
 * 在三家引擎上各自由**哪个真实工具**实现、当前是否可用。
 *
 * ## 为什么需要它（台账 ARC-003 统一设计方案第 1 条）
 *
 * 三个引擎的原生工具名不一样（Claude `Read`、Pi `read`、Codex 走 shell），而且同一种
 * 能力在某个引擎上可能是**宿主桥**提供的（如三家的 `mcp__mcode-agent-tools__agent_read_document`）。
 * 没有一张这样的表时，每一处要"按能力说话"的地方都得自己拼工具名/自己判引擎，
 * 迟早漂移成互相矛盾的广告（MC-044 就是提示词硬编码 Claude 的 `Read`）。
 *
 * ## 它是什么、不是什么
 *
 * - **静态事实声明**：每条是"这个引擎的这项能力由哪个工具承担"（原生名 / 宿主桥名 /
 *   无）。名字必须在**真实的工具表**里存在 —— `base-capability-matrix-smoke` 会拿
 *   `KNOWN_BUILTIN_TOOLS`、浏览器工具规格、agent 桥的只读清单、Codex 动态工具表对账，
 *   任何一处工具改名而这里没跟 → 套件红。
 * - **不是权限**：这里的 available 表示"引擎具备这项能力"，**不**表示"本回合一定
 *   可见或一定可用"。某一轮可能因用户策略被排除、因浏览器开关关闭而未注册、或因
 *   审批/沙箱被拒 —— 那些是**运行时**事实，由 `effectiveToolInventory`（当轮实际
 *   清单）与宿主审批回答。谁要对外声称"可用"，必须把这两层叠加起来看。
 * - **不新增执行层**：表里只有名字，没有任何调用路径（硬规矩：不造第二个 Agent loop）。
 *
 * ## 纯模块
 *
 * 不 import React / electron / 任何主进程模块。契约包、主进程、渲染端、无头 smoke
 * 都能直接消费同一份声明。
 */
import type { EngineToolEngineId } from "./ipc/engineTools.js";

/** 稳定能力 ID —— 跨引擎同一件事用同一个 ID（显示文案由调用方按 ID 取词条）。 */
export const BASE_TOOL_CAPABILITY_IDS = [
  "file.read",
  "file.write",
  "file.edit",
  "file.search",
  "shell.run",
  "web.fetch",
  "web.search",
  "browser.navigate",
  "document.read",
] as const;
export type BaseToolCapabilityId = (typeof BASE_TOOL_CAPABILITY_IDS)[number];

/**
 * 一项能力在某引擎上的实现形态：
 *  - `native`：引擎 SDK 自带的内置工具（名字随引擎不同）；
 *  - `bridge`：Mcode 宿主注册给该引擎的工具（agent 桥 / browser server / 动态工具）；
 *  - `none`：该引擎没有这项能力（如实写，不假装）。
 */
export type CapabilityImplementation = "native" | "bridge" | "none";

/** 一行声明：能力 × 引擎 → 实现形态 + **模型看到的工具名**。 */
export interface BaseToolCapabilityCell {
  implementation: CapabilityImplementation;
  /** 模型实际看到的名字（native 用内置裸名；bridge 用宿主注册名）。`none` 时为空。 */
  toolName: string | null;
  /** 可选说明：为什么没有 / 走哪条路。UI 与诊断可原样展示。 */
  note?: string;
}

export interface BaseToolCapabilityRow {
  id: BaseToolCapabilityId;
  /** 每个引擎一格。 */
  engines: Record<EngineToolEngineId, BaseToolCapabilityCell>;
}

/** agent 桥 server 的工具前缀（Claude 侧为 `mcp__<server>__<tool>`，见下表注释）。 */
const AGENT_BRIDGE_SERVER = "mcode-agent-tools";

/** 宿主 agent 桥的工具在 Claude 的 MCP 形态下长这样（SDK 的暴露约定）。 */
function claudeMcpName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

const native = (toolName: string): BaseToolCapabilityCell => ({ implementation: "native", toolName });
const bridge = (toolName: string): BaseToolCapabilityCell => ({ implementation: "bridge", toolName });
const none = (note: string): BaseToolCapabilityCell => ({ implementation: "none", toolName: null, note });

/** 浏览器工具三家都经宿主注册（browser_* 规格表）；Claude 走 MCP 前缀，Pi/Codex 用裸名。 */
const browserCell = (engine: EngineToolEngineId, tool = "browser_navigate"): BaseToolCapabilityCell =>
  engine === "claude" ? bridge(claudeMcpName("mcode-browser", tool)) : bridge(tool);

/** 文档读取桥（PDF/DOCX/XLSX/PPTX 统一读取）—— 三家同一实现（`agent_read_document`）。 */
const documentCell = (engine: EngineToolEngineId): BaseToolCapabilityCell =>
  engine === "claude" ? bridge(claudeMcpName(AGENT_BRIDGE_SERVER, "agent_read_document")) : bridge("agent_read_document");

/**
 * 能力语义表。**每格的工具名都有真实出处**（改这里前先回去核对）：
 *
 * - Claude 原生：`ipc/engineTools.ts` 的 `KNOWN_BUILTIN_TOOLS.claude`（Read/Write/Edit/
 *   Bash/Glob/Grep/WebFetch/WebSearch）。
 * - Pi 原生：`KNOWN_BUILTIN_TOOLS.pi`（read/write/edit/bash/grep/find/ls）。
 * - Codex：**没有**可命名的文件/搜索/写入工具 —— 它把这些都收在自己的 shell/exec
 *   与 `apply_patch`、`webSearch` item 里，模型侧没有独立工具名。按台账要求如实写
 *   `none` 并注明"走 shell"，**不假称**同名的 Read/Bash 存在。
 * - 浏览器：`browser/agentBrowserTools.ts` 的 18 个 `BROWSER_TOOL_SPECS`；三家注册
 *   方式不同（Claude = MCP server、Pi/Codex = 裸动态工具），但同一份实现。
 * - 文档读取：`mcp/agentEngineBridge.ts` 的 `agent_read_document`，三家都经它补齐
 *   （原生各家视模型而定，台账原文）。
 */
export const BASE_TOOL_CAPABILITIES: readonly BaseToolCapabilityRow[] = [
  {
    id: "file.read",
    engines: {
      claude: native("Read"),
      pi: native("read"),
      codex: none("Codex 没有独立的读文件工具：读写走它自己的 shell/exec。"),
    },
  },
  {
    id: "file.write",
    engines: {
      claude: native("Write"),
      pi: native("write"),
      codex: none("Codex 的写文件通过与 shell 配套的 apply_patch 完成，没有独立工具名。"),
    },
  },
  {
    id: "file.edit",
    engines: {
      claude: native("Edit"),
      pi: native("edit"),
      codex: none("Codex 的修改通过 apply_patch，没有独立工具名。"),
    },
  },
  {
    id: "file.search",
    engines: {
      // Claude 的搜索工具是 Glob/Grep 两个；表里记主入口 Grep（Glob 见 note）。
      claude: { implementation: "native", toolName: "Grep", note: "文件匹配是 Glob，内容搜索是 Grep。" },
      pi: { implementation: "native", toolName: "grep", note: "文件匹配是 find/ls，内容搜索是 grep。" },
      codex: none("Codex 没有独立的搜索工具：搜索经它的 shell 命令完成。"),
    },
  },
  {
    id: "shell.run",
    engines: {
      claude: native("Bash"),
      pi: native("bash"),
      codex: none("Codex 的 shell/exec 不经过宿主命名，由沙箱与审批档约束。"),
    },
  },
  {
    id: "web.fetch",
    engines: {
      claude: native("WebFetch"),
      pi: none("Pi 没有原生网页抓取工具；可改用宿主浏览器工具。"),
      codex: none("Codex 没有独立的网页抓取工具名。"),
    },
  },
  {
    id: "web.search",
    engines: {
      claude: native("WebSearch"),
      pi: none("Pi 没有原生网页搜索工具；可改用宿主浏览器工具。"),
      codex: none("Codex 的 webSearch 是 server 侧 item，模型侧没有独立工具名。"),
    },
  },
  {
    id: "browser.navigate",
    engines: {
      claude: browserCell("claude"),
      pi: browserCell("pi"),
      codex: browserCell("codex"),
    },
  },
  {
    id: "document.read",
    engines: {
      claude: documentCell("claude"),
      pi: documentCell("pi"),
      codex: documentCell("codex"),
    },
  },
];

/** 按能力 ID 取一行（找不到 → undefined，调用方显式处理，不默认造一行）。 */
export function baseToolCapabilityRow(id: BaseToolCapabilityId): BaseToolCapabilityRow | undefined {
  return BASE_TOOL_CAPABILITIES.find((r) => r.id === id);
}

/**
 * 某引擎某能力的工具名（`none` → null）。**名字是按引擎不同的**：要"点名某个工具"
 * 的提示词/诊断一律从这里取，别再硬编码（MC-044 的教训）。
 */
export function baseToolNameFor(engine: EngineToolEngineId, id: BaseToolCapabilityId): string | null {
  return baseToolCapabilityRow(id)?.engines[engine].toolName ?? null;
}
