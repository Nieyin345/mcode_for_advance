/**
 * 【T24】**文档 AI 工具面**：可发现（document_apps → tools_list → tool_describe → tool_call）
 * + Markdown 操作载体 + 带 QA 门禁的执行。
 *
 * ## 它解决什么
 *
 * 旧面把六编辑器 139 个原生工具的定义整批塞进模型上下文（实测全量 JSON 138 KB），
 * 而且模型拿到的是 renderer 侧的 JSON-Schema/op 数组——它得自己数块索引、自己拼
 * EMU、自己猜 op 名。用户看到的结果就是「改 word 很烂、很丑」。
 *
 * 新面分四层，与既有 `app_api_list → app_api_describe → app_api_call` 同构：
 *
 *  1. `document_apps()` —— 六编辑器、各自常驻读工具、工具数量、CLI 能力；
 *  2. `document_tools_list({app, query?})` —— 按 app 与关键词检索 139 个工具（只给
 *     名称 + 截断说明，不给 schema）；
 *  3. `document_tool_describe({tool, app?})` —— 单个工具的完整参数；CLI 承载的 op
 *     直接取 `genoffice guide <domain> <op>`（永远是 CLI 校验器的那一份）；
 *  4. `document_tool_call({tool, input})` —— 执行。**编辑后强制跑 check/audit**，
 *     把 `detail.issues` 原样回给模型；`render` 出图并回路径 + 图片块。
 *
 * ## 执行走哪条路（与 T0 同一个受信绑定）
 *
 * - **渲染端在跑该文件时**（Docs 视图持有同一路径）→ 走 T0 的 `invokeRendererTool`
 *   通道：Host 发 `tool-call`，渲染端 `AgentSkill.executeTool` 执行，ACK 回同一请求。
 *   这条通路只接受 `DocumentToolCallPorts.invokeRendererTool`（由 `documentViewHost`
 *   的 sender/session/document 绑定注入），本模块**不**自己造 sender 校验。
 * - **否则**（文件没开、或该编辑器没有受信 ACK 通道）→ 走 CLI 等价命令（`docs read/apply`、
 *   `sheet read/apply`、`slides read/apply/audit/render`、`pdf read`、`convert`）。
 *   CLI 路径对每个 op 有白名单：凡是 renderer-only 的 op（例如 insert_chart、@提及的选区
 *   操作）一律**显式拒绝并说明原因**，绝不悄悄降级成「什么都没做但报成功」。
 *
 * ## Markdown 载体（借鉴 docx-cli 的模型，不引入它）
 *
 * `document_md_read({filePath})` 输出**带定位符注释的 Markdown**：每个块的起始行带
 * `<!-- b<index> -->`，表格单元格带 `t0:r1c2` 式定位，模型据此引用块而不必数。
 * `document_md_edit({filePath, operations})` 接受续写/替换/删除，内部把 Markdown
 * 片段经 CLI `convert md→html` 转成 restricted HTML 再交给 `docs apply`——与
 * 编辑器原生工具走同一段文字，不另写一套排版。
 *
 * 安全：所有路径过 `requireWorkspacePath`（与 `document.*` 同一份围栏）；CLI 子进程
 * 不继承宿主环境；渲染端工具调用的每次 `tool_call` 都必须有活跃的受信绑定。
 */
import { extname } from "node:path";
import {
  DOCUMENT_TOOL_CATALOG,
  type DocumentToolApp,
  type DocumentToolCatalogEntry,
} from "./documentToolCatalog.generated.js";
import {
  convertFile,
  docsApply,
  docsRead,
  guideOps,
  pdfRead,
  renderPdfPages,
  type GenofficeResult,
} from "./genofficeCli.js";
import type { GenOfficeNativeToolCall, GenOfficeNativeToolDefinition, GenOfficeNativeToolResult } from "./nativeEditorToolTransport.js";

export type { DocumentToolApp };

const APPS: readonly DocumentToolApp[] = ["docs", "sheets", "slides", "pdf", "markdown", "html"];

/** 每个编辑器常驻（无需查找即可调）的高频读工具。**≤2 个**是卡里的硬约束。 */
export const DOCUMENT_RESIDENT_TOOLS: Readonly<Record<DocumentToolApp, readonly string[]>> = Object.freeze({
  docs: ["get_document_context", "read_blocks"],
  sheets: ["get_workbook_context", "read_range"],
  slides: ["read_slide"],
  pdf: ["read_pages", "search_text"],
  markdown: ["get_document_context", "read_blocks"],
  html: ["get_outline", "read_source"],
});

/** 每次 `document_tool_call` 之后**必须**跑的 QA 门禁（按 app）。
 *
 * 【T43】pdf/markdown/html 原本是空数组。查清上游后的事实：
 *   - **没有** `pdf check` / `markdown check` / `html check` 命令
 *     （`genoffice <command>` 只有 docs / sheet / slides 三家带 check/audit）；
 *   - 但 `render` 是**真的会失败**的：坏 HTML、超限字体、无法排版的文档都会
 *     `conversion_failed` / `app_crashed`。
 *
 * 所以这三个 app 的门禁是 `"render-probe"` —— 它跑真命令、真读返回值，检的是
 * **可渲染性**，不是内容质量。`formatQaReport` 会把这一点写在给模型的正文里，
 * 不冒充 `docs check`（那才是「假门禁」）。
 *
 * `reflection` 表示该格式**没有任何自动化检查**（.md/.txt/源码就是文本，
 * 没有渲染器也没有校验器）—— 如实标注，让调用方知道"改完没人替你检查"。 */
export const DOCUMENT_QA_GATES: Readonly<Record<DocumentToolApp, readonly string[]>> = Object.freeze({
  docs: ["check"],
  sheets: ["check"],
  slides: ["audit"],
  pdf: ["render-probe"],
  markdown: ["render-probe"],
  html: ["render-probe"],
});

/** 门禁名 → 给模型的人话（`formatQaReport` 用它拼表头）。 */
export const DOCUMENT_QA_GATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  check: "内容检查",
  audit: "几何审计",
  "render-probe": "可渲染性检查（原厂渲染器试排一次；检的是能否排版，不是内容质量）",
});

/** 会**改变文件**的工具名（决定要不要在调用后跑 QA 门禁）。 */
const DOCS_MUTATING = new Set([
  "insert_content", "write_document", "replace_blocks", "replace_selection", "apply_ops",
  "accept_changes", "reject_changes", "reply_comment", "resolve_comment", "insert_footnote",
  "insert_endnote", "delete_note", "edit_note", "add_comment", "delete_comment", "insert_image",
  "insert_chart", "edit_chart", "set_header_footer", "set_page_setup", "insert_section_break",
  "define_style", "set_watermark", "insert_text_box", "insert_picture", "create_document",
  "setFont", "setMatchedFont", "setParagraphFormat", "setHeadingLevel", "findReplace",
  "deleteBlocks", "moveBlocks", "setList", "clearList", "setImageProperties", "insertToc",
  "insertField", "insertBookmark", "updateFields", "insertTableRow", "deleteTableRow",
  "insertTableColumn", "deleteTableColumn", "mergeTableCells", "splitTableCell",
  "setTableCellFormat", "setTableStyle", "applyStyle",
]);
const SHEETS_MUTATING = new Set(["propose_operations", "create_document", "merge_attached_workbooks"]);
const SLIDES_MUTATING = new Set([
  "apply_ops", "execute_slide_script", "addBlankSlide", "setText", "setTransform",
  "insert_web_image", "replace_image", "generate_deck", "regenerate_slide", "edit_chart",
]);
const PDF_MUTATING = new Set([
  "markup_text", "add_note", "reply_note", "edit_note", "delete_markup", "delete_note",
  "edit_text", "edit_block", "move_text_block", "insert_text", "add_form_mark",
  "edit_inserted_text", "move_inserted_text", "delete_inserted_text", "insert_image",
  "transform_image", "rotate_image", "replace_image", "flip_image", "set_image_opacity",
  "crop_image", "remove_image_background", "delete_image", "apply_ops", "insert_blank_page",
  "set_page_size", "crop_pages", "extract_pages", "split_pdf", "split_pages", "merge_pages",
  "replace_pages", "set_watermark", "set_header_footer", "create_document",
]);
const MD_MUTATING = new Set(["apply_ops", "write_document", "insert_image", "setFrontmatter"]);
const HTML_MUTATING = new Set(["apply_ops", "write_document", "plan_page", "ask_clarification"]);

const MUTATING: Readonly<Record<DocumentToolApp, ReadonlySet<string>>> = Object.freeze({
  docs: DOCS_MUTATING, sheets: SHEETS_MUTATING, slides: SLIDES_MUTATING,
  pdf: PDF_MUTATING, markdown: MD_MUTATING, html: HTML_MUTATING,
});

export function isMutatingDocumentTool(app: DocumentToolApp, tool: string): boolean {
  return MUTATING[app].has(tool);
}

/**
 * 【T43】**Mcode 自有**的文档工具（不属于 vendor 目录）。
 *
 * `documentToolCatalog.generated.ts` 是从 vendor 快照**生成**的，手改会在下次
 * 重新生成时被冲掉。而 `build_deck` 是 Mcode 这一侧提供的能力（把 PPT 设计
 * 流水线包成一次调用），vendor 里没有同名工具 —— 所以它追加在这里，不写进
 * 生成文件。
 *
 * 为什么必须有它：T24 的目录里 slides 只有 read/apply 一类工具，模型**没有任何
 * 途径新建一个 deck**（T43 缺口二/三/四）。`create_document` 在 docs/sheets/pdf
 * 上都有，唯独 slides 没有 —— 因为 pptx 要走 `--spec <dir>`，需要快照围栏。
 */
const MCCODE_OWNED_TOOLS: readonly DocumentToolCatalogEntry[] = Object.freeze([
  {
    app: "slides",
    name: "build_deck",
    doc:
      "从设计规格目录新建一个 .pptx（上游的设计流水线：style.md + outline.json + pages/NN.json）。" +
      "Mcode 会把 spec 目录快照进受控临时目录再构建（源目录只读），可选出图与几何审计。" +
      "参数：{ specDir, outline?, render?, audit? }。新建 PPT 用这个，不要用 apply_ops 手摆元素。",
    hasParams: true,
  },
]);

/** 目录 = vendor 生成目录 + Mcode 自有工具。**所有读取都必须走这里**，
 *  否则 `build_deck` 会「有路由、查不到」，模型永远调不到（T43 实测踩过）。 */
function allTools(): readonly DocumentToolCatalogEntry[] {
  return [...DOCUMENT_TOOL_CATALOG, ...MCCODE_OWNED_TOOLS];
}

export function documentCatalog(): readonly DocumentToolCatalogEntry[] {
  return allTools();
}

export function documentToolsOf(app: DocumentToolApp): readonly DocumentToolCatalogEntry[] {
  return allTools().filter((entry) => entry.app === app);
}

/** 按 app / 关键词检索（名称子串或说明子串；大小写不敏感）。 */
export function searchDocumentTools(app: DocumentToolApp | undefined, query: string | undefined): readonly DocumentToolCatalogEntry[] {
  const q = query?.trim().toLowerCase();
  return allTools().filter((entry) =>
    (!app || entry.app === app) &&
    (!q || entry.name.toLowerCase().includes(q) || entry.doc.toLowerCase().includes(q)),
  );
}

export function findDocumentTool(tool: string, app?: DocumentToolApp): DocumentToolCatalogEntry | undefined {
  const name = tool.trim();
  const hits = allTools().filter((entry) => entry.name === name || `${entry.app}.${entry.name}` === name);
  if (app) return hits.find((entry) => entry.app === app);
  return hits.length === 1 ? hits[0] : hits[0];
}

/* ───────────────────────── QA 门禁 ───────────────────────── */

export interface DocumentQaIssue {
  code?: string;
  level?: string;
  path?: string;
  message?: string;
  suggest?: unknown;
  [key: string]: unknown;
}

export interface DocumentQaReport {
  gate: "check" | "audit" | "render-probe";
  /** 命令是否成功返回（exit 0 不等于没问题——问题在 issues 里）。 */
  ok: boolean;
  /** `detail.issues` 原样（形状随 app/命令不同，字段见 CLI）。 */
  issues: readonly DocumentQaIssue[];
  counts?: Record<string, number>;
  summary?: string;
  /** 【T43】`render-probe` 专用：这次到底证明了什么、没证明什么。 */
  scope?: string;
  /** 【T43】`render-probe` 出的图（绝对路径）；模型可以接着 render 看。 */
  images?: readonly string[];
}

/** 从 CLI 信封里取 `detail.issues`；`detail` 形状不合预期时显式报错而不是当作“无问题”。 */
export function extractQaReport(gate: "check" | "audit" | "render-probe", result: GenofficeResult): DocumentQaReport {
  if (!result.ok) {
    return { gate, ok: false, issues: [], summary: result.reason };
  }
  const detail = result.envelope.detail;
  const issues = detail !== null && typeof detail === "object" && Array.isArray((detail as { issues?: unknown }).issues)
    ? (detail as { issues: DocumentQaIssue[] }).issues
    : null;
  if (issues === null) {
    // 不许把“没拿到 issues”说成“没问题”：QA 门禁读不到结果就是失败。
    return { gate, ok: false, issues: [], summary: "QA 结果里没有 detail.issues；CLI 信封形状不符，本次视为门禁失败。" };
  }
  const counts = detail !== null && typeof detail === "object"
    ? (detail as { counts?: Record<string, number> }).counts
    : undefined;
  return {
    gate,
    ok: true,
    issues,
    ...(counts ? { counts } : {}),
    ...(result.envelope.summary ? { summary: result.envelope.summary } : {}),
  };
}

/**
 * 【T43】把一次 `render` 的结果解析成门禁报告。
 *
 * `render` 不是 `check`：它没有 `detail.issues`。它能证明的是**能不能排版**，
 * 以及出了几张图。所以这里单独一个解析函数，并且把「证明了什么」写进 `scope` ——
 * `formatQaReport` 会原样带给模型，避免被读成「文档没问题」。
 */
export function extractRenderProbeReport(
  app: DocumentToolApp,
  result: GenofficeResult,
  images: readonly string[],
): DocumentQaReport {
  const scope = `只验证了「${app} 能被原厂渲染器排版成 PNG」（页数 ${images.length}）；` +
    `**没有**检查内容正确性，也**没有**判断排版是否好看。要检查内容请用 render + 人/模型看图，或该格式自己的 check（若存在）。`;
  if (!result.ok) {
    return { gate: "render-probe", ok: false, issues: [], summary: result.reason, scope };
  }
  if (images.length === 0) {
    return {
      gate: "render-probe", ok: false, issues: [], scope,
      summary: "render 报告成功，但一个 PNG 都没有落在盘上；本次视为门禁失败（不把「没出图」当「没问题」）。",
    };
  }
  return {
    gate: "render-probe", ok: true, issues: [], scope,
    ...(result.envelope.summary ? { summary: result.envelope.summary } : {}),
    images: [...images],
  };
}

/** 门禁报告 → 给模型看的一段文字（issues 不缩水，只去掉纯噪声字段）。 */
export function formatQaReport(app: DocumentToolApp, report: DocumentQaReport): string {
  // 【T43】`render-probe` 有自己的措辞：它不是 check/audit，绝不能读成「内容无问题」。
  if (report.gate === "render-probe") {
    const head = `render-probe（${app} 可渲染性）`;
    const state = report.ok ? "通过" : "未通过";
    const lines = [
      `${report.ok ? "✅" : "⚠️"} QA 门禁 ${head}：${state}${report.summary ? `（${report.summary}）` : ""}。`,
      report.scope ? `范围：${report.scope}` : "",
      report.images && report.images.length > 0
        ? `出图：${report.images.length} 张（${report.images.slice(0, 4).join(", ")}${report.images.length > 4 ? " …" : ""}）。要看效果用 document_render。`
        : "",
    ].filter(Boolean);
    return lines.join("\n");
  }
  const head = report.gate === "audit" ? "slides audit" : `${app} check`;
  if (!report.ok) return `⚠️ QA 门禁（${head}）没有跑成：${report.summary ?? "未知原因"}`;
  if (report.issues.length === 0) {
    return `✅ QA 门禁（${head}）：没有发现问题${report.summary ? `（${report.summary}）` : ""}。`;
  }
  const counts = report.counts
    ? `（error ${report.counts.error ?? 0} / warning ${report.counts.warning ?? 0} / info ${report.counts.info ?? 0}）`
    : "";
  const lines = report.issues.slice(0, 40).map((issue) => {
    const where = [issue.path, issue.code].filter(Boolean).join(" ");
    const suggest = issue.suggest !== undefined ? ` 建议：${JSON.stringify(issue.suggest)}` : "";
    return `- ${where || "(未命名问题)"}${issue.message ? `：${issue.message}` : ""}${suggest}`;
  });
  const more = report.issues.length > 40 ? `\n…(还有 ${report.issues.length - 40} 条未列)` : "";
  return `⚠️ QA 门禁（${head}）发现 ${report.issues.length} 个问题${counts}。请修掉后再报完成：\n${lines.join("\n")}${more}`;
}

/* ───────────────────────── 渲染出图 ───────────────────────── */

export interface DocumentRenderResult {
  ok: boolean;
  /** PNG 的绝对路径（受控临时目录）；失败时为空。 */
  files: readonly string[];
  pageCount: number;
  note: string;
}

/** `render` 的落点：只接受**调用方给出的受控临时目录**，不让模型指定任意输出路径。 */
export function renderOutDirFor(tempRoot: string, filePath: string, token: string): string {
  const base = filePath.replace(/[\\/]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  return `${tempRoot.replace(/[\\/]+$/, "")}/${base}-${token}`;
}

/** 把 CLI render 信封解析成路径列表。文件必须真的存在才回报（防“报了路径没出图”）。 */
export function parseRenderFiles(result: GenofficeResult, exists: (path: string) => boolean): DocumentRenderResult {
  if (!result.ok) return { ok: false, files: [], pageCount: 0, note: result.reason };
  const detail = result.envelope.detail;
  const raw = detail !== null && typeof detail === "object" ? (detail as { files?: unknown }).files : null;
  if (!Array.isArray(raw)) return { ok: false, files: [], pageCount: 0, note: "render 结果里没有 detail.files；无法确认出图。" };
  const files: string[] = [];
  for (const item of raw) {
    const path = item !== null && typeof item === "object" ? (item as { path?: unknown }).path : undefined;
    if (typeof path === "string" && exists(path)) files.push(path);
  }
  if (files.length === 0) return { ok: false, files: [], pageCount: 0, note: "render 报告成功，但产出的 PNG 一个都不在盘上；本次视为失败。" };
  return {
    ok: true, files, pageCount: files.length,
    note: `已渲染 ${files.length} 页。图片路径在下面；读不到图时用 agent_read_image 转述。`,
  };
}

/* ───────────────────────── 执行端口 ───────────────────────── */

/**
 * 一次 `document_tool_call` 的执行上下文。`invokeRendererTool` **只能**来自
 * `documentViewHost` 的受信绑定（T0 的 sender/session/document ACK），不接受任意
 * 调用方自造——这是 T24 卡里「不得绕过 T0 校验」的落点。
 */
export interface DocumentToolCallPorts {
  cliPath: string;
  withinWorkspace(path: string): boolean;
  /** 受信渲染端绑定：文件在某个 McCode 文档视图里打开时由宿主注入。 */
  invokeRendererTool?: (call: GenOfficeNativeToolCall, definition: GenOfficeNativeToolDefinition) => Promise<GenOfficeNativeToolResult>;
  /** 该文件当前是否在受信渲染端打开（决定走 renderer 还是 CLI）。 */
  rendererOpen(filePath: string): boolean;
  /** 渲染/临时输出的受控目录（调用方保证在工作区外、可清理）。 */
  tempRoot(): string;
  /** 生成互不相同的临时子目录名。 */
  token(): string;
  signal?: AbortSignal;
}

export interface DocumentCallContext {
  app: DocumentToolApp;
  filePath: string;
  /** 模型给的工具参数。 */
  input: Record<string, unknown>;
}

export interface DocumentCallOutcome {
  ok: boolean;
  /** 给模型看的正文。 */
  text: string;
  /** 执行路径。 */
  route: "renderer" | "cli" | "refused";
  /** 编辑后的 QA 门禁（没编辑或门禁不适用时缺省）。 */
  qa?: DocumentQaReport;
  /** render 出的图（绝对路径）。 */
  images?: readonly string[];
  /** 编辑是否真的落盘（编辑类工具成功 + 非 dryRun）。 */
  mutated?: boolean;
}

/** CLI 里承载该 app 的工具子集（其余工具只能走 renderer）。
 *
 * 【T43】补上「创建」与 PPT 设计流水线：
 *   - `create_document`（docs/sheets/pdf）→ `create`，走 `createFromFile`；
 *   - `build_deck`（slides）→ `create --type pptx --spec`，走 `createDeckFromSpec`
 *     （**带快照围栏**，见 `genofficeCli.snapshotDeckSpec`）。
 *
 * 为什么 `plan_deck` / `generate_deck` 仍然没有 CLI 路由：它们是**编辑器内**工具
 * （`plan_deck` 读活动文档的实时状态、`generate_deck` 依赖 vendor 会话），
 * 上游 CLI 没有等价命令。T43 的处理是**如实标注 `editor-only`**（见
 * `editorOnlyReason`），并给模型一条能真正走通的替代路径（`build_deck` 的
 * 设计流水线）—— 而不是让模型去试一个永远失败的调用。
 */
const CLI_TOOL_MAP: Readonly<Record<DocumentToolApp, Readonly<Record<string, string>>>> = Object.freeze({
  docs: {
    get_document_context: "read", read_blocks: "read", read_revisions: "read-revisions",
    read_comments: "read-comments", read_notes: "read-notes", list_styles: "read-styles",
    insert_content: "apply", replace_blocks: "apply", apply_ops: "apply",
    accept_changes: "apply", reject_changes: "apply",
    create_document: "create",
  },
  sheets: {
    get_workbook_context: "read", read_range: "read", read_cells: "read", read_formats: "read",
    read_sheet_features: "read", aggregate_range: "read", propose_operations: "apply",
    create_document: "create",
  },
  slides: {
    read_slide: "read", apply_ops: "apply", edit_chart: "apply", load_guide: "guide",
    /** 【T43】整份 deck 的设计流水线（spec 目录 → create）。 */
    build_deck: "create",
  },
  pdf: { read_pages: "read", get_outline: "read", create_document: "create" },
  markdown: {},
  html: {},
});

/**
 * 【T43】只在编辑器里存在、CLI 没有等价能力的工具 —— **逐条列明原因**，
 * 让 `document_tools_list` 能标 `route:"editor-only"`，模型不必靠试。
 *
 * 判据：`CLI_TOOL_MAP` 里没有 **且** 它确实依赖编辑器实时状态/云能力。
 * 这张表只覆盖「上游确认只有编辑器能做」的那部分；其余没路由的工具
 * 仍按 CLI 拒绝处理（那条路径已经会显式报错，不是静默失败）。
 */
const EDITOR_ONLY_TOOLS: Readonly<Record<DocumentToolApp, Readonly<Record<string, string>>>> = Object.freeze({
  docs: {
    write_document: "长文分段流式写入，由编辑器侧的 writer 边写边给用户看（CLI 无等价物）；改用 markdownEdit/insert_content 分次写入",
    replace_selection: "只替换用户在编辑器里的当前选区（CLI 拿不到实时选区）；改用 replace_blocks 按块替换",
    reply_comment: "批注线程挂在编辑器的实时会话上；先 docs read --comments 拿 id，再用 apply_ops 的对应 op",
    resolve_comment: "同上：批注状态属于编辑器实时会话",
    add_comment: "新批注要锚定实时选区；文档没开时用 apply_ops 的 add_comment（按 blockIndex/text 锚定）",
    delete_comment: "同上",
    web_search: "联网检索由 Mcode 的受控搜索工具提供，不走文档 CLI",
    image_search: "同上（图片检索属于 GenOffice 云能力，Mcode 不转发）",
    generate_image: "图像生成属于 GenOffice 云能力，Mcode 不转发",
    analyze_media: "多模态读图由 Mcode 的模型侧完成，不走文档 CLI",
  },
  sheets: {
    load_guide: "sheets 的 guide 走 `guide sheets`，但该工具名是编辑器内的入口；用 document_tool_describe 取参数",
    select_range: "依赖编辑器当前选区",
    trace_precedents: "依赖实时公式依赖图（编辑器内计算）",
    trace_dependents: "同上",
    merge_attached_workbooks: "依赖编辑器里挂载的附件会话",
    web_search: "联网检索由 Mcode 的受控搜索工具提供",
    image_search: "同上",
    generate_image: "图像生成属于 GenOffice 云能力",
  },
  slides: {
    plan_deck: "读的是编辑器里活动 deck 的实时状态；CLI 等价物是 guide slides design + outline.json（见 build_deck）",
    generate_deck: "依赖 vendor 编辑器的生成会话；CLI 等价物是 build_deck（create --spec）",
    execute_slide_script: "只在编辑器沙箱里执行",
    insert_web_image: "依赖编辑器会话里的图片通道",
    replace_image: "依赖编辑器里选中的元素 id 与实时状态（CLI 有 slides apply 的等价 op）",
    ask_clarification: "编辑器内的交互式澄清",
    save_style_template: "样式模板存在编辑器 profile 里",
    list_style_templates: "同上",
    web_search: "联网检索由 Mcode 的受控搜索工具提供",
    image_search: "同上",
    generate_image: "图像生成属于 GenOffice 云能力",
    analyze_media: "多模态读图由 Mcode 的模型侧完成",
  },
  pdf: {
    web_search: "联网检索由 Mcode 的受控搜索工具提供",
    image_search: "同上",
    generate_image: "图像生成属于 GenOffice 云能力",
  },
  markdown: {
    get_document_context: "markdown 没有 CLI 结构读；document_md_read 已直接读文件",
    read_blocks: "同上（markdown 是纯文本，按行读即可）",
    apply_ops: "markdown 没有结构化编辑命令；直接写文件或用编辑器",
    write_document: "长文写入属于编辑器 writer",
    insert_image: "markdown 图片需要编辑器处理相对路径",
    web_search: "联网检索由 Mcode 的受控搜索工具提供",
    image_search: "同上",
    generate_image: "图像生成属于 GenOffice 云能力",
    read_frontmatter: "没有 CLI 命令；document_md_read 直接读文件即可看到 frontmatter",
    generate_mindmap: "深度超限的 vendor 工具，且 CLI 无等价物",
  },
  html: {
    get_outline: "html 没有 CLI 结构读；document_md_read 直接读文件",
    read_source: "同上",
    apply_ops: "html 没有 CLI 编辑路线（需要原厂渲染器）",
    ask_clarification: "编辑器内的交互式澄清",
    plan_page: "依赖编辑器侧布局会话",
    write_document: "长文写入属于编辑器 writer",
    web_search: "联网检索由 Mcode 的受控搜索工具提供",
  },
});

export function cliRouteFor(app: DocumentToolApp, tool: string): string | undefined {
  return CLI_TOOL_MAP[app][tool];
}

/** 该工具是否**确认**只有编辑器能做（CLI 无等价能力）。 */
export function editorOnlyReason(app: DocumentToolApp, tool: string): string | null {
  return EDITOR_ONLY_TOOLS[app][tool] ?? null;
}

/** 让模型知道“这个工具要开编辑器才能用”。 */
export function cliUnsupportedReason(app: DocumentToolApp, tool: string): string {
  const confirmed = editorOnlyReason(app, tool);
  if (confirmed !== null) {
    return `${app}.${tool} 只能在编辑器里执行：${confirmed}。` +
      `完整清单见 document_tools_list（route:"editor-only" 的那些）。`;
  }
  return `${app}.${tool} 只能在编辑器里执行（它要读/改活动文档的实时状态），而 ${app === "docs" ? "这个文件" : "该编辑器"}当前没有受信的渲染端绑定。` +
    `请先在 Mcode 里打开目标文件，或改用 CLI 能承载的工具（document_tools_list 里带 route:cli 的那些）。`;
}

/* ───────────────────────── Markdown 载体（纯函数） ───────────────────────── */

/** `docs read --full` 的信封 → 带定位符的 Markdown。表格用 GFM 管道表。 */
export function blocksToMarkdown(detail: unknown): { markdown: string; blocks: number } | null {
  if (detail === null || typeof detail !== "object") return null;
  const items = (detail as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const lines: string[] = [];
  // 工作簿的行块以 `[sheet <name>] ` 开头（见 genofficeCli 的 readWorkbookSheets）。
  // 多表拼在一起时正文必须能分节，否则「A 表的表头 + B 表的数据」在 Markdown 里
  // 连成一片，模型会把跨表的相邻行当成同一张表的连续行。
  let lastSheet: string | null = null;
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const block = raw as { index?: unknown; type?: unknown; level?: unknown; text?: unknown; table?: { rows?: number; cols?: number } };
    const index = typeof block.index === "number" ? block.index : lines.length;
    const rawText = typeof block.text === "string" ? block.text : "";
    const anchor = `<!-- b${index} -->`;
    const sheetTag = /^\[sheet\s+([^\]]+)\]\s?/.exec(rawText);
    let text = rawText;
    if (sheetTag !== null) {
      const sheetName = sheetTag[1]!.trim();
      text = rawText.slice(sheetTag[0].length);
      if (sheetName !== lastSheet) {
        lastSheet = sheetName;
        lines.push(`### ${sheetName}`);
      }
    }
    switch (block.type) {
      case "heading":
        lines.push(`${anchor}${"#".repeat(Math.min(6, Math.max(1, Number(block.level) || 1)))} ${text}`);
        break;
      case "listitem":
        lines.push(`${anchor}- ${text}`);
        break;
      case "table":
        lines.push(`${anchor}${tableToMarkdown(block)}`);
        break;
      case "image":
        lines.push(`${anchor}![image](${text || "embedded"})`);
        break;
      default:
        lines.push(`${anchor}${text}`);
    }
  }
  return { markdown: lines.join("\n\n") + "\n", blocks: items.length };
}

function tableToMarkdown(block: { rows?: number; cols?: number; text?: unknown }): string {
  // `docs read` 的表格块只给扁平文本（没有单元格分隔）；再取一次 range --html 才能
  // 精确重建。这里如实降级：给占位说明 + 可读文本，并让调用方知道要读原文得看 html。
  const rows = Number(block.rows) || 0;
  const cols = Number(block.cols) || 0;
  const text = typeof block.text === "string" ? block.text : "";
  return `<!-- table ${rows}x${cols}; 精确单元格请用 document_tool_call read_blocks（CLI 的 docs read --html 会给出表格 HTML）；本行以下是该表全部文本 -->\n\n${text}`;
}
