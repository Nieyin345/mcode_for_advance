/**
 * 记忆系统(MEM-01/02/03)的契约 —— 存储、检索注入、维护三件套共用的一份。
 *
 * ## 存储形态是文件,不是数据库
 *
 * 记忆放在**数据根下的 `memory/<类目>/*.md`**,markdown + frontmatter,**人可以直接
 * 用编辑器打开改** —— 这是硬要求,所以不发明二进制格式、不入库。类目固定六类
 * (见 {@link MEMORY_CATEGORIES}),文件引用一律用 memory 根下的相对路径
 * (`rules/cite.md`),换数据根时整树搬走,路径不失义(同文献库存相对路径的理由)。
 *
 * ## 谁消费这份契约
 *
 *  - 主进程 `main/memory/`(store / retrieval / maintenance)—— 实现层;
 *  - IPC handler 与渲染端的记忆面板 —— 入参出参用这里的 schema 与类型;
 *  - `nodeInputBuilders` 的记忆注入 —— 读 {@link MEMORY_PARAM_KEY}。
 */
import { z } from "zod";

/* ── 类目 ── */

/** 记忆类目,**固定六类**。目录即类目,不开放自定义 —— 六个名字同时是安全校验的白名单。 */
export const MEMORY_CATEGORIES = [
  "rules",
  "project",
  "preferences",
  "experiences",
  "failures",
  "decisions",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** 类目的中文标签(检索快照的分组标题、界面列表头用)。 */
export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  rules: "规则",
  project: "项目",
  preferences: "偏好",
  experiences: "经验",
  failures: "教训",
  decisions: "决定",
};

/* ── 文件元信息 ── */

/**
 * 一条记忆文件的元信息 —— `memory.list` 的行。
 *
 * `path` 是 **memory 根下的相对路径**(`<类目>/<文件名>.md`,正斜杠)—— 读/存/删
 * 都按它寻址;`updatedAt` 来自 frontmatter(没有则回落文件 mtime),快照与「过期」
 * 维护都以它排序。
 */
export interface MemoryFileMeta {
  path: string;
  category: string;
  scope?: "legacy" | "global" | "project";
  projectId?: string;
  pinned?: boolean;
  title: string;
  updatedAt: number;
}

/* ── 人工整理（MEM-03）── */

/** 整理只提出候选。digest 覆盖路径、标题、时间和**完整原文**（含 frontmatter）；删除时必须重新核对。 */
export interface MemoryReviewEntry extends MemoryFileMeta {
  preview: string;
  digest: string;
}

/** 疑似重复是一对建议，不是自动合并指令；同标题也可能有不同正文。 */
export interface MemoryReviewPair {
  a: MemoryReviewEntry;
  b: MemoryReviewEntry;
  score: number;
}

export interface MemoryReviewResult {
  stale: MemoryReviewEntry[];
  staleTotal: number;
  staleTruncated: boolean;
  duplicates: MemoryReviewPair[];
  duplicatePairTotal: number;
  pairTruncated: boolean;
  scannedForDuplicates: number;
  duplicateTruncated: boolean;
  /** 正文超长，未纳入相似度比较（可仍因过期而显示）。 */
  tooLong: string[];
  /** 列表中存在、扫描时却无法安全读取；不会给出可删指纹。 */
  unreadable: string[];
  totalFiles: number;
}

/* ── 节点参数 ── */

/**
 * 项目 id 的合法形状 —— **唯一一份**。
 *
 * 主进程的 `memory/paths.ts`(`memoryAddress` 判一个 `projects/<id>/…` 路径是不是项目
 * 记忆)与这里的 `MemoryManageSchema.projectId` 都拿它判同一个东西。从前两处各写一份
 * 字面量,改一处漏一处:放宽一处后,`manage.ts` 的导入会成功,而 `paths.ts` 随后判它
 * "不属于本项目",表现为"导入成功了但 AI 永远搜不到"。
 */
export const MEMORY_PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * 节点参数上「记忆注入」开关的键。params 是字符串记录(界面开关存的就是字符串),
 * 值为 `"on"` / `"true"`(布尔 `true` 也认)时,模型节点的输入会追加记忆快照。
 */
export const MEMORY_PARAM_KEY = "memory";

/* ── 快照 → 提示词里的一节 ── */

/**
 * 拼出来那一节的标题。**只在这里写一次** —— 节点注入(走模型的那几种节点)与
 * 「档案+记忆」建出来的子对话用的是同一个标题,两边各写一遍的话,同一个功能在界面上
 * 会有两种叫法。
 */
export const MEMORY_SECTION_TITLE = "## 长期记忆";

/**
 * 把一份记忆快照拼成**要追加进提示词的一节**。**纯函数**:不碰文件系统、不 import 主
 * 进程的任何东西(理由同 {@link parseAgentProfile} 那条 —— 共享的拼装规则是一份对外
 * 承诺,而且纯函数才喂得进无头脚本)。
 *
 * 快照是空串时也返回空串:库是空的就不该凭空多一个只有标题的空段落。
 *
 * 第二行那句话不是客套:记忆是**背景**,指令是**要求**。不写明白谁大,模型在两者冲突时
 * 会挑记忆里那条(它读起来更像"用户以前说过的话"),而用户看到的是"我明明说了按我的
 * 来,它还是照记忆办"。
 */
export function memorySectionFrom(snapshot: string): string {
  const body = snapshot.trim();
  if (body.length === 0) return "";
  return [
    MEMORY_SECTION_TITLE,
    "以下是记忆库中的既有记录,与本步相关时可参考;与指令冲突时,以指令为准:",
    "",
    body,
  ].join("\n");
}

/* ── IPC 入参 schema ── */

/** `memory:read` / `memory:delete` 的入参:memory 根下的相对路径。 */
export const MemoryPathSchema = z.object({ path: z.string().min(1) });
export type MemoryReadInput = z.infer<typeof MemoryPathSchema>;
/** A missing revision is create-only for save; it never authorizes overwriting/deleting an existing file. */
export const MemoryRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const MemoryDeleteSchema = MemoryPathSchema.extend({ expectedRevision: MemoryRevisionSchema.optional() });
export type MemoryDeleteInput = z.infer<typeof MemoryDeleteSchema>;

/** 仅删除用户**从整理候选中勾选**并确认的一条；过期指纹不允许删除已改动的文件。 */
export const MemoryReviewDeleteSchema = z.object({
  path: z.string().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type MemoryReviewDeleteInput = z.infer<typeof MemoryReviewDeleteSchema>;

/**
 * `memory:save` 的入参。`content` 是**正文**(不含 frontmatter —— 那由主进程生成并
 * 维护,人手改文件时 frontmatter 仍然可读可改);`title` 缺省沿用旧标题,没有旧标题
 * 就从文件名取。
 */
export const MemorySaveSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  title: z.string().optional(),
  expectedRevision: MemoryRevisionSchema.nullable().optional(),
  pinned: z.boolean().optional(),
});
export type MemorySaveInput = z.infer<typeof MemorySaveSchema>;

/** `memory:list` 的可选过滤:不传 = 列全部类目。 */
export const MemoryListSchema = z.object({ category: z.string().optional() });
export type MemoryListInput = z.infer<typeof MemoryListSchema>;

/* ── IPC 渠道 ── */

/**
 * 渠道字符串(与 preload 的 invoke 字符串一致)。运行时契约那边的 `IPC` 常量
 * (`IPC.MEMORY_LIST` 等)**必须取这些值** —— 常量只在主进程注册与 preload 转发两处
 * 出现,字符串本体钉在这里,两边想漂移都没得漂。
 */
export const MEMORY_LIST_CHANNEL = "memory:list";
export const MEMORY_READ_CHANNEL = "memory:read";
export const MEMORY_SAVE_CHANNEL = "memory:save";
export const MEMORY_DELETE_CHANNEL = "memory:delete";
export const MEMORY_CATEGORIES_CHANNEL = "memory:categories";
export const MEMORY_REVIEW_CHANNEL = "memory:review";
export const MEMORY_REVIEW_DELETE_CHANNEL = "memory:reviewDelete";

/** Desktop-only maintenance. Models do not receive this capability. */
export const MEMORY_MANAGE_CHANNEL = "memory:manage";
export const MemoryManageSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("preview"), source: z.string().min(1).max(500) }),
  z.object({ action: z.literal("import"), source: z.string().min(1).max(500), digest: MemoryRevisionSchema,
    category: z.enum(MEMORY_CATEGORIES), projectId: z.string().regex(MEMORY_PROJECT_ID_RE).optional(),
    global: z.boolean(), confirmed: z.literal(true) }),
  z.object({ action: z.literal("history"), id: z.string().min(1).max(100) }),
  z.object({ action: z.literal("restore"), id: z.string().min(1).max(100), digest: MemoryRevisionSchema, confirmed: z.literal(true) }),
]);
export type MemoryManageInput = z.infer<typeof MemoryManageSchema>;
export interface MemoryManageResult {
  ok: boolean; error?: string; content?: string; digest?: string; path?: string;
  sources?: Array<{ id: string; label: string }>;
  projects?: Array<{ id: string; name: string }>;
  history?: Array<{ id: string; path: string; at: number; reason: string }>;
}

/** Attribution only, never an authorization source; raw Markdown is user-editable. */
export interface MemoryWriteOrigin {
  sessionId: string;
  kind: "chat" | "side" | "node" | "automation";
  parentSessionId?: string;
  nodeId?: string;
}

/** One switch interpretation shared by node execution and its renderer control. */
export function isMemoryInjectionEnabled(value: unknown): boolean {
  return value === true || value === "on" || value === "true";
}

/** Host-generated diagnostics, not another memory store or an authorization input.
 * Text is captured before provider dispatch; opening a preview never re-retrieves it. */
export interface MemoryInjectionSection {
  source: "chat" | "workflow" | "creation" | "none";
  state: "included" | "off" | "empty" | "error" | "not-automatic" | "unavailable";
  text: string;
  error?: string;
  previewTruncated?: boolean;
}
export interface MemoryInjectionTrace {
  workflow?: MemoryInjectionSection;
  /** Already included in the final user prompt; retained only for fallback diagnostics. */
  creation?: string;
  nodeId?: string;
  nodeTitle?: string;
  runId?: string;
}
export interface MemoryInjectionReceipt {
  id: string;
  sessionId: string;
  projectId: string;
  kind: MemoryWriteOrigin["kind"];
  title: string;
  turnNumber: number;
  at: number;
  phase: "preparing" | "submitted" | "start-failed";
  nodeId?: string;
  nodeTitle?: string;
  runId?: string;
  sections: MemoryInjectionSection[];
}
