/**
 * 上下文托管(设置面板):全局指令 + 记忆编辑器 + 工具上下文占用。
 *
 * 从 `ipc.ts` 按域拆出的新增域(见该文件头)。存储设计见
 * `apps/desktop/src/main/lib/appContext.ts`:
 *  - 全局指令:唯一事实源 `<dataRoot>/context/instructions.md`,保存时物化到
 *    ~/.mcode/CLAUDE.md(claude)并并入 codex 的 CODEX_HOME/AGENTS.md 组装链;
 *    pi 在会话启动时读同一份追加进系统提示词。三引擎消费同一份文本。
 *  - 记忆:CLI 原生 auto-memory 的文件(`~/.mcode/projects/<slug>/memory/
 *    MEMORY.md`),注入是 CLI 自己的事 —— 这一层只做「列出 + 读 + 写」的 UI 托管。
 *  - 工具占用:按引擎静态枚举 Mcode 可控的工具 schema,chars/4 估算。
 *
 * ⚠️ `slug` 会拼进文件路径,必须是 CLI 项目目录名的保守字符集 —— schema 在这
 * 一层就挡住路径穿越,主进程不做二次发明。
 */

import { z } from "zod";

/** CLI 的项目目录名(路径中每个非 `[A-Za-z0-9-]` 字符折成一个 `-`)。 */
const SLUG_RE = /^[A-Za-z0-9_-]+$/;

/** 读全局指令。内容为空串表示「从未配置」。 */
export const ContextGetSchema = z.object({});
export type ContextGetInput = z.infer<typeof ContextGetSchema>;

/** 保存全局指令。主进程原子落盘并同步物化目标(见 appContext.materialize)。 */
export const ContextSaveSchema = z.object({
  content: z.string().max(200_000),
});
export type ContextSaveInput = z.infer<typeof ContextSaveSchema>;

/** 记忆编辑器的一行目录。`slug` 是 CLI 的项目目录名;`label` 是尽力反查出的
 *  可读名(已知项目路径按同一 slug 规则匹配),反查不上就原样显示 slug。 */
export interface ContextMemoryDir {
  slug: string;
  label: string;
  /** MEMORY.md 最后修改时间(epoch ms);没有记忆文件时为 null。 */
  updatedAt: number | null;
}

export const ContextMemoriesListSchema = z.object({});
export type ContextMemoriesListInput = z.infer<typeof ContextMemoriesListSchema>;

export const ContextMemoryGetSchema = z.object({
  slug: z.string().regex(SLUG_RE, "invalid project slug"),
});
export type ContextMemoryGetInput = z.infer<typeof ContextMemoryGetSchema>;

export const ContextMemorySaveSchema = z.object({
  slug: z.string().regex(SLUG_RE, "invalid project slug"),
  content: z.string().max(200_000),
});
export type ContextMemorySaveInput = z.infer<typeof ContextMemorySaveSchema>;

/* ── 工具上下文占用(设置面板) ──
 *  按引擎静态枚举 Mcode 可控部分的工具 schema,chars/4 估算 token。
 *  引擎内置工具由 CLI 注入、Mcode 不可控,只给一条说明行不逐个列。 */

export const ToolsUsageEngine = z.enum(["claude", "codex", "pi"]);
export type ToolsUsageEngineId = z.infer<typeof ToolsUsageEngine>;

export const ToolsUsageGetSchema = z.object({
  engine: ToolsUsageEngine,
});
export type ToolsUsageGetInput = z.infer<typeof ToolsUsageGetSchema>;

/** 工具来源分组。 */
export type ToolUsageSource =
  | "inprocess"
  | "userMcp"
  | "pluginMcp"
  | "builtin";

/** 一条工具占用。`estTokens` 为 null 表示无法静态估算(外部 stdio 服务器
 *  未连接,只有服务器行没有逐工具行)。 */
export interface ToolUsageItem {
  name: string;
  /** 工具的纯文本描述(截断显示用),不进估算。 */
  description?: string;
  estTokens: number | null;
}

/** 一组工具占用 + 组级合计。`note` 是给用户的补充说明(如「需连接后统计」)。 */
export interface ToolUsageGroup {
  source: ToolUsageSource;
  items: ToolUsageItem[];
  totalEstTokens: number;
  note?: string;
}

export interface ToolsUsageResult {
  engine: ToolsUsageEngineId;
  groups: ToolUsageGroup[];
  totalEstTokens: number;
}
