/**
 * 【T24】**文档工具面的执行层**：发现、Markdown 载体、QA 门禁、出图。
 *
 * ## 分层
 *
 * - `documentToolSurface.ts` —— 纯目录、检索、门禁格式化（无 IO，可被任何套件直接驱动）。
 * - 本文件 —— 真正落盘/起 CLI/等渲染端 ACK 的那一半：`documentApps`、
 *   `documentToolsList`、`documentToolDescribe`、`documentToolCall`、
 *   `documentMarkdownRead`、`documentMarkdownEdit`、`documentRender`。
 * - `ipc/document.ts` 的 register 段 —— 只做 zod 解析、围栏与端口装配。
 *
 * ## 执行路线（与 T0 同一个受信绑定）
 *
 * `documentToolCall` 先看**文件是否在受信渲染端打开**（`ports.rendererOpen`，由
 * `documentViewHost` 的 `docIdForSender`/`openedFilePath` 事实推出来）。在 → 经
 * T0 的 `invokeRendererTool` 发 `tool-call` 并等 ACK（renderer 侧 `executeTool`）；
 * 不在 → 走 CLI 等价命令。CLI 不承载的工具**明确拒绝**，不静默降级。
 *
 * ## QA 门禁不可跳过
 *
 * 任何**编辑**（`isMutatingDocumentTool` 为真且真的落盘）之后，本模块**强制**调用
 * `docs check` / `sheet check` / `slides audit`，把 `detail.issues` 作为 `qa` 回给
 * 调用方；`detail.issues` 读不到时按门禁失败处理（见 `extractQaReport`）。出图
 * （`documentRender`）落在受控临时目录，返回 PNG 绝对路径，模型据此「亲眼看」。
 *
 * ## Markdown 载体（借鉴 docx-cli 的定位符模型，不引入它）
 *
 * - `documentMarkdownRead`：`docs read --full` 的块清单 → 带 `<!-- b3 -->` 锚点的
 *   Markdown。表格用 GFM 管道表；列表/标题/引用按块类型还原。
 * - `documentMarkdownEdit`：`insert/append/replace/delete`。片段经 CLI
 *   `convert md→html` 转 restricted HTML，再 `docs apply --track`。也就是说
 *   Markdown 与编辑器原生工具走**同一段文字**，不另写排版器。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  blocksToMarkdown,
  DOCUMENT_QA_GATES,
  DOCUMENT_RESIDENT_TOOLS,
  cliRouteFor,
  documentCatalog,
  documentToolsOf,
  extractQaReport,
  extractRenderProbeReport,
  editorOnlyReason,
  findDocumentTool,
  formatQaReport,
  isMutatingDocumentTool,
  parseRenderFiles,
  searchDocumentTools,
  type DocumentCallOutcome,
  type DocumentQaReport,
  type DocumentToolApp,
  type DocumentToolCallPorts,
} from "./documentToolSurface.js";
export { blocksToMarkdown };
import {
  convertFile,
  docsApply,
  docsCheck,
  docsRead,
  docsReadRangeHtml,
  createDeckFromSpec,
  createFromFile,
  createPdfFromFile,
  readAnyDocument,
  guideOps,
  renderDocument,
  renderProbeCheck,
  snapshotDeckSpec,
  sheetApply,
  sheetCheck,
  sheetRead,
  slidesApply,
  slidesAudit,
  slidesRead,
  type GenofficeResult,
} from "./genofficeCli.js";
import { checkDeckPatterns, type DeckPageSpec, type PatternFinding } from "./deckPatternCheck.js";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { requireWorkspacePath, type GenofficePorts } from "./genofficeCli.js";
import type {
  DocumentAppsResult,
  DocumentMarkdownEditResult,
  DocumentMarkdownOperation,
  DocumentMarkdownReadResult,
  DocumentRenderResult,
  DocumentToolCallResult,
  DocumentToolDescribeReply,
  DocumentToolsListResult,
} from "@contracts/ipc";
import type { GenOfficeNativeToolCall, GenOfficeNativeToolDefinition } from "./nativeEditorToolTransport.js";

export interface DocumentSurfacePorts extends GenofficePorts {
  /** 受信渲染端工具调用（T0）。第三参是该调用针对的文件 —— 端口必须按它选绑定，
   *  不能用一个“最近一次查过的路径”的快照（那在并发调用下会借用错请求）。 */
  invokeRendererTool?: (call: GenOfficeNativeToolCall, definition: GenOfficeNativeToolDefinition, filePath: string) => Promise<{ status: string; output: string }>;
  /** 把工具名换成**该文件活跃请求**渲染端声明的原始定义（T98 端做 canonical JSON
   *  比对，宿主自造的 schema 会被拒绝）。null = 该工具不在请求声明的工具表里。 */
  rendererToolDefinition?(tool: string, filePath: string): GenOfficeNativeToolDefinition | null;
  /** 该文件此刻是否有可借用的受信渲染端绑定（宿主从真实请求登记簿计算）。 */
  rendererOpen(filePath: string): boolean;
  /** 渲染输出目录（工作区外、可清理）。 */
  renderTempRoot(): string;
  /** 目录写用。 */
  fs?: { mkdirSync: typeof mkdirSync; writeFileSync: typeof writeFileSync; readFileSync: typeof readFileSync; rmSync: typeof rmSync; existsSync: typeof existsSync };
  signal?: AbortSignal;
}

/* ───────────────────────── 发现 ───────────────────────── */

export function documentApps(ports: DocumentSurfacePorts): DocumentAppsResult {
  const apps = (["docs", "sheets", "slides", "pdf", "markdown", "html"] as const).map((app) => {
    const tools = documentToolsOf(app);
    const cliTools = tools.filter((tool) => cliRouteFor(app, tool.name) !== undefined).map((tool) => tool.name);
    return {
      app,
      residentTools: [...DOCUMENT_RESIDENT_TOOLS[app]],
      toolCount: tools.length,
      cliTools,
      qaGates: [...DOCUMENT_QA_GATES[app]],
    };
  });
  return {
    apps,
    catalogSource: "genoffice 快照的 AGENT_TOOLS/WORKBOOK_TOOLS/TOOLS + 伴随 skill；见 documentToolCatalog.generated.ts 头注释",
    totalTools: documentCatalog().length,
  };
}

export function documentToolsList(args: { app?: DocumentToolApp; query?: string; cliOnly?: boolean }): DocumentToolsListResult {
  const matched = searchDocumentTools(args.app, args.query)
    .filter((entry) => !args.cliOnly || cliRouteFor(entry.app, entry.name) !== undefined);
  const tools = matched.map((entry) => {
    const cliRoute = cliRouteFor(entry.app, entry.name);
    const onlyEditor = editorOnlyReason(entry.app, entry.name);
    // 【T43】三态 route：
    //   cli          —— 文件没开在编辑器里也能用
    //   editor-only  —— **确认**只有编辑器能做（CLI 无等价物），原因在 note 里
    //   editor       —— 需要编辑器会话（受信渲染端绑定）；有绑定时可执行
    // 以前只有 cli|editor 两态，模型分不清「开编辑器就能用」与「开了也做不了」，
    // 于是只能靠试 —— 这正是卡里说的「目录承诺了能力，调用时没有」。
    const route: "cli" | "editor" | "editor-only" =
      cliRoute !== undefined ? "cli" : onlyEditor !== null ? "editor-only" : "editor";
    return {
      app: entry.app,
      name: entry.name,
      doc: entry.doc,
      resident: DOCUMENT_RESIDENT_TOOLS[entry.app].includes(entry.name),
      route,
      ...(onlyEditor !== null ? { note: onlyEditor } : {}),
    };
  });
  const editorOnlyCount = tools.filter((tool) => tool.route === "editor-only").length;
  return {
    total: documentCatalog().length,
    shown: tools.length,
    tools,
    note: tools.length === 0
      ? "没有匹配的工具。不带 query 调一次看该编辑器的全部工具；app 省略则查全部六个编辑器。"
      : `下一步：document_tool_describe({tool}) 看参数与示例 → document_tool_call({tool, filePath, input}) 执行。` +
        `route=cli 的最省事；route=editor 要求文件已在 Mcode 编辑器里打开；` +
        `route=editor-only 的工具**开了编辑器也没有 CLI 能力**，note 里写了替代做法` +
        `${editorOnlyCount > 0 ? `（本列表有 ${editorOnlyCount} 个）` : ""}。` +
        `新建 PPT 用 slides 的 build_deck（设计流水线）；新建 docx/xlsx/pdf 用 create_document。`,
  };
}

/* ───────────────【T102】`create` 路线的 describe 说明 ───────────────
 *
 * ## 缺口（T97 实测）
 *
 * `describe({tool:"create_document"})` 原来落进「取整个 domain 的 guide 前 4000 字」
 * 那个兜底分支，返回的是 **apply 的 ops 语法** —— 里面没有 `input.source`、没有
 * 「docx 要受限 HTML」、没有「Markdown 会被拒」。模型按正常理解传 `.md` 就被围栏拒，
 * **只能靠试错发现**。
 *
 * 为什么不能像 apply 那样「取上游 guide 原文」：`genoffice guide docs <op>` 只认
 * `block` / `content` 两个**组**，`create_document` 不是 apply op，上游没有它的条目
 * （实测 `genoffice guide docs create_document` → `unknown group or op`）。
 * 上游对 create 的说明只在 `create --help` 与工具表里，都不经 guide 出口。
 *
 * 所以这里**手写**，并且每条都对着围栏的真实实现写：
 *   - docx：只收 `.html/.htm`（`genofficeCli.createFromFile`，理由见那里的注释：
 *     Markdown 图片路径没逐一围栏）；
 *   - xlsx：只收 `.csv/.json`；
 *   - pdf：收 `.md/.markdown/.html/.htm/.docx/.xlsx/.pptx`（`createPdfFromFile`）。
 * `case` 用的是 `DocumentToolApp` 的字面量，改一处围栏不回来改这里时，套件会红 ——
 * 断言读的就是这段文字里的扩展名清单（见 t24 套件的 T102 组）。
 */
function createRouteHelp(app: DocumentToolApp, tool: string): string {
  const head = [
    "参数形状：input.source 是**源文件**的绝对路径（必须在工作区内），filePath 是要新建的目标文件。",
    "目标已存在会被拒绝（不覆盖）；create 没有 dryRun。",
  ];
  if (tool === "build_deck") {
    return [
      ...head,
      "build_deck 的源不是单文件：input.specDir 是工作区里的 deck 目录（style.md + outline.json + pages/NN.json），",
      "或 input.outline 指定 outline.json。先 document_guide({app:\"slides\",topic:\"design\"}) 拿设计规范。",
      "可选 input.render:true 出 PNG、input.audit:true 跑几何审计。",
    ].join("\n");
  }
  switch (app) {
    case "docs":
      return [
        ...head,
        "源文件只接受**受限 HTML fragment**（.html / .htm）—— docx 与 pdf 共用上游那一份 HTML 解析器。",
        "**Markdown（.md）会被拒绝**：上游会把 md 里的图片路径当文件去解析，而 Mcode 没有逐条围栏那些路径。",
        "所以先从 md 转成受限 HTML 再传（标题用 h1-h6、列表用 ul/ol、表格用 table；不要写 script/style）。",
        "源里的图片与图表不会进入新文件。",
      ].join("\n");
    case "sheets":
      return [
        ...head,
        "源文件只接受 .csv 或 .json（二维数组，或 {sheets:[{name, rows}]}）；以 = 开头的字符串按公式处理。",
        "input.header:true 把第一行当表头（冻结 + AutoFilter）。",
      ].join("\n");
    case "pdf":
      return [
        ...head,
        "源文件接受 .md / .markdown / .html / .htm / .docx / .xlsx / .pptx —— **这里 md 是允许的**（与 docs 的 create 不同）。",
        "pdf 走原厂渲染器打印，需要本机有 GenOffice 应用；没有时 CLI 会回 app_unavailable。",
      ].join("\n");
    default:
      return head.join("\n");
  }
}

/** CLI 承载的 op 直接取 `guide <domain> <op>` —— 永远是 CLI 校验器的那一份。 */
function cliGuideDomain(app: DocumentToolApp): "docs" | "slides" | "sheet" | "pdf" | "markdown" | null {
  switch (app) {
    case "docs": return "docs";
    case "sheets": return "sheet";
    case "slides": return "slides";
    case "pdf": return "pdf";
    case "markdown": return "markdown";
    default: return null;
  }
}

/* ───────────────【T47】`document_guide`：把 CLI 的 guide 原文交给模型 ───────────────
 *
 * ## 缺陷（T47）
 *
 * `build_deck` 的报错里写「设计流水线的规范在 `guide slides design`」，但模型
 * **没有入口**能跑它：`document_tool_describe` 传的是工具名（`load_guide` /
 * `apply_ops`），不是子域 `design`；`document_tools_list` 只列工具不列规范。
 *
 * 实测 `genoffice guide slides design --json` 是 **12,231 字符**的完整设计方法论：
 * 18 种布局名（`cover_typography_hero` …）、CJK/拉丁排版数值、**反模式清单**
 * （明写 "treat as defects"，第一条就是「每张卡片左侧的细竖条」—— AI 做 PPT
 * 最常见的丑法）。拿不到这段，模型只能凭感觉摆 px，结果就是用户说的「毫无审美」。
 *
 * ## 为什么是「新工具」而不是「塞进 describe」
 *
 * - `describe` 的输出已经 ~2.8 KB（整个 slides guide 的前 4000 字截断），再塞
 *   12 KB 会把**每个**工具的描述都撑大，而模型查别的工具时不需要设计规范；
 * - guide 是**可发现**的：模型可以先问「有哪些 guide 主题」，再取需要的那个；
 * - 它同时覆盖 `docs` / `sheets` 的 group guide，不只 slides。
 *
 * ## 安全
 *
 * 只读、不碰文件：`guideOps` 只拼 `["guide", domain, "--json", ...]`，走与其它
 * 命令同一条 `invoke`（不继承宿主环境、限时、限输出）。`topic` 会先过白名单，
 * 不接受任意字符串（否则等于把 CLI 的 argv 交给模型）。
 */

/** `document_guide` 允许的 domain → CLI 的 guide 域（`sheet` 是单数）。 */
const GUIDE_DOMAINS: Readonly<Record<string, "docs" | "slides" | "sheet">> = Object.freeze({
  docs: "docs",
  slides: "slides",
  sheets: "sheet",
  sheet: "sheet",
});

/**
 * `topic` 白名单。三个域共有的子域是 `design` / `spec`（slides 的两份最有价值），
 * 其余按「group / op」走 —— 但**只允许这个正则**，不透传任意字符串。
 */
const GUIDE_TOPIC_PATTERN = /^(?:[a-z][a-z0-9_]{0,63})$/;

export interface DocumentGuideArgs {
  app?: DocumentToolApp;
  /** CLI 的 guide 域；省略时用 `app` 推。 */
  domain?: string;
  /** 子域/分组/op 名（`design` / `spec` / `content` …）；省略 = 该域的顶层目录。 */
  topic?: string;
}

export interface DocumentGuideResultOk {
  ok: true;
  domain: string;
  topic: string | null;
  /** guide 原文（Markdown）。 */
  text: string;
  /** 字数（模型据此决定要不要分段读）。 */
  chars: number;
  /** 该 guide 涉及的 op 名（CLI 在 `detail.ops` 里给时才有）。 */
  ops?: string[];
}
export type DocumentGuideResult =
  | DocumentGuideResultOk
  | { ok: false; reason: string; suggestions?: readonly string[] };

/** 每个域**可用**的 guide 子域（CLI 的顶层 guide 会列出；这里给一份常用的快捷建议）。 */
const GUIDE_TOPIC_HINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  slides: ["design", "spec"],
  docs: ["content", "structure"],
  sheet: ["content", "format"],
});

/**
 * 【T47】`document_guide({app, topic})` → `genoffice guide <domain> [topic] --json` 原文。
 *
 * 不截断：设计规范 12 KB 正是模型需要的全部；截断会重演「describe 只给前 4000 字、
 * 恰好丢掉反模式清单」的老问题。要分段的调用方自己按 `chars` 决定。
 */
export async function documentGuide(
  ports: DocumentSurfacePorts,
  args: DocumentGuideArgs,
): Promise<DocumentGuideResult> {
  const appDomain = args.app !== undefined ? cliGuideDomain(args.app) : null;
  const requested = args.domain?.trim().toLowerCase();
  const domainKey = requested ?? appDomain ?? null;
  const domain = domainKey !== null ? GUIDE_DOMAINS[domainKey] : undefined;
  if (domain === undefined) {
    const available = Object.keys(GUIDE_DOMAINS).join(" / ");
    return {
      ok: false,
      reason: `没有这个 guide 域：${String(args.domain ?? args.app ?? "(未指定)")}。可用：${available}。`,
      suggestions: Object.entries(GUIDE_TOPIC_HINTS).map(([key, hints]) => `${key}: ${hints.join(" / ")}`),
    };
  }
  const rawTopic = args.topic?.trim();
  const topic = rawTopic === undefined || rawTopic === "" ? null : rawTopic.toLowerCase();
  if (topic !== null && !GUIDE_TOPIC_PATTERN.test(topic)) {
    return {
      ok: false,
      reason: `topic 只能是小写字母/数字/下划线（≤64）：${topic}。不知道该用哪个时省略 topic，先取该域的顶层目录。`,
      suggestions: GUIDE_TOPIC_HINTS[domain] ?? [],
    };
  }
  const guide = await guideOps(ports, domain, topic ?? undefined, ports.signal);
  if (!guide.ok) {
    // 取不到时**不猜**：把 CLI 的原话带回去，并给出该域已知可用的子域。
    return {
      ok: false,
      reason: `guide 取不到（${guide.reason}）`,
      suggestions: GUIDE_TOPIC_HINTS[domain] ?? [],
    };
  }
  const text = typeof guide.envelope.summary === "string" ? guide.envelope.summary : "";
  if (text === "") {
    return { ok: false, reason: "guide 返回了空正文；CLI 信封形状不符。", suggestions: GUIDE_TOPIC_HINTS[domain] ?? [] };
  }
  const detail = (guide.envelope.detail ?? null) as { ops?: unknown } | null;
  const ops = detail !== null && Array.isArray(detail.ops)
    ? detail.ops.filter((op): op is string => typeof op === "string")
    : undefined;
  return {
    ok: true,
    domain,
    topic,
    text,
    chars: text.length,
    ...(ops !== undefined && ops.length > 0 ? { ops } : {}),
  };
}

export async function documentToolDescribe(
  ports: DocumentSurfacePorts,
  args: { tool: string; app?: DocumentToolApp; detail?: "compact" | "full" },
): Promise<DocumentToolDescribeReply> {
  const entry = findDocumentTool(args.tool, args.app);
  if (!entry) {
    const suggestions = searchDocumentTools(args.app, args.tool).slice(0, 5).map((item) => `${item.app}.${item.name}`);
    return {
      ok: false,
      reason: `没有这个文档工具：${args.tool}。用 document_tools_list({query}) 查。`,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    };
  }
  const cliOp = cliRouteFor(entry.app, entry.name);
  const domain = cliGuideDomain(entry.app);
  const parts = [`工具：${entry.app}.${entry.name}`, `说明：${entry.doc}`];
  if (cliOp !== undefined) {
    parts.push(`执行路线：CLI 承载（文件没开在编辑器里也能用）`);
  } else {
    parts.push(`执行路线：仅编辑器（要求该文件已在 Mcode 编辑器里打开并持有受信绑定）`);
  }
  if (cliOp === "apply" && domain !== null) {
    const guide = await guideOps(ports, domain === "sheet" ? "sheet" : domain, entry.name, ports.signal);
    if (guide.ok) {
      const summary = typeof guide.envelope.summary === "string" ? guide.envelope.summary : "";
      const schema = (guide.envelope.detail as { schema?: unknown } | null)?.schema;
      parts.push("", "参数与示例（来自 genoffice guide）：", summary, schema ? JSON.stringify(schema, null, 2) : "");
    } else {
      parts.push("", `参数表取不到（${guide.reason}）。op 名可能不在 CLI 的 apply 表里，请用 document_tools_list 换一个。`);
    }
  } else if (cliOp === "create" && domain !== null) {
    parts.push("", createRouteHelp(entry.app, entry.name));
  } else if (domain !== null && cliOp !== undefined) {
    const guide = await guideOps(ports, domain === "sheet" ? "sheet" : domain, undefined, ports.signal);
    if (guide.ok && typeof guide.envelope.summary === "string") {
      parts.push("", "该编辑器 CLI 侧的读取/编辑语法（genoffice guide 原文，前 4000 字）：", guide.envelope.summary.slice(0, 4000));
    }
  } else {
    parts.push("", "这个工具由编辑器页面自己的 AgentSkill 执行；参数以工具名为键传给 document_tool_call({tool, filePath, input})，input 形状与 vendor 工具表一致。");
  }
  if (entry.app === "docs" && ["insert_chart", "edit_chart", "set_page_setup", "define_style", "set_watermark", "insert_text_box", "insert_picture", "generate_mindmap"].includes(entry.name)) {
    parts.push("", "注意：该工具的 vendor JSON-Schema 用了联合类型或超过深度上限，T0 的请求级契约无法承载（withheld）。" +
      "在渲染端路线里它会由编辑器自己执行（不经 SDK 请求级 schema）；CLI 路线请改用等价的 apply op。");
  }
  const schemaText = parts.join("\n");
  // `withheld` 报给调用方（卡里的硬约束：40 个不许悄悄丢掉）。
  const withheldWhy = withheldReason(entry.app, entry.name);
  return {
    ok: true,
    app: entry.app,
    tool: entry.name,
    doc: entry.doc,
    schemaText,
    route: cliOp !== undefined ? "cli" : "editor",
    ...(withheldWhy !== null ? { withheld: withheldWhy } : {}),
  };
}

/** T0 的 withheld 名单（共享 JSON-Schema 子集装不下的 8 个 Docs 工具）。此处单列，
 *  是为了在工具面上**明确可见**而不是悄悄消失；文档里逐条列出了替代路线。 */
export function withheldReason(app: DocumentToolApp, tool: string): string | null {
  if (app === "docs") {
    if (["insert_chart", "edit_chart", "set_page_setup", "define_style", "set_watermark", "insert_text_box", "insert_picture"].includes(tool)) {
      return "vendor schema 使用联合类型（type: [X,'null']），超出 T86 请求级 JSON-Schema 子集；渲染端 AgentSkill 仍可执行，CLI 路线用等价 apply op。";
    }
    if (tool === "generate_mindmap") {
      return "vendor schema 嵌套深度超过 12 层上限；渲染端 AgentSkill 仍可执行，CLI 无等价 op。";
    }
  }
  if (app === "sheets" && tool === "find_cells") {
    return "vendor schema 使用 `default` 关键字（子集不支持）；渲染端可执行，CLI 用 sheet read --where 等价。";
  }
  if (app === "slides" && tool === "apply_ops") {
    return "vendor 工具描述超过 4000 字符上限（内容本身合法）；渲染端可执行，CLI 用 slides apply --ops。";
  }
  if (app === "markdown" && tool === "generate_mindmap") {
    return "vendor schema 嵌套深度超过 12 层上限；渲染端可执行，CLI 无等价 op。";
  }
  if (app === "html" && tool === "apply_ops") {
    return "vendor schema 使用联合类型；渲染端可执行，HTML 没有 CLI 编辑路线。";
  }
  return null;
}

/* ───────────────────────── 执行 ───────────────────────── */

interface ResolvedCall {
  entry: NonNullable<ReturnType<typeof findDocumentTool>>;
  filePath: string;
}

function refusal(reason: string, suggestions?: string[]): DocumentToolCallResult {
  return { ok: false, kind: "refused", reason, ...(suggestions ? { suggestions } : {}) };
}

function failedResult(reason: string): DocumentToolCallResult {
  return { ok: false, kind: "failed", reason };
}

function envelopeText(result: GenofficeResult): string {
  if (result.ok) {
    const env = result.envelope;
    return [
      env.summary ?? `${env.command ?? "命令"} 完成`,
      env.output_path ? `输出：${env.output_path}` : "",
      // 【T73】**`detail` 里的反模式 findings 必须进正文。**
      // 原先这里只取 `summary` + `output_path`，`detail` 整段被丢掉 —— 于是
      // `withPatternFindings` 挂上去的东西模型根本看不到，等于没接。
      // 只渲染 `pattern*` 这几项，不把整个 detail 倒出来（那会淹没正文）。
      patternFindingsText(env.detail),
    ].filter(Boolean).join(String.fromCharCode(10));
  }
  return result.reason;
}

/**
 * 【T73】把 `detail.patternFindings` 渲染成模型能读的几行。
 *
 * 没有这几行，检查器就是「算了但没人看见」—— 这正是本卡要修的缺陷本身。
 * 形状由 `withPatternFindings` 决定（`patternChecked` / `patternFindings` /
 * `patternCounts` / `patternHint` / `patternNotes`）。
 */
function patternFindingsText(detail: unknown): string {
  if (detail === null || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;
  const lines: string[] = [];
  // 有页面文件被跳过时要说出来 —— CLI 会静默丢掉不合法页继续建（`parseDeckSpec`
  // 只在**一页都不剩**时才报错），所以「检查跑过了」不等于「每一页都被检查了」。
  const notes = Array.isArray(d.patternNotes) ? d.patternNotes.filter((n): n is string => typeof n === "string") : [];
  if (d.patternChecked === false) {
    // **显式**说明没跑成，不许让模型以为「没报就是没问题」（硬规矩 3）。
    lines.push(`⚠️ 反模式检查**没有执行**${notes.length > 0 ? `：${notes.join("；")}` : "（原因未提供）"}。`);
    return lines.join(String.fromCharCode(10));
  }
  if (d.patternChecked !== true) return "";
  const findings = Array.isArray(d.patternFindings) ? d.patternFindings : [];
  const hint = typeof d.patternHint === "string" ? d.patternHint : "";
  const pageFiles = Array.isArray(d.patternPageFiles)
    ? d.patternPageFiles.filter((n): n is string => typeof n === "string")
    : [];
  if (findings.length === 0) {
    if (hint) lines.push(`✅ ${hint}`);
  } else {
    lines.push(hint ? `⚠️ ${hint}` : "⚠️ 反模式检查发现问题：");
    for (const raw of findings.slice(0, 40)) {
      if (raw === null || typeof raw !== "object") continue;
      const f = raw as { rule?: unknown; level?: unknown; page?: unknown; message?: unknown };
      // 位置：**优先给文件名**（模型要改的就是文件），`page: null` 是「全篇」。
      // 给不出文件名时才退回页号 —— 两者都能定位，但文件名不用换算。
      const where =
        typeof f.page === "number"
          ? (pageFiles[f.page] !== undefined ? `pages/${pageFiles[f.page]}` : `第 ${f.page + 1} 页`)
          : "整份";
      lines.push(`- [${String(f.level ?? "?")}] ${String(f.rule ?? "?")} · ${where}：${String(f.message ?? "")}`);
    }
    if (findings.length > 40) lines.push(`…（还有 ${findings.length - 40} 条未列）`);
  }
  if (notes.length > 0) lines.push(`⚠️ 有页面文件没被检查：${notes.join("；")}`);
  return lines.join(String.fromCharCode(10));
}

/** 编辑后强制 QA 门禁。返回 null 表示该 app 没有门禁（目前只有 markdown/html 的
 *  纯文本改写会走到这里 —— 见 `DOCUMENT_QA_GATES` 的注释）。 */
export async function runQaGate(
  ports: DocumentSurfacePorts,
  app: DocumentToolApp,
  filePath: string,
): Promise<DocumentQaReport | null> {
  const gates = DOCUMENT_QA_GATES[app];
  if (gates.length === 0) return null;
  const gate = gates[0];
  if (gate === "audit") {
    return extractQaReport("audit", await slidesAudit(ports, filePath, ports.signal ? { signal: ports.signal } : {}));
  }
  if (gate === "render-probe") {
    // 【T43】pdf/markdown/html：上游没有 check/audit 命令，但有 render。
    // 跑一次真渲染（1 页），把「能不能排版」当作门禁 —— 并在返回里写明范围，
    // 绝不让调用方把「出图成功」读成「内容正确」。
    const outDir = join(ports.renderTempRoot(), `qa-probe-${randomUUID().replace(/-/g, "").slice(0, 12)}`);
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (error) {
      return extractRenderProbeReport(app, {
        ok: false, kind: "failed", envelope: null,
        reason: `无法创建渲染探针目录：${error instanceof Error ? error.message : String(error)}`,
      }, []);
    }
    const result = await renderProbeCheck(ports, filePath, outDir, ports.signal ? { signal: ports.signal } : {});
    const images = result.ok ? listPngs(outDir) : [];
    return extractRenderProbeReport(app, result, images);
  }
  const result = app === "sheets"
    ? await sheetCheck(ports, filePath, ports.signal ? { signal: ports.signal } : {})
    : await docsCheck(ports, filePath, ports.signal ? { signal: ports.signal } : {});
  return extractQaReport("check", result);
}

/** 列出渲染目录里的 PNG（`render` 的产出是 `<stem>-NN.png`）。只读、有界。 */
function listPngs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort()
      .slice(0, 200)
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** CLI 通路的单工具执行（tool → 命令参数）。返回 CLI 结果；不接受模型提供的任意命令。 */
async function executeCliTool(
  ports: DocumentSurfacePorts,
  app: DocumentToolApp,
  tool: string,
  filePath: string,
  input: Record<string, unknown>,
  options: { dryRun?: boolean; track?: boolean },
): Promise<{ result: GenofficeResult; mutated: boolean }> {
  const route = cliRouteFor(app, tool);
  // 【T43】创建路线的类型映射在**入口处**算好：后面的 `if (app === "slides")` 分支
  // 会把 `app` 收窄，届时再比较会得到 TS2367（类型上已不重叠）。
  const createType: "docx" | "xlsx" | "pdf" | null =
    app === "docs" ? "docx" : app === "sheets" ? "xlsx" : app === "pdf" ? "pdf" : null;
  if (route === undefined) {
    return {
      result: { ok: false, kind: "refused", envelope: null, reason:
        `${app}.${tool} 只能在编辑器里执行（它要读/改活动文档的实时状态），而该文件当前没有受信的渲染端绑定。` +
        `请先在 Mcode 里打开目标文件，或用 document_tools_list({cliOnly:true}) 看 CLI 能承载的工具。` },
      mutated: false,
    };
  }
  const signal = ports.signal ? { signal: ports.signal } : {};
  if (app === "docs") {
    switch (route) {
      case "read": {
        const full = input.full === true;
        const range = typeof input.range === "string" ? input.range : undefined;
        if (tool === "read_blocks" && typeof input.startBlockIndex === "number" && typeof input.endBlockIndex === "number") {
          return { result: await docsRead(ports, filePath, { range: `${input.startBlockIndex}-${input.endBlockIndex}`, ...signal }), mutated: false };
        }
        return { result: await docsRead(ports, filePath, { ...(full ? { full: true } : {}), ...(range ? { range } : {}), ...signal }), mutated: false };
      }
      case "read-revisions":
      case "read-comments":
      case "read-notes":
      case "read-styles": {
        // 这些是 `docs read` 的视图开关（--revisions/--comments/--notes/--styles）。
        const flag = { "read-revisions": "--revisions", "read-comments": "--comments", "read-notes": "--notes", "read-styles": "--styles" }[route];
        return { result: await docsReadWithFlag(ports, filePath, flag, ports.signal), mutated: false };
      }
      case "create": {
        // 【T43】create_document：docs → docx。类型在入口处算好（见 createType）。
        return await createDocument(ports, "docx", filePath, input, options);
      }
      case "apply": {
        const ops = Array.isArray(input.ops) ? input.ops : [input];
        // 模型只想调单个 op 时，input 本身就是那一条 op。
        const result = await docsApply(ports, filePath, ops, {
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.track !== false ? { track: true } : {}),
          ...signal,
        });
        return { result, mutated: result.ok && options.dryRun !== true };
      }
      default:
        return { result: { ok: false, kind: "refused", envelope: null, reason: `docs 的 ${tool} 没有 CLI 路线` }, mutated: false };
    }
  }
  if (app === "sheets") {
    if (route === "read") {
      const sheet = typeof input.sheet === "string" ? input.sheet : undefined;
      const range = typeof input.range === "string" ? input.range : undefined;
      const maxRows = typeof input.maxRows === "number" ? input.maxRows : undefined;
      return { result: await sheetRead(ports, filePath, ports.signal, { ...(sheet ? { sheet } : {}), ...(range ? { range } : {}), ...(maxRows ? { maxRows } : {}) }), mutated: false };
    }
    if (route === "create") {
      // 【T43】create_document：sheets → xlsx。
      return await createDocument(ports, "xlsx", filePath, input, options);
    }
    const ops = Array.isArray(input.ops) ? input.ops : [input];
    const result = await sheetApply(ports, filePath, ops, { ...(options.dryRun ? { dryRun: true } : {}), ...signal });
    return { result, mutated: result.ok && options.dryRun !== true };
  }
  if (app === "slides") {
    if (route === "read") {
      const slide = typeof input.slide === "number" ? input.slide : undefined;
      return { result: await slidesRead(ports, filePath, ports.signal, slide !== undefined ? { slide } : {}), mutated: false };
    }
    if (route === "guide") {
      return { result: await guideOps(ports, "slides", undefined, ports.signal), mutated: false };
    }
    if (route === "create") {
      // 【T43】build_deck：PPT 设计流水线（spec 快照 → create --spec --render --audit）。
      // **必须放在这个分支里**：放到函数末尾的通用 create 块会因 `app` 已被
      // 上面的 `if (app === "slides")` 收窄而变成死代码（tsc 会报 TS2367，
      // 但更糟的是运行期它会静默落进 slidesApply）。
      return await buildDeck(ports, filePath, input, options);
    }
    const ops = Array.isArray(input.ops) ? input.ops : [input];
    const result = await slidesApply(ports, filePath, ops, { ...(options.dryRun ? { dryRun: true } : {}), ...signal });
    return { result, mutated: result.ok && options.dryRun !== true };
  }
  if (app === "pdf" && route === "read") {
    const range = typeof input.range === "string" ? input.range : undefined;
    const page = typeof input.page === "number" ? input.page : undefined;
    return { result: await readPdf(ports, filePath, { ...(page ? { page } : {}), ...(range ? { range } : {}), ...signal }), mutated: false };
  }

  /* ─────────────【T43】创建路线（docx / xlsx / pdf / pptx）─────────────
   *
   * 缺口二/三/四的落点。三条子路线各有各的安全形状，**不共用一条**：
   *
   *  a. `slides.build_deck` → `create --type pptx --spec <dir>`：
   *     spec 目录会被**快照**进受控临时目录再构建（方案 B），源目录只读。
   *  b. `*.create_document` + pptx 的 `from` 字段 → `create --type X --from <file>`：
   *     T74 已有的 `createFromFile`，只接受单文件 + 白名单扩展名。
   *  c. 其余情况 → 显式拒绝并说明缺什么（不猜路径、不静默换命令）。
   */
  if (route === "create") {
    // 走到这里的只剩 pdf（docs/sheets/slides 的 create 已在各自分支处理）。
    if (tool !== "create_document" || createType === null) {
      return {
        result: { ok: false, kind: "refused", envelope: null, reason:
          `${app}.${tool} 没有 CLI 创建路线。` +
          `可用的创建工具：docs/sheets/pdf 的 create_document（源文件经 input.source），slides 的 build_deck（设计流水线）。` },
        mutated: false,
      };
    }
    return await createDocument(ports, createType, filePath, input, options);
  }

  return { result: { ok: false, kind: "refused", envelope: null, reason: `${app}.${tool} 没有 CLI 路线` }, mutated: false };
}

/** `create_document` 的共同实现：`create --type X --from <source> --out <filePath>`。 */
async function createDocument(
  ports: DocumentSurfacePorts,
  type: "docx" | "xlsx" | "pdf",
  outPath: string,
  input: Record<string, unknown>,
  options: { dryRun?: boolean; track?: boolean },
): Promise<{ result: GenofficeResult; mutated: boolean }> {
  const source = typeof input.source === "string" ? input.source : typeof input.from === "string" ? input.from : null;
  if (source === null) {
    return {
      result: { ok: false, kind: "refused", envelope: null, reason:
        `create_document 需要 input.source（源文件绝对路径）。` +
        `docx 接受受限 HTML fragment（.html/.htm）；xlsx 接受 .csv/.json；pdf 接受 .md/.html/.docx/.xlsx/.pptx。` +
        (type === "docx" ? ` 想直接从 Markdown 建 docx 时，用 convert（md→docx），或先转成受限 HTML。` : "") },
      mutated: false,
    };
  }
  if (options.dryRun === true) {
    return {
      result: { ok: false, kind: "refused", envelope: null, reason: "create 没有 dry-run：它写的是一个新文件，不覆盖任何已有内容。" },
      mutated: false,
    };
  }
  // 【T43】PDF 走的是 `create --type pdf --from <document>`：CLI 用原厂渲染器打印，
  // 需要 GenOffice 应用在机器上（`capabilities.app.available`）。这里不预判，
  // 让 CLI 自己回 `app_unavailable`（那样原因更准）。
  if (type === "pdf") {
    const result = await createPdfFromFile(ports, source, outPath, ports.signal ? { signal: ports.signal } : {});
    return { result, mutated: result.ok };
  }
  const result = await createFromFile(ports, type, source, outPath, ports.signal ? { signal: ports.signal } : {});
  return { result, mutated: result.ok };
}

/**
 * 【T43】`slides.build_deck` —— PPT 设计流水线的 CLI 入口，**带快照围栏**。
 *
 * 输入形状（与 `guide slides design` 一致）：
 * ```
 * { specDir: "<工作区里的 deck 目录>", outline?: "<outline.json>", render?: true, audit?: true }
 * ```
 * `filePath` 是**输出 .pptx**（工作区内、必须不存在）。
 *
 * 步骤：
 *   1. 在 `renderTempRoot()` 下建一个一次性目录；
 *   2. `snapshotDeckSpec` 把 specDir 逐文件审核后拷进去（符号链接/未知扩展名/界外路径一律拒绝）；
 *   3. `createDeckFromSpec` 对**副本**调 `create --spec`，可选 `--render` / `--audit`；
 *   4. 清理副本目录（无论成败）。
 *
 * 为什么这样是安全的：CLI 读到的每个文件都已经在受控目录里，且与源目录逐字节
 * 相同 —— 图片相对路径照常工作，但它**读不到源目录以外的任何东西**。
 */
async function buildDeck(
  ports: DocumentSurfacePorts,
  outPath: string,
  input: Record<string, unknown>,
  options: { dryRun?: boolean; track?: boolean },
): Promise<{ result: GenofficeResult; mutated: boolean }> {
  const specDir = typeof input.specDir === "string" ? input.specDir : null;
  if (specDir === null) {
    return {
      result: { ok: false, kind: "refused", envelope: null, reason:
        "build_deck 需要 input.specDir（设计流水线的 deck 目录，里面有 pages/NN.json，可选 outline.json / style.md / 图片）。" +
        "**设计规范先调 document_guide({app:\"slides\", topic:\"design\"})**（12 KB 的方法论：18 种布局名、CJK/拉丁排版数值、反模式清单），" +
        "页面规格的字段调 document_guide({app:\"slides\", topic:\"spec\"})。" +
        "步骤：拿 guide → 写 style.md + outline.json + pages/NN.json → build_deck（可带 render:true, audit:true）→ 看 PNG 与 audit → 最多两轮修。" },
      mutated: false,
    };
  }
  if (options.dryRun === true) {
    return {
      result: { ok: false, kind: "refused", envelope: null, reason:
        "build_deck 没有 dry-run：它写的是一个新 .pptx。要预览页面请先写 spec 并用 slides check 逐页检查（那是设计流水线要求的步骤）。" },
      mutated: false,
    };
  }
  const root = ports.renderTempRoot();
  if (!root || root.trim() === "") {
    return { result: { ok: false, kind: "refused", envelope: null, reason: "当前端口没有受控临时目录，无法为 spec 建快照" }, mutated: false };
  }
  // 【T73】反模式检查：**在 build 之前**读 spec、跑判据，把 findings 带给模型。
  //
  // 为什么在这里（而不是新开一个工具）：`build_deck` 是模型在设计流水线里**唯一**
  // 可靠会走到的入口（`slides check` 在工具面上根本没有路由 —— 见 T73 回写的论证）。
  // 检查失败**不阻断 build**：findings 是附加信息，不是新的拒绝条件（卡里硬要求 3）。
  const patternCheck = readDeckPatterns(ports, specDir);

  const snapshotRoot = join(root, `t43-deck-${randomUUID().replace(/-/g, "").slice(0, 12)}`);
  try {
    const snapshot = await snapshotDeckSpec(ports, specDir, snapshotRoot);
    if (!snapshot.ok) {
      return { result: { ok: false, kind: "refused", envelope: null, reason: snapshot.reason }, mutated: false };
    }
    // outline 必须也在快照里（源路径 → 相对路径），否则 CLI 会去读源目录。
    const outlineInput = typeof input.outline === "string" ? input.outline : null;
    let outlineInSnapshot: string | undefined;
    if (outlineInput !== null) {
      const rel = relative(specDir, outlineInput).replaceAll("\\", "/");
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return { result: { ok: false, kind: "refused", envelope: null, reason: `outline 必须位于 spec 目录内：${outlineInput}` }, mutated: false };
      }
      outlineInSnapshot = join(snapshotRoot, ...rel.split("/"));
    } else {
      // 默认：快照里的 outline.json（若存在）。
      const candidate = join(snapshotRoot, "outline.json");
      if (existsSync(candidate)) outlineInSnapshot = candidate;
    }
    const renderDir = input.render === true ? join(root, `t43-deck-${randomUUID().replace(/-/g, "").slice(0, 12)}-render`) : undefined;
    if (renderDir !== undefined) mkdirSync(renderDir, { recursive: true });
    const result = await createDeckFromSpec(ports, join(snapshotRoot, "pages"), outPath, {
      ...(outlineInSnapshot !== undefined ? { outline: outlineInSnapshot } : {}),
      ...(renderDir !== undefined ? { render: renderDir } : {}),
      ...(input.audit === true ? { audit: true } : {}),
      ...(ports.signal ? { signal: ports.signal } : {}),
    });
    return { result: withPatternFindings(result, patternCheck), mutated: result.ok };
  } finally {
    try { rmSync(snapshotRoot, { recursive: true, force: true }); } catch { /* 清理失败不改变结果 */ }
  }
}

/* ───────────【T73】反模式检查的读取与挂载 ───────────
 *
 * 两件事分开：
 *   - `readDeckPatterns`：从**源** spec 目录读 `pages/*.json` 并跑 `checkDeckPatterns`；
 *   - `withPatternFindings`：把结果挂到 CLI 信封的 `detail.patternFindings` 上。
 *
 * ## 为什么读源目录而不是快照
 *
 * 快照目录在 `finally` 里会被删掉，且它是逐文件拷贝的副本 —— 读源目录更直接，也不
 * 依赖拷贝是否完整。两个目录内容相同（`snapshotDeckSpec` 逐字节拷贝），读哪个都对；
 * 选源目录是因为**它一定存在**（`snapshotDeckSpec` 刚校验过）。
 *
 * ## 失败要显式（CLAUDE.md 硬规矩 3）
 *
 * 读不到 / 解析不了时**不静默跳过**：返回一个 `notes` 数组说明「反模式检查没跑成」，
 * 与「跑了、没问题」区分开。模型看到 `patternChecked: false` 就知道不能当它通过了。
 */
interface PatternCheckOutcome {
  checked: boolean;
  /** 实际执行的判据（来自检查器的 `applied`）。 */
  applied: Record<string, string>;
  findings: PatternFinding[];
  /** 没跑成的原因（checked=false 时非空）。没有问题时为空。 */
  notes: string[];
  /** 页文件名（与 `findings[].page` 的下标一一对应）。渲染时用它代替页号。 */
  pageFiles: string[];
}

export function readDeckPatterns(ports: DocumentSurfacePorts, specDir: string): PatternCheckOutcome {
  const empty = (notes: string[]): PatternCheckOutcome =>
    ({ checked: false, applied: {}, findings: [], notes, pageFiles: [] });
  // 围栏复用 `createDeckFromSpec` 的同一判据（硬规矩 2：共享实现只有一份）——
  // 不新写一套路径检查。`snapshotDeckSpec` 也会过这一道，这里再过一次是因为
  // 本函数**先于**它读盘，且读的是源目录。
  const fence = requireWorkspacePath(ports, specDir, "spec 目录");
  if (fence !== null) return empty([`${fence}；反模式检查没有执行。`]);

  const pagesDir = join(specDir, "pages");
  const dir = existsSync(pagesDir) ? pagesDir : specDir;
  let names: string[];
  try {
    // 与 CLI 的 `listPageFiles` 同一套筛法：`.json`、不认点开头、`outline.json` 不是页、
    // **数字序**排序（`2.json` 在 `10.json` 前）。页号要和 CLI 造出来的页对齐，否则
    // 「第 N 页」会指错。
    names = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".json") && !n.startsWith(".") && n.toLowerCase() !== "outline.json")
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch (error) {
    return empty([`读不到 spec 目录（${dir}）：${error instanceof Error ? error.message : String(error)}；反模式检查没有执行。`]);
  }
  if (names.length === 0) {
    return empty([`spec 目录里没有 .json 页面文件（${dir}）；反模式检查没有执行。`]);
  }
  const pages: DeckPageSpec[] = [];
  const pageFiles: string[] = [];
  const notes: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      // ⚠️ **整体 fail-closed，不是跳过这一页。**
      //
      // 检查器的全部判据都建立在「页序」上（留白按页型、雷同在相邻页之间、页眉条
      // 要求每页都有）。少一页不只是「少查一页」，是**把后面所有页的位置都挪了** ——
      // 于是 findings 里的 `page` 指向错的页，模型照着去改 `pages/NN.json`，改的
      // 正是那个坏文件，越改越糟。宁可整次不报。
      return empty([
        `${name} 解析失败（${error instanceof Error ? error.message : String(error)}）。` +
        `本次反模式检查整体未执行：页序不可信，报出来的页号会指错文件。先把 JSON 修好再谈反模式。`,
      ]);
    }
    const page = asPageSpec(raw);
    if (page === null) {
      // 形状不符**同样**要整体拒绝：它不是「不是页面」（那由 filter 排除了），
      // 而是一个 named `pages/NN.json` 却不是页面的文件 —— 同样会让页号错位。
      return empty([`${name} 不是页面 spec（缺 elements 数组）。本次反模式检查整体未执行：页序不可信。`]);
    }
    pages.push(page);
    pageFiles.push(name);
  }
  const report = checkDeckPatterns(pages);
  return { checked: true, applied: report.applied, findings: report.findings, notes, pageFiles };
}

/**
 * 一个页面文件的形状归一。
 *
 * **一个文件就是一页** —— 与 CLI 的 `listPageFiles` / `buildDeckFromDir` 一致
 * （`pages/NN.json` 各装一个页面对象）。裸数组或 `{pages:[…]}` 写在页文件里会被
 * CLI 当成**一页**去校验并整份失败，所以这里也不展开它们：展开会让页号与真正
 * 造出来的 deck 错位，报出一个根本不存在的「第 3 页」。
 *
 * ⚠️ **`title` / `type` / `layout` 必须原样带过来。** `type` 决定留白阈值分档
 * （content 80% vs closing 55%），`layout` 参与构图雷同指纹。丢了它们，
 * 两条判据会**静默失效**（不报错，只是永远不命中）——这是「接上了但不工作」的
 * 典型形态，T73 套件有专门的 `type:"closing"` 正控盯着它。
 *
 * 认不出来返回 null（由调用方整体拒绝），**不猜**。
 */
function asPageSpec(raw: unknown): DeckPageSpec | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as { elements?: unknown };
  return Array.isArray(obj.elements) ? obj as unknown as DeckPageSpec : null;
}

/** 把反模式结果挂到 CLI 信封上。**不改 CLI 原有的任何字段**，只加 `detail.pattern*`。
 *
 * ## `patternApplied` 按有无 findings 分档（E 实测的噪音）
 *
 * 干净页面的返回里 **92% 是 `applied`**（310 / 336 字符）—— 模型什么都没做错，却要
 * 读一遍「我查了这 7 条规则」。`applied` 不渲染进正文（只有 `pattern*` 里的 hint /
 * findings 会），但它会随 IPC 结构一起返回，长 deck 上仍是纯噪音。所以：
 *   - 无 findings：只给规则名（`patternApplied: string[]`）；
 *   - 有 findings：只给**命中的那几条**规则的说明。
 */
function withPatternFindings(result: GenofficeResult, outcome: PatternCheckOutcome): GenofficeResult {
  if (!result.ok) return result;
  const detail = result.envelope.detail !== null && typeof result.envelope.detail === "object"
    ? result.envelope.detail as Record<string, unknown>
    : {};
  const errors = outcome.findings.filter((f) => f.level === "error");
  const warnings = outcome.findings.filter((f) => f.level === "warning");
  const hitRules = [...new Set(outcome.findings.map((f) => f.rule))];
  const trimmedApplied: Record<string, string> | string[] = outcome.findings.length === 0
    ? Object.keys(outcome.applied)
    : Object.fromEntries(hitRules.filter((r) => r in outcome.applied).map((r) => [r, outcome.applied[r]!]));
  return {
    ok: true,
    envelope: {
      ...result.envelope,
      detail: {
        ...detail,
        // 检查是否真的跑了 —— 与「跑了、没问题」必须能区分（硬规矩 3）。
        patternChecked: outcome.checked,
        ...(outcome.checked
          ? {
              patternFindings: outcome.findings,
              patternCounts: { error: errors.length, warning: warnings.length },
              patternApplied: trimmedApplied,
              // 页号 → 文件名。finding 的 `page` 是数组下标，模型要改的是**文件**；
              // 两者靠「排序后位置一致」这个隐含假设绑在一起，不如直接给文件名。
              patternPageFiles: outcome.pageFiles,
              ...(outcome.findings.length > 0
                ? {
                    patternHint:
                      `反模式检查发现 ${errors.length} 个 error / ${warnings.length} 个 warning。` +
                      `这些**不影响本次 build**（文件已生成），但规范把其中 error 一类列为缺陷 —— ` +
                      `改对应的 pages/NN.json 后用 build_deck 重建（或 slides replace 单页替换）。`,
                  }
                : { patternHint: "反模式检查未发现问题。" }),
            }
          : {}),
        ...(outcome.notes.length > 0 ? { patternNotes: outcome.notes } : {}),
      },
    },
  };
}

/** `docs read` 的视图开关（revisions/comments/notes/styles）是 `docs read` 的选项，
 *  不是独立命令；透传走 `docsRead` 的 T24 选项。 */
async function docsReadWithFlag(
  ports: DocumentSurfacePorts, file: string, flag: string, signal: AbortSignal | undefined,
): Promise<GenofficeResult> {
  const options = { ...(signal ? { signal } : {}) };
  switch (flag) {
    case "--revisions": return docsRead(ports, file, { ...options, revisions: true });
    case "--comments": return docsRead(ports, file, { ...options, comments: true });
    case "--notes": return docsRead(ports, file, { ...options, notes: true });
    case "--styles": return docsRead(ports, file, { ...options, styles: true });
    default: return docsRead(ports, file, options);
  }
}

async function readPdf(
  ports: DocumentSurfacePorts, file: string, options: { page?: number; range?: string; signal?: AbortSignal },
): Promise<GenofficeResult> {
  const { pdfRead } = await import("./genofficeCli.js");
  return pdfRead(ports, file, options);
}

/** 从渲染端 ACK 的 output 里取是否真的改了文件：vendor 工具的返回没有统一字段，所以
 *  以「工具是否在 mutating 表里」+「ACK status=success」为准；dryRun 不适用。 */
export async function documentToolCall(
  ports: DocumentSurfacePorts,
  args: {
    tool: string;
    app?: DocumentToolApp;
    filePath: string;
    input?: Record<string, unknown>;
    dryRun?: boolean;
    track?: boolean;
  },
): Promise<DocumentToolCallResult> {
  const entry = findDocumentTool(args.tool, args.app);
  if (!entry) {
    return refusal(`没有这个文档工具：${args.tool}。先 document_tools_list({query}) 查。`);
  }
  const refusalPath = requireWorkspacePath(ports, args.filePath, "文档路径");
  if (refusalPath !== null) return refusal(refusalPath);
  const filePath = args.filePath;
  const input = args.input ?? {};
  const mutating = isMutatingDocumentTool(entry.app, entry.name);
  // 渲染端路线只在**有活跃受信绑定**时可用（invoke + 原始定义都由 T0 请求绑定的
  // 登记簿提供）；否则走 CLI 等价命令。二者都不可用 → 显式拒绝。
  const useRenderer = ports.rendererOpen(filePath) && typeof ports.invokeRendererTool === "function";

  if (useRenderer && ports.invokeRendererTool) {
    const definition = ports.rendererToolDefinition ? ports.rendererToolDefinition(entry.name, filePath) : null;
    if (definition === null) {
      return refusal(`工具 ${entry.name} 不在该文件当前文档 AI 请求声明的工具表里（渲染端没有同意执行它），本次未执行。`);
    }
    const ack = await ports.invokeRendererTool({ id: `t24-${randomUUID()}`, name: entry.name, input }, definition, filePath);
    if (ack.status !== "success") {
      return { ok: false, kind: ack.status === "cancelled" ? "refused" : "failed", reason: ack.output || `编辑器返回 ${ack.status}` };
    }
    const qa = mutating && args.dryRun !== true ? await runQaGate(ports, entry.app, filePath) : null;
    const revision = mutating && args.dryRun !== true ? await fileContentVersion(filePath).catch(() => null) : undefined;
    return {
      ok: true,
      route: "renderer",
      text: [ack.output, qa ? formatQaReport(entry.app, qa) : ""].filter(Boolean).join("\n\n"),
      mutated: mutating && args.dryRun !== true,
      ...(qa ? { qa: qaToWire(qa) } : {}),
      ...(revision !== undefined ? { revision } : {}),
    };
  }

  const { result, mutated } = await executeCliTool(ports, entry.app, entry.name, filePath, input, {
    ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
    ...(args.track !== undefined ? { track: args.track } : {}),
  });
  if (!result.ok) {
    return { ok: false, kind: result.kind, reason: result.reason, ...(result.kind === "refused" ? { suggestions: ["先用 document_tools_list({cliOnly:true}) 看 CLI 能承载哪些工具。"] } : {}) };
  }
  const qa = mutated ? await runQaGate(ports, entry.app, filePath) : null;
  const revision = mutated ? await fileContentVersion(filePath).catch(() => null) : undefined;
  return {
    ok: true,
    route: "cli",
    text: [envelopeText(result), qa ? formatQaReport(entry.app, qa) : ""].filter(Boolean).join("\n\n"),
    mutated,
    ...(qa ? { qa: qaToWire(qa) } : {}),
    ...(revision !== undefined ? { revision } : {}),
  };
}

function qaToWire(qa: DocumentQaReport): { gate: "check" | "audit" | "render-probe"; ok: boolean; issues: unknown[]; counts?: Record<string, number>; summary?: string } {
  return {
    gate: qa.gate, ok: qa.ok, issues: [...qa.issues],
    ...(qa.counts ? { counts: qa.counts } : {}),
    ...(qa.summary ? { summary: qa.summary } : {}),
  };
}

/* ───────────────────────── Markdown 载体 ───────────────────────── */

export async function documentMarkdownRead(
  ports: DocumentSurfacePorts,
  args: { filePath: string; range?: string },
): Promise<DocumentMarkdownReadResult> {
  const refusalPath = requireWorkspacePath(ports, args.filePath, "文档路径");
  if (refusalPath !== null) return { ok: false, kind: "refused", reason: refusalPath };
  // 【T43】缺口五：以前一律 `docs read`（Word 专属），于是 xlsx/pptx/pdf/md/html
  // 全都读不了 —— 用户说的「读文件也不全面」。现在按扩展名分派到各自的原厂命令：
  //   docx → docs read / xlsx → sheet read / pptx → slides read / pdf → pdf read /
  //   md·txt·csv·源码·html → 直接读文件（convert 不支持 md→md、html→md，实测）。
  const read = await readAnyDocument(ports, args.filePath, {
    ...(args.range ? { range: args.range } : {}),
    ...(ports.signal ? { signal: ports.signal } : {}),
  });
  if (!read.ok) return { ok: false, kind: read.kind === "refused" ? "refused" : read.kind === "unavailable" ? "unavailable" : "failed", reason: read.reason };
  const converted = blocksToMarkdown(read.envelope.detail);
  if (converted === null) return { ok: false, kind: "failed", reason: "读取结果的信封里没有 detail.items；无法生成带定位符的 Markdown。" };
  const revision = await fileContentVersion(args.filePath).catch(() => null);
  const detail = read.envelope.detail as { via?: unknown; structured?: unknown; truncated?: unknown } | null;
  const via = typeof detail?.via === "string" ? detail.via : "unknown";
  const structured = detail?.structured === true;
  // 【T43】「怎么读的 / 是不是结构读 / 有没有截断」必须让模型看见 —— 否则它会把
  // xlsx 的线性摘要当成 Word 的块索引去用。以前这三项没地方放；现在压在正文的
  // 第一行注释里（Markdown 注释不会污染渲染，也不改契约类型）。
  const header = [
    `<!-- read via ${via}${structured ? " (structured)" : " (linear)"}${detail?.truncated === true ? ", TRUNCATED" : ""} -->`,
    ...(detail?.truncated === true ? ["<!-- 文件超过 2 MiB，只读了前面一部分 -->"] : []),
  ].join("\n");
  return {
    ok: true,
    filePath: args.filePath,
    markdown: `${header}\n\n${converted.markdown}`,
    blocks: converted.blocks,
    revision,
  };
}

/** 内部：把一段 Markdown 变成 restricted HTML 片段（CLI 的 md→html，再剥出 body）。
 *  临时文件必须落在**工作区内**（CLI 的 `convert` 与其它命令共用同一道路径围栏，
 *  工作区外的临时目录会被它自己拒绝）—— 所以调用方传进来的 `tempDir` 是
 *  「目标文件同目录下的点目录」，用完即删。 */
async function markdownToFragment(
  ports: DocumentSurfacePorts, markdown: string, tempDir: string, token: string,
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  const fs = ports.fs ?? { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync };
  const mdPath = join(tempDir, `md-${token}.md`);
  const htmlPath = join(tempDir, `md-${token}.html`);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(mdPath, markdown, "utf8");
  try {
    const converted = await convertFile(ports, mdPath, "html", htmlPath, ports.signal ? { signal: ports.signal } : {});
    if (!converted.ok) return { ok: false, reason: `Markdown 转 HTML 失败：${converted.reason}` };
    const raw = fs.readFileSync(htmlPath, "utf8");
    const body = /<body>([\s\S]*)<\/body>/i.exec(raw);
    const fragment = (body ? body[1]! : raw).trim();
    if (fragment === "") return { ok: false, reason: "Markdown 转出的 HTML 片段为空。" };
    return { ok: true, html: sanitizeRestrictedHtml(fragment) };
  } finally {
    try { fs.rmSync(mdPath, { force: true }); } catch { /* 临时文件清理失败不改变结果 */ }
    try { fs.rmSync(htmlPath, { force: true }); } catch { /* 同上 */ }
  }
}

/**
 * GenOffice 的 md→html 会带 `<div class="tableWrapper">`、`<colgroup>`、单元格里的
 * `<p>` 与 `style`/`colspan` 属性；restricted HTML 解析器遇到 div 包着的表格会把它
 * 降级成纯文本段落（实测：表格消失、只剩「AB12」）。这里按 restricted 标签集洗一遍：
 * 去掉 div/colgroup/col/span，剥 style/colspan/rowspan，单元格里的 `<p>` 解包。
 * 这不是通用 sanitizer —— 它只服务「md→html 的输出」这一种输入（其余标签原样保留，
 * 由 CLI 自己的解析器裁决）。
 */
export function sanitizeRestrictedHtml(html: string): string {
  return html
    .replace(/<\/?div[^>]*>/gi, "")
    .replace(/<colgroup>[\s\S]*?<\/colgroup>/gi, "")
    .replace(/<\/?col[^>]*>/gi, "")
    .replace(/<\/?span[^>]*>/gi, "")
    .replace(/\s(?:style|colspan|rowspan)="[^"]*"/gi, "")
    .replace(/<code class="[^"]*">/gi, "<code>")
    .replace(/<p>((?:(?!<p>|<\/p>)[\s\S])*?)<\/p>(?=\s*<\/t[dh]>)/gi, "$1")
    .trim();
}

export async function documentMarkdownEdit(
  ports: DocumentSurfacePorts,
  args: { filePath: string; operations: DocumentMarkdownOperation[]; track?: boolean; dryRun?: boolean },
): Promise<DocumentMarkdownEditResult> {
  const refusalPath = requireWorkspacePath(ports, args.filePath, "文档路径");
  if (refusalPath !== null) return { ok: false, kind: "refused", reason: refusalPath };
  // 临时 Markdown/HTML 放在**目标文件同目录**下的点目录：CLI 的 convert 与 apply
  // 共用同一条工作区围栏，数据根下的临时目录不在任何工作区内，会被 CLI 自己拒绝。
  // 同目录保证源与产物都在围栏内；用完（含失败）即删整个目录。
  const workDir = join(dirname(args.filePath), ".mcode-t24-md");
  const token = randomUUID().replace(/-/g, "").slice(0, 12);
  const tempDir = join(workDir, token);
  const ops: unknown[] = [];
  try {
    for (const operation of args.operations) {
      if (operation.op === "delete") {
        ops.push({ op: "deleteBlocks", target: { blockIndexes: spanIndexes(operation.startBlock, operation.endBlock) } });
        continue;
      }
      const fragment = await markdownToFragment(ports, operation.markdown, tempDir, token);
      if (!fragment.ok) return { ok: false, kind: "failed", reason: fragment.reason };
      if (operation.op === "append") {
        ops.push({ op: "insert_content", html: fragment.html });
      } else if (operation.op === "insert") {
        ops.push({ op: "insert_content", html: fragment.html, afterBlockIndex: operation.afterBlock });
      } else {
        ops.push({ op: "replace_blocks", startBlockIndex: operation.startBlock, endBlockIndex: operation.endBlock, html: fragment.html });
      }
    }
  } finally {
    try { (ports.fs ?? { rmSync }).rmSync?.(workDir, { recursive: true, force: true }); } catch { /* 清理失败不改变结果 */ }
  }
  const applied = await docsApply(ports, args.filePath, ops, {
    ...(args.dryRun ? { dryRun: true } : {}),
    ...(args.track !== false ? { track: true } : {}),
    ...(ports.signal ? { signal: ports.signal } : {}),
  });
  if (!applied.ok) {
    return { ok: false, kind: applied.kind === "refused" ? "refused" : applied.kind === "unavailable" ? "unavailable" : "failed", reason: applied.reason };
  }
  const qa = args.dryRun ? null : await runQaGate(ports, "docs", args.filePath);
  const reread = args.dryRun ? null : await docsRead(ports, args.filePath, { full: false, ...(ports.signal ? { signal: ports.signal } : {}) });
  const blocks = reread?.ok ? Number((reread.envelope.detail as { blocks?: unknown } | null)?.blocks ?? 0) : 0;
  const revision = await fileContentVersion(args.filePath).catch(() => null);
  const batch = (applied.envelope.detail as { batch?: { applied?: number } } | null)?.batch;
  return {
    ok: true,
    applied: typeof batch?.applied === "number" ? batch.applied : ops.length,
    blocks,
    ...(qa ? { qa: qaToWire(qa) } : {}),
    revision,
    text: [envelopeText(applied), qa ? formatQaReport("docs", qa) : ""].filter(Boolean).join("\n\n"),
  };
}

function spanIndexes(start: number, end: number): number[] {
  if (end < start) [start, end] = [end, start];
  return Array.from({ length: Math.min(500, end - start + 1) }, (_, i) => start + i);
}

/* ───────────────────────── 出图 ───────────────────────── */

export async function documentRender(
  ports: DocumentSurfacePorts,
  args: { filePath: string; page?: number; scale?: number },
): Promise<DocumentRenderResult> {
  const refusalPath = requireWorkspacePath(ports, args.filePath, "文档路径");
  if (refusalPath !== null) return { ok: false, kind: "refused", reason: refusalPath };
  const outDir = join(ports.renderTempRoot(), `render-${randomUUID().replace(/-/g, "").slice(0, 12)}`);
  const output = await renderDocument(ports, args.filePath, outDir, {
    ...(args.page !== undefined ? { page: args.page } : {}),
    ...(args.scale !== undefined ? { scale: args.scale } : {}),
    ...(ports.signal ? { signal: ports.signal } : {}),
  });
  const parsed = parseRenderFiles(output, existsSync);
  if (!parsed.ok) {
    return { ok: false, kind: output.ok ? "failed" : output.kind === "refused" ? "refused" : output.kind === "unavailable" ? "unavailable" : "failed", reason: parsed.note };
  }
  return { ok: true, files: [...parsed.files], note: parsed.note };
}

/** 兼容导出：给 IPC 层一个 `existsSync` 注入点（无头套件可换成假的）。 */
export function defaultRenderExists(path: string): boolean {
  return existsSync(path);
}
