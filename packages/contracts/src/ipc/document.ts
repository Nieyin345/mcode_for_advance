/**
 * 【ARC-007】**文档能力通道（只读 + 受控写）**的契约。
 *
 * 这是 G0/方案 C 的产品面：把 `genofficeCli` 适配层包成一条 IPC，让
 * 「用户点按钮」与「Agent 经 `app_api_call`」走**同一段代码**（台账硬规矩 2）。
 *
 * ## 为什么先只开这几个方法
 *
 * 台账 ARC-007 的系统性修复要求「以 document.open/read/render/edit/save 抽象宿主
 * 事实」，但每一步替换都要过门（打开→不改→保存字节一致、外部查看器回读）。本切片
 * 先落**可无头验证**的那一半：
 *
 *  - `document.read`：只读列出文档结构（docx 块 / pptx 页 / xlsx 表）；
 *  - `document.edit`：按 GenOffice ops 编辑并保存（**必须**落在工作区内）；
 *  - `document.convert`：格式转换（输出路径同样过围栏）；
 *  - `document.capabilities`：报告本机 GenOffice CLI 在不在、哪些能力需要 headless
 *    宿主 / 原生 sidecar —— UI 与 Agent 都据此给可诊断的"为什么不能用"。
 *
 * 保存的 CAS/版本保护**不在本切片**：CLI 自己读写同一文件，Mcode 侧的
 * `expectedRevision` 要在接入编辑器保存链路时补（计划 B.2），这里不假装有。
 */
import { z } from "zod";

/** 文档格式 —— 与 `@contracts/documentKind` 的种类互补：这里问"用哪个引擎的哪种格式"。 */
export const DocumentFormatSchema = z.enum(["docx", "xlsx", "pptx", "pdf", "markdown", "html"]);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;

const PathSchema = z.string().min(1).max(4096);

export const DocumentReadSchema = z.object({
  /** 绝对路径；必须落在某个已知工作区根内（主进程复核，不采信调用方）。 */
  filePath: PathSchema,
  /** 仅 docx 有效：返回全文而非预览。 */
  full: z.boolean().optional(),
  /** 仅 docx 有效：块索引范围（CLI 语法 `a-b`）。 */
  range: z.string().max(64).optional(),
}).strict();
export type DocumentReadInput = z.infer<typeof DocumentReadSchema>;

export const DocumentEditSchema = z.object({
  filePath: PathSchema,
  /** GenOffice 的 ops 数组（形状由 CLI 校验）。 */
  ops: z.array(z.unknown()).min(1).max(500),
  /** 只演练不写盘。 */
  dryRun: z.boolean().optional(),
  /** docx：把内容编辑记成修订。 */
  track: z.boolean().optional(),
  /**
   * 【ARC-007】**原值版本检查** —— 与 `file.writeFile` 的 `expectedVersion` 同一算法
   * （原始字节的 sha256，见 `fileContentVersion`）。给了就必须与盘上当前一致：
   * 另一端（Agent / 另一个窗口）在此期间改过 → 拒绝且**不执行**，把当前版本带回去。
   * 这让"旧 UI 的自动保存覆盖 Agent 已落盘内容"变成可判定的拒绝，而不是静默丢更新。
   *
   * 可选是兼容取舍（旧调用方不带 = 整份执行）；编辑器保存路径**必须**带。
   */
  expectedRevision: z.string().min(1).max(200).optional(),
}).strict();
export type DocumentEditInput = z.infer<typeof DocumentEditSchema>;

export const DocumentConvertSchema = z.object({
  inputPath: PathSchema,
  to: z.string().min(1).max(16),
  /** 输出路径；必须同样落在已知工作区内。 */
  outputPath: PathSchema,
  force: z.boolean().optional(),
}).strict();
export type DocumentConvertInput = z.infer<typeof DocumentConvertSchema>;

/* ───────────────【T24】文档 AI 工具面：发现 + 调用 + Markdown 载体 + 出图 ───────────────
 *
 * 为什么是「发现」而不是「全量注入」：GenOffice 六编辑器的原生工具实测 139 个
 * （docs 40 / sheets 18 / slides 18 / pdf 45 / markdown 10 / html 8，含伴随 skill），
 * 整批 JSON-Schema 约 138 KB 上下文。这里按 `app_api_list → describe → call` 同构
 * 收成四层：`document.apps` → `document.toolsList` → `document.toolDescribe` →
 * `document.toolCall`；每个编辑器最多 2 个高频读工具常驻。
 *
 * 通道字符串钉在这里（与 documentView.ts 同一写法），IPC 表只引用。 */
export const DOCUMENT_APPS_CHANNEL = "document:apps";
export const DOCUMENT_TOOLS_LIST_CHANNEL = "document:toolsList";
export const DOCUMENT_TOOL_DESCRIBE_CHANNEL = "document:toolDescribe";
export const DOCUMENT_TOOL_CALL_CHANNEL = "document:toolCall";
export const DOCUMENT_MARKDOWN_READ_CHANNEL = "document:markdownRead";
export const DOCUMENT_MARKDOWN_EDIT_CHANNEL = "document:markdownEdit";
export const DOCUMENT_RENDER_CHANNEL = "document:render";

/** 六个编辑器 —— 与 `documentToolCatalog.generated.ts` 的 app 值一致。 */
export const DocumentToolAppSchema = z.enum(["docs", "sheets", "slides", "pdf", "markdown", "html"]);
export type DocumentToolApp = z.infer<typeof DocumentToolAppSchema>;

export const DocumentAppsSchema = z.object({}).strict();
export type DocumentAppsInput = z.infer<typeof DocumentAppsSchema>;

export interface DocumentAppInfo {
  app: DocumentToolApp;
  /** 每个编辑器 ≤2 个常驻读工具名（无需查找即可调）。 */
  residentTools: string[];
  toolCount: number;
  /** CLI 能承载的工具名（文件没开在编辑器里时走这条）。 */
  cliTools: string[];
  /** 该编辑器的 QA 门禁命令（docs/sheets=check，slides=audit）。 */
  qaGates: string[];
}

export interface DocumentAppsResult {
  apps: DocumentAppInfo[];
  /** 目录生成来源（genoffice 快照内 AGENT_TOOLS 等）；快照更新后需重新生成。 */
  catalogSource: string;
  totalTools: number;
}

export const DocumentToolsListSchema = z.object({
  app: DocumentToolAppSchema.optional(),
  query: z.string().max(200).optional(),
  /** 只看能走 CLI 的（文件没开在编辑器里时可用）。 */
  cliOnly: z.boolean().optional(),
}).strict();
export type DocumentToolsListInput = z.infer<typeof DocumentToolsListSchema>;

export interface DocumentToolsListEntry {
  app: DocumentToolApp;
  name: string;
  doc: string;
  resident: boolean;
  route: "cli" | "editor";
}

export interface DocumentToolsListResult {
  total: number;
  shown: number;
  tools: DocumentToolsListEntry[];
  note: string;
}

export const DocumentToolDescribeSchema = z.object({
  tool: z.string().min(1).max(120),
  app: DocumentToolAppSchema.optional(),
  /** full = 强制从 CLI 取 `guide <domain> <op>` 的完整 schema（CLI 承载的 op）。 */
  detail: z.enum(["compact", "full"]).optional(),
}).strict();
export type DocumentToolDescribeInput = z.infer<typeof DocumentToolDescribeSchema>;

export interface DocumentToolDescribeResult {
  ok: true;
  app: DocumentToolApp;
  tool: string;
  doc: string;
  /** 参数/示例正文（CLI guide 的原文或目录里的说明）。 */
  schemaText: string;
  route: "cli" | "editor";
  /** 该工具是否超出 T86 请求级契约（withheld），以及原因。 */
  withheld?: string;
}
export type DocumentToolDescribeReply =
  | DocumentToolDescribeResult
  | { ok: false; reason: string; suggestions?: string[] };

export const DocumentToolCallSchema = z.object({
  tool: z.string().min(1).max(120),
  app: DocumentToolAppSchema.optional(),
  /** 绝对路径；必须落在已知工作区内。 */
  filePath: PathSchema,
  input: z.record(z.string(), z.unknown()).optional(),
  /** 只演练（CLI apply --dry-run）；renderer 路线不支持 dryRun。 */
  dryRun: z.boolean().optional(),
  /** 把编辑记成 Word 修订（仅 docs apply 支持）。默认 true：AI 的每次修改都可逐条接受/拒绝。 */
  track: z.boolean().optional(),
}).strict();
export type DocumentToolCallInput = z.infer<typeof DocumentToolCallSchema>;

export interface DocumentQaReportWire {
  gate: "check" | "audit";
  ok: boolean;
  issues: unknown[];
  counts?: Record<string, number>;
  summary?: string;
}

export interface DocumentToolCallResultOk {
  ok: true;
  route: "renderer" | "cli";
  /** 给模型看的正文（含执行结果摘要）。 */
  text: string;
  /** 编辑是否落盘。 */
  mutated: boolean;
  /** 编辑后强制跑的 QA 门禁结果（没编辑或缺省时没有）。 */
  qa?: DocumentQaReportWire;
  /** render 产出的 PNG 绝对路径（出图成功时）。 */
  images?: string[];
  /** 落盘后的内容版本（sha256）。 */
  revision?: string | null;
}
export type DocumentToolCallResult =
  | DocumentToolCallResultOk
  | {
      ok: false;
      kind: "refused" | "unavailable" | "failed" | "conflict";
      reason: string;
      qa?: DocumentQaReportWire;
      suggestions?: string[];
    };

export const DocumentMarkdownReadSchema = z.object({
  filePath: PathSchema,
  /** 只读这些块区间（0-based，形如 "3-7"）；缺省整篇。 */
  range: z.string().max(32).optional(),
}).strict();
export type DocumentMarkdownReadInput = z.infer<typeof DocumentMarkdownReadSchema>;

export interface DocumentMarkdownReadResultOk {
  ok: true;
  filePath: string;
  /** 带定位符注释（`<!-- b3 -->`）的 Markdown。 */
  markdown: string;
  blocks: number;
  revision: string | null;
}
export type DocumentMarkdownReadResult =
  | DocumentMarkdownReadResultOk
  | { ok: false; kind: "refused" | "unavailable" | "failed"; reason: string };

/** Markdown 编辑：定位符来自 `document.markdownRead` 的注释。 */
export const DocumentMarkdownOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), afterBlock: z.number().int().min(-1), markdown: z.string().min(1).max(200_000) }).strict(),
  z.object({ op: z.literal("append"), markdown: z.string().min(1).max(200_000) }).strict(),
  z.object({
    op: z.literal("replace"),
    startBlock: z.number().int().min(0),
    endBlock: z.number().int().min(0),
    markdown: z.string().min(1).max(200_000),
  }).strict(),
  z.object({
    op: z.literal("delete"),
    startBlock: z.number().int().min(0),
    endBlock: z.number().int().min(0),
  }).strict(),
]);
export type DocumentMarkdownOperation = z.infer<typeof DocumentMarkdownOperationSchema>;

export const DocumentMarkdownEditSchema = z.object({
  filePath: PathSchema,
  operations: z.array(DocumentMarkdownOperationSchema).min(1).max(20),
  /** 记成 Word 修订（默认 true）。 */
  track: z.boolean().optional(),
  /** 只演练，不写盘。 */
  dryRun: z.boolean().optional(),
}).strict();
export type DocumentMarkdownEditInput = z.infer<typeof DocumentMarkdownEditSchema>;

export interface DocumentMarkdownEditResultOk {
  ok: true;
  applied: number;
  /** 写入后的块数（与下一次 markdownRead 的 blocks 一致）。 */
  blocks: number;
  qa?: DocumentQaReportWire;
  revision: string | null;
  text: string;
}
export type DocumentMarkdownEditResult =
  | DocumentMarkdownEditResultOk
  | { ok: false; kind: "refused" | "unavailable" | "failed" | "conflict"; reason: string; qa?: DocumentQaReportWire };

export const DocumentRenderSchema = z.object({
  filePath: PathSchema,
  /** 1-based 页码；缺省整份。 */
  page: z.number().int().min(1).max(2000).optional(),
  scale: z.number().min(0.5).max(4).optional(),
}).strict();
export type DocumentRenderInput = z.infer<typeof DocumentRenderSchema>;

export interface DocumentRenderResultOk {
  ok: true;
  files: string[];
  note: string;
}
export type DocumentRenderResult =
  | DocumentRenderResultOk
  | { ok: false; kind: "refused" | "unavailable" | "failed"; reason: string };


/** 一次文档操作的结果 —— `kind` 区分"拒绝(没执行)"/"能力不可用"/"执行失败"/"成功"。 */
export type DocumentIpcResult =
  | { ok: true; command: string; summary: string | null; detail: unknown; revision?: string | null }
  | {
      ok: false; kind: "refused" | "unavailable" | "failed" | "conflict";
      reason: string; code?: number | string;
      /** conflict 时盘上的当前版本（调用方据此重读后再决定）。 */
      currentRevision?: string | null;
    };

/** 能力报告：CLI 在不在、各格式/路由归哪档。 */
export interface DocumentCapabilities {
  /** CLI bundle 是否可用。 */
  cli: { available: boolean; path: string | null };
  /** 不需要额外宿主即可运行的路由。 */
  local: string[];
  /** 需要 headless Electron（`GENOFFICE_APP_BIN`）的路由。 */
  needsApp: string[];
  /** 需要原生 sidecar（Rust xlsx）/ wasm 的路由。 */
  needsSidecar: string[];
  /** 说明（直接给用户/模型看）。 */
  note: string;
  /** 【ARC-007】各域的 ops 目录（GenOffice `guide <domain> --json` 的说明文本）。
   *  让 Agent 不必猜 op 名；取不到时缺省。 */
  opsGuides?: Record<string, string>;
  /** 【ARC-007 P1/GA1】宿主侧编辑器视图的**打开对端**报告（面板据此决定是否
   *  创建视图，而不是靠"vendor 有没有某个通道"猜）。
   *
   *  - `slides`：宿主装配了 slides 执行器（vendor 解析器 + 保存写回同一份实现）
   *    时为 `true` —— 此时 `.pptx` 的打开链真的可用；
   *  - `docs`：恒为 `true`（`menu:command("open-path")` 是宿主直接下发的）；
   *  - `sheets`：本切片**未接**（`workbook:select` 需要 vendor 的 WorkbookFile
   *    会话，宿主没有对端），恒为 `false`。
   *
   *  ⚠️ 这是**装配事实**，不是"页面有没有某个 API"：只有宿主真的能给出
   *  `OpenResult`/`OpenDocxResult` 时才为 true。 */
  hosts?: { docs: boolean; slides: boolean; sheets: boolean; slidesNative?: boolean; pdf?: boolean; markdown?: boolean; html?: boolean };
}
