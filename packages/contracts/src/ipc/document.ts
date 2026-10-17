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
}
