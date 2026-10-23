/**
 * 【ARC-007 G0 轨道】**GenOffice CLI 的受控适配层**（主进程）。
 *
 * ## 它是什么
 *
 * 把 `<repo>/genoffice/packages/cli/dist/genoffice.cjs` 当作**固定版本的可执行能力**
 * 调用：`docs read/apply`、`slides read/apply`、`sheet read/apply`、`convert`、
 * `create`、`pdf read` 等。这是 G0 评估推荐的"方案 C"：先用 CLI/无头能力，
 * 不把 GenOffice 的 Electron 主进程跑第二遍，也不引入它自带的 agent 对话。
 *
 * ## 安全边界（与台账"不可让步"逐条对应）
 *
 *  1. **路径围栏**：每一次调用的输入/输出路径都必须落在某个已知工作区根内
 *     （复用 `isKnownWorkspaceRoot` / `resolveModuleResource` 同一条判据）——
 *     CLI 不能成为绕过 Mcode 授权直接写盘的第二个入口。
 *  2. **不传凭据**：子进程环境**不继承**宿主环境（只给 PATH 与 ELECTRON_RUN_AS_NODE），
 *     避免把 API key / 代理配置带进第三方代码（与 `permissionedProcessRunner` 同取向）。
 *  3. **不联网**：CLI 的云端能力在本适配层**不暴露**；`app_unavailable` / `cloud`
 *     一类错误原样返回给调用方，由 UI/Agent 决定是否告知用户安装/配置。
 *  4. **失败可诊断**：CLI 的 `--json` 信封 `{status, command, code, error, message, detail}`
 *     原样解析；退出码与 `error` 码分开保留，绝不把"工具没装"说成"文档坏了"。
 *
 * ## 它不做什么
 *
 * - 不管理文档会话（那是后续 DocumentSessionRegistry 的职责）；
 * - 不做 CAS/版本（CLI 自己在 apply 时读写同一文件；Mcode 侧的版本保护在
 *   接入保存链路时补，见计划 B.2）；
 * - 不 import Electron / DB —— 纯 Node，可被无头套件直接驱动。
 */
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawnRun } from "@main/lib/spawnRun.js";

/** CLI 的 JSON 信封（与 GenOffice `result.ts` 同形，只取需要的字段）。 */
export interface GenofficeEnvelope {
  status: "ok" | "error";
  command?: string;
  summary?: string;
  output_path?: string;
  error?: string;
  code?: number;
  message?: string;
  detail?: unknown;
}

export type GenofficeResult =
  | { ok: true; envelope: GenofficeEnvelope }
  /** `kind` 区分"能力不可用(需 headless Electron/原生 sidecar)"与"执行失败" ——
   *  前者不是文档坏了，调用方该给出安装/配置指引而不是报错重试。 */
  | { ok: false; kind: "unavailable" | "failed" | "refused"; envelope: GenofficeEnvelope | null; reason: string };

export interface GenofficePorts {
  /** CLI bundle 的绝对路径。生产由装配方给（见 `resolveGenofficeCliPath`）。 */
  cliPath: string;
  /** 路径是否在已知工作区根内。生产传 `isKnownWorkspaceRoot`（经 `findContainingWorkspaceRoot`
   *  做包含判定）。测试可传桩。 */
  withinWorkspace(path: string): boolean;
  /** 额外环境变量（测试/诊断用；生产留空）。**不会**继承宿主 env。 */
  env?: NodeJS.ProcessEnv;
  /** 超时（毫秒）。CLI 的 read/apply 都是同步短任务；默认 60s。 */
  timeoutMs?: number;
}

/** 解析随仓库快照的 CLI bundle 路径。**固定 commit 的 vendor 快照**，不是全局安装。 */
function regularResourceFile(file: string): boolean {
  try { const stat = lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); }
  catch { return false; }
}
function isPdfiumWasm(file: string): boolean {
  if (!regularResourceFile(file)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const header = Buffer.alloc(8);
    if (readSync(fd, header, 0, 8, 0) !== 8) return false;
    return header.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function ordinaryResourceDir(dir: string): boolean {
  try { const stat = lstatSync(dir); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch { return false; }
}

export function resolveGenofficeCliPath(repoRoot: string, resourcesDir?: string): string | null {
  const resources = resourcesDir ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources !== undefined) {
    if (!isAbsolute(resources)) return null;
    const devResources = resourcesDir === undefined
      && (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true;
    try {
      const stat = lstatSync(resources);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !devResources) return null;
    }
    const base = join(resources, "genoffice");
    // Electron development may have an unrelated resourcesPath without a
    // GenOffice stage. An EXPLICIT packaged root, however, must never fall
    // back to source-tree code when the release marker says unavailable.
    const electronProcess = process as NodeJS.Process & { defaultApp?: boolean };
    // Electron's defaultApp flag distinguishes an unpackaged development
    // launch. A real installed app may have a deleted resources/genoffice/
    // directory: NEVER execute a nearby source checkout in that situation.
    const suppliedBundle = resourcesDir !== undefined || existsSync(base)
      || electronProcess.defaultApp !== true;
    if (suppliedBundle) {
      const marker = join(base, "availability.json");
      if (!ordinaryResourceDir(base) || !regularResourceFile(marker) || lstatSync(marker).size > 8192) return null;
      let info: { format?: unknown; bundled?: unknown };
      try { info = JSON.parse(readFileSync(marker, "utf8")) as typeof info; }
      catch { return null; }
      if (info.format !== "mcode.genoffice.resources.v1" || info.bundled !== true) return null;
      const cliDir = join(base, "cli");
      const cli = join(cliDir, "genoffice.cjs");
      const wasmDir = join(base, "wasm");
      if (!ordinaryResourceDir(cliDir) || !ordinaryResourceDir(wasmDir)
        || !ordinaryResourceDir(join(cliDir, "node_modules"))
        || !isPdfiumWasm(join(wasmDir, "pdfium.wasm"))
        || !regularResourceFile(cli)) return null;
      return cli;
    }
  }
  const source = join(repoRoot, "genoffice");
  const candidate = join(source, "packages", "cli", "dist", "genoffice.cjs");
  if (!ordinaryResourceDir(source) || !regularResourceFile(candidate)) return null;
  return candidate;
}

/** 一次 CLI 调用的共同外壳：参数校验 → 路径围栏 → 起进程 → 解析信封。 */
async function invoke(
  ports: GenofficePorts,
  args: readonly string[],
  options: { signal?: AbortSignal; stdin?: string } = {},
): Promise<GenofficeResult> {
  if (!existsSync(ports.cliPath)) {
    return { ok: false, kind: "unavailable", envelope: null, reason: `GenOffice CLI 不存在:${ports.cliPath}` };
  }
  const path = process.env.PATH ?? process.env.Path ?? "";
  const result = await spawnRun({
    command: process.execPath,
    args: [ports.cliPath, ...args],
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    // **不继承宿主环境**：只给运行所需的最小集合（见文件头第 2 条）。
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(path ? { PATH: path } : {}),
      ...(ports.env ?? {}),
    },
    timeoutMs: ports.timeoutMs ?? 60_000,
    signal: options.signal ?? new AbortController().signal,
    limitBytes: 512 * 1024,
  });
  if (result.spawnError) {
    return { ok: false, kind: "unavailable", envelope: null, reason: `CLI 启动失败:${result.spawnError.message}` };
  }
  if (result.killedBy.timeout) {
    return { ok: false, kind: "failed", envelope: null, reason: `CLI 超时(${ports.timeoutMs ?? 60_000} 毫秒)` };
  }
  // A cancelled command can exit 0/1 or leave a buffered success envelope.
  // Cancellation wins over stdout; never present stale output as committed.
  if (result.killedBy.abort) {
    return { ok: false, kind: "failed", envelope: null, reason: "GenOffice CLI 操作已取消" };
  }
  // GenOffice uses one-line JSON envelopes. If spawnRun has dropped the
  // beginning of that line, the remaining tail is NOT a valid response even
  // when the child exits 0. Report the stdout budget instead of disguising
  // this as missing/malformed JSON or accidentally accepting a late fragment.
  if (result.stdoutTruncated || result.stdoutLineTruncated) {
    return {
      ok: false, kind: "failed", envelope: null,
      reason: "GenOffice CLI 输出超过 524288 字节上限；请使用原生 --range/--max-chars 等选项缩小读取范围",
    };
  }
  // CLI 的 `--json` 把信封打到 stdout;stderr 只在崩溃时才有内容。
  const jsonLines = result.stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  if (jsonLines.length > 1) {
    return { ok: false, kind: "failed", envelope: null,
      reason: `GenOffice CLI 返回多个 JSON 信封(${jsonLines.length})，无法安全判定哪一份是真实结果` };
  }
  const line = jsonLines[0];
  if (line === undefined) {
    return {
      ok: false, kind: "failed", envelope: null,
      reason: `CLI 没有返回 JSON 信封(退出码 ${String(result.code)}):${(result.stderr || result.stdout).trim().slice(0, 400)}`,
    };
  }
  let envelope: GenofficeEnvelope;
  try {
    envelope = JSON.parse(line) as GenofficeEnvelope;
  } catch {
    return { ok: false, kind: "failed", envelope: null, reason: `CLI 返回的 JSON 解析失败:${line.slice(0, 200)}` };
  }
  if (envelope === null || typeof envelope !== "object" || !["ok", "error"].includes(envelope.status)) {
    return { ok: false, kind: "failed", envelope: null, reason: "GenOffice CLI JSON 信封缺少合法 status" };
  }
  if (envelope.status === "ok") {
    if (result.code !== 0) {
      return { ok: false, kind: "failed", envelope,
        reason: `GenOffice CLI 退出码 ${String(result.code)} 非零，拒绝将 status=ok 当作成功` };
    }
    return { ok: true, envelope };
  }
  // 能力不可用 vs 执行失败：code 4 = app_unavailable；conversion_failed + hint = 原生资源缺失。
  const unavailable = envelope.code === 4 || envelope.error === "app_unavailable"
    || (envelope.error === "conversion_failed" && typeof (envelope.detail as { hint?: unknown } | undefined)?.hint === "string");
  return {
    ok: false,
    kind: unavailable ? "unavailable" : "failed",
    envelope,
    reason: typeof envelope.message === "string" ? envelope.message
      : typeof envelope.error === "string" ? envelope.error : "CLI 执行失败",
  };
}

/** 路径围栏：绝对路径 + 落在已知工作区根内。**任何**输入/输出路径都要过它。 */
export function requireWorkspacePath(ports: Pick<GenofficePorts, "withinWorkspace">, path: string, label: string): string | null {
  if (typeof path !== "string" || path.trim() === "") return `${label} 为空`;
  if (!isAbsolute(path)) return `${label} 必须是绝对路径:${path}`;
  const abs = resolve(path);
  if (!ports.withinWorkspace(abs)) return `${label} 不在任何已知工作区内:${abs}`;
  // Lexical checks do not resolve NTFS junctions/symlinks. For an existing
  // source/output, check its real destination; for a new output, resolve its
  // nearest existing ancestor before appending the missing path suffix.
  // This keeps a link within the project from reaching files outside it.
  let canonical: string;
  try {
    canonical = realpathSync.native(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return `${label} 真实路径无法验证:${abs} (${String(code)})`;
    // A dangling final symlink must not be treated as a new regular output.
    try {
      if (lstatSync(abs).isSymbolicLink()) return `${label} 是悬空符号链接:${abs}`;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
        return `${label} 路径状态无法验证:${abs}`;
      }
    }
    const missing: string[] = [basename(abs)];
    let parent = dirname(abs);
    for (;;) {
      try {
        canonical = resolve(realpathSync.native(parent), ...missing);
        break;
      } catch (parentError) {
        const parentCode = (parentError as NodeJS.ErrnoException).code;
        if (parentCode !== "ENOENT" || dirname(parent) === parent) {
          return `${label} 父目录真实路径无法验证:${parent} (${String(parentCode)})`;
        }
        missing.unshift(basename(parent));
        parent = dirname(parent);
      }
    }
  }
  if (!ports.withinWorkspace(canonical)) return `${label} 经符号链接解析后不在工作区内:${canonical}`;
  return null;
}

/** `docs read`：只读列出 docx 的块。 */
export async function docsRead(
  ports: GenofficePorts, file: string, options: {
    full?: boolean; range?: string; maxChars?: number; signal?: AbortSignal;
    /** 【T24】`docs read` 的视图开关（CLI 没有独立命令，这些是它的选项）。 */
    revisions?: boolean; comments?: boolean; notes?: boolean; styles?: boolean; headerFooter?: boolean; sections?: boolean; fields?: boolean; html?: boolean;
  } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "文档路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["docs", "read", file, "--json"];
  if (options.full) args.push("--full");
  if (options.range !== undefined) args.push("--range", options.range);
  if (options.maxChars !== undefined) args.push("--max-chars", String(options.maxChars));
  if (options.revisions) args.push("--revisions");
  if (options.comments) args.push("--comments");
  if (options.notes) args.push("--notes");
  if (options.styles) args.push("--styles");
  if (options.headerFooter) args.push("--header-footer");
  if (options.sections) args.push("--sections");
  if (options.fields) args.push("--fields");
  if (options.html) args.push("--html");
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}

/** `pdf read`：复用 GenOffice 自带 PDFium 文本层与页面元信息，不另写 PDF 解析器。 */
export async function pdfRead(
  ports: GenofficePorts,
  file: string,
  options: { page?: number; range?: string; full?: boolean; maxChars?: number; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "PDF 路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  if (options.page !== undefined && options.range !== undefined) {
    return { ok: false, kind: "refused", envelope: null, reason: "PDF 的 page 与 range 不能同时提供" };
  }
  const args = ["pdf", "read", file, "--json"];
  if (options.page !== undefined) args.push("--page", String(options.page));
  if (options.range !== undefined) args.push("--range", options.range);
  if (options.full) args.push("--full");
  if (options.maxChars !== undefined) args.push("--max-chars", String(options.maxChars));
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}

/** GenOffice 原生 PDFium 页面渲染：PNG 文件落到调用方受控的临时目录。 */
export async function pdfRender(
  ports: GenofficePorts,
  file: string,
  outDir: string,
  page: number,
  scale = 1,
  options: { signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "PDF 路径")
    ?? requireWorkspacePath(ports, outDir, "渲染输出目录");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(scale) || scale <= 0 || scale > 4) {
    return { ok: false, kind: "refused", envelope: null, reason: "page/scale 参数超出 GenOffice 渲染限制" };
  }
  return invoke(ports, ["render", file, "--out", outDir, "--page", String(page), "--scale", String(scale), "--json"],
    options.signal ? { signal: options.signal } : {});
}

/** Serialize before invoking the original GenOffice CLI. JSON cycles, BigInt
 * and oversized operation sets are refused rather than crashing IPC or
 * spawning a child with unbounded stdin. */
function editorOpsStdin(ops: unknown): string | null {
  try {
    const json = JSON.stringify(ops);
    return typeof json === "string" && Buffer.byteLength(json, "utf8") <= 32 * 1024 * 1024 ? json : null;
  } catch {
    return null;
  }
}
function refusedEditorOps(): GenofficeResult {
  return { ok: false, kind: "refused", envelope: null, reason: "编辑操作不是有效 JSON，或超过 32MiB 输入上限" };
}

/** `docs apply`：按 ops 编辑 docx。`dryRun` 只演练不写盘。 */
export async function docsApply(
  ports: GenofficePorts,
  file: string,
  ops: unknown,
  options: { dryRun?: boolean; track?: boolean; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "文档路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const stdin = editorOpsStdin(ops);
  if (stdin === null) return refusedEditorOps();
  const args = ["docs", "apply", file, "--ops", "-", "--json"];
  if (options.dryRun) args.push("--dry-run");
  if (options.track) args.push("--track");
  return invoke(ports, args, {
    stdin,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** `slides read` / `sheet read`（同一形状，`domain` 区分）。 */
export async function slidesRead(
  ports: GenofficePorts, file: string, signal?: AbortSignal,
  options: { slide?: number; maxChars?: number } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "演示文稿路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["slides", "read", file, "--json"];
  if (options.slide !== undefined) args.push("--slide", String(options.slide));
  if (options.maxChars !== undefined) args.push("--max-chars", String(options.maxChars));
  return invoke(ports, args, signal ? { signal } : {});
}

export async function sheetRead(
  ports: GenofficePorts, file: string, signal?: AbortSignal,
  options: { sheet?: string; range?: string; maxRows?: number } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "表格路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["sheet", "read", file, "--json"];
  if (options.sheet !== undefined) args.push("--sheet", options.sheet);
  if (options.range !== undefined) args.push("--range", options.range);
  if (options.maxRows !== undefined) args.push("--max-rows", String(options.maxRows));
  return invoke(ports, args, signal ? { signal } : {});
}

/** `slides apply`：按 ops 编辑 pptx。与 `docsApply` **同一条围栏与信封口径**
 *  （围栏先于起进程；`dryRun` 只演练不写盘）。
 *
 *  为什么必须单列：`docs apply` 只认 docx，对 pptx/xlsx 会报
 *  `conversion_failed: document.xml has no <w:body> element` —— 那是 docx 内部
 *  解析器的错误，既不是"文档坏了"也不是"能力没装"，拿它回给调用方就是误导。
 *  slides/sheet 各有自己的 apply 子命令（纯 Node，不需要 sidecar）。 */
export async function slidesApply(
  ports: GenofficePorts,
  file: string,
  ops: unknown,
  options: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "演示文稿路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const stdin = editorOpsStdin(ops);
  if (stdin === null) return refusedEditorOps();
  const args = ["slides", "apply", file, "--ops", "-", "--json"];
  if (options.dryRun) args.push("--dry-run");
  return invoke(ports, args, {
    stdin,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** `sheet apply`：按 ops 编辑 xlsx（纯 Node 写路径，不需要 Rust sidecar）。 */
export async function sheetApply(
  ports: GenofficePorts,
  file: string,
  ops: unknown,
  options: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "表格路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const stdin = editorOpsStdin(ops);
  if (stdin === null) return refusedEditorOps();
  const args = ["sheet", "apply", file, "--ops", "-", "--json"];
  if (options.dryRun) args.push("--dry-run");
  return invoke(ports, args, {
    stdin,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** `guide <domain> [op]`：机器可读的 ops 目录（`--json`）。Agent 据此知道"能做哪些编辑操作"，
 *  而不是靠猜 op 名。只读、不碰文件。 */
export async function guideOps(
  ports: GenofficePorts, domain: "docs" | "slides" | "sheet" | "pdf" | "markdown", op?: string, signal?: AbortSignal,
): Promise<GenofficeResult> {
  const args = ["guide", domain, "--json"];
  if (op !== undefined) args.push(op);
  return invoke(ports, args, signal ? { signal } : {});
}

/* ───────────────【T24】QA 门禁与出图：编辑后**必须**跑的 check / audit / render ───────────────
 *
 * 上游 SKILL.md 的 `## Before you say "done"` 是这三条（check → render → report）。
 * Mcode 侧的 `document_tool_call` 在每次编辑后强制调用它们，把 `detail.issues` 回给模型。
 * 三个命令都**在 exit 0 时也可能带问题**（issues 在 detail 里），调用方必须读 detail。 */

/** `docs check <docx>`：字段/引用/目录/图片/标题层级/占位文本/待处理修订/未解决批注。 */
export async function docsCheck(
  ports: GenofficePorts, file: string, options: { signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "文档路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  return invoke(ports, ["docs", "check", file, "--json"], options.signal ? { signal: options.signal } : {});
}

/** `sheet check <xlsx>`：公式错误/缺失表引用/坏定义名/图表区间/列宽溢出/占位文本。 */
export async function sheetCheck(
  ports: GenofficePorts, file: string, options: { signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "表格路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  return invoke(ports, ["sheet", "check", file, "--json"], options.signal ? { signal: options.signal } : {});
}

/** `slides audit <pptx>`：几何审计（越界/出画布/文字溢出/重叠/图片变形）。 */
export async function slidesAudit(
  ports: GenofficePorts, file: string, options: { page?: number; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "演示文稿路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["slides", "audit", file, "--json"];
  if (options.page !== undefined) args.push("--slide", String(options.page - 1));
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}

/**
 * 【T43】Markdown / HTML / 纯文本 → PDF 与 DOCX 的**真检查**。
 *
 * 上游没有 `markdown check` / `html check` 命令（`genoffice <command>` 列表里
 * 只有 docs/sheet/slides 三家的 check/audit）。但这三家之外**确实**有可用的
 * 检查手段：`render` 会真的排版一遍，排版不了的文档会 `conversion_failed`；
 * 对 `create` 出来的产物还能再跑一次目标格式自己的 check。
 *
 * 所以这里的门禁是**两道**，都跑真命令、都读返回：
 *   1. `render --page 1`：能否被原厂渲染器排版（打不开/坏 HTML = 直接失败）；
 *   2. 若调用方给了**刚创建的**同类产物（docx），再跑一次 `docs check`。
 *
 * 为什么不是「假门禁」：第一道是真的会失败（坏 HTML、缺字体、超出渲染限制），
 * 只是它检的是**可渲染性**而不是内容质量 —— 这一点在 `formatQaReport` 的措辞里
 * 写明，不假装它等于 `docs check`。
 */
export async function renderProbeCheck(
  ports: GenofficePorts, file: string, outDir: string, options: { signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "渲染源文件")
    ?? requireWorkspacePath(ports, outDir, "渲染输出目录");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  return invoke(ports, ["render", file, "--out", outDir, "--page", "1", "--json"],
    options.signal ? { signal: options.signal } : {});
}

/**
 * 【T43】`slides check <outline.json | page.json>` —— 设计流水线的**规格检查**。
 *
 * 上游 `slides check` 不只看 pptx：对 `outline.json` 与逐页 `NN.json` 它会
 * 检查字段、布局库、占位文本、调色板一致性，并在页面与大纲不符时 **exit 1**。
 * 这是「做出来会不会好看」的第一道闸门，模型必须在写下一页之前用它。
 */
export async function slidesCheck(
  ports: GenofficePorts, file: string, options: { outline?: string; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "规格文件路径")
    ?? (options.outline !== undefined ? requireWorkspacePath(ports, options.outline, "大纲文件路径") : null);
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["slides", "check", file, "--json"];
  if (options.outline !== undefined) args.push("--outline", options.outline);
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}

/** 【T43】`slides replace <pptx> --slide n --spec <page.json>`：只重建一页。 */
export async function slidesReplace(
  ports: GenofficePorts, file: string, slideIndex: number, spec: string,
  options: { signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "演示文稿路径")
    ?? requireWorkspacePath(ports, spec, "页面规格路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  if (!Number.isInteger(slideIndex) || slideIndex < 0) {
    return { ok: false, kind: "refused", envelope: null, reason: "slide 必须是 0 起的整数" };
  }
  return invoke(ports, ["slides", "replace", file, "--slide", String(slideIndex), "--spec", spec, "--json"],
    options.signal ? { signal: options.signal } : {});
}

/* ───────────────【T43】把任意受支持格式读成 Markdown / 文本 ───────────────
 *
 * 用户原话：「读文件也不全面」。T24 的 `document_md_read` 只调 `docs read`
 * （Word 专属），于是 .xlsx/.pptx/.pdf/.md/.html 一律读不了。
 *
 * 这里的判据是**扩展名 → 真实命令**，每条都先核过 CLI：
 *   - .docx            → `docs read --full`（块结构 + 文本）
 *   - .xlsx            → `sheet read`（单元格；`--stats` 先量大小）
 *   - .pptx            → `slides read --full`（每页文本/表格/备注）
 *   - .pdf             → `pdf read`（文本层，按页）
 *   - .md/.markdown/.txt/.csv/源码 → **直接读文件**（它们本来就是文本，
 *     `convert` 也不支持 md→md / html→md，硬走 convert 只会报 `unsupported`）
 *   - .html/.htm       → 直接读文件（受限 HTML 片段与整页都能读；转换是给 docx/pdf 用的）
 *
 * 返回统一是「一个信封」，`detail.items` 是**与 docs read 同形**的块数组，
 * 这样 `blocksToMarkdown` 不必为每种格式各写一份。非 Word 格式没有块索引，
 * 就用 `index` 递增 —— 定位符仍是稳定的（对同一个文件重复读，序号一致）。
 */

/** 文本类扩展名（直接读文件，不过 CLI）。 */
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".ini",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".css", ".scss",
  ".xml", ".svg", ".sql", ".sh", ".ps1", ".bat",
]);

/** 单次直读文本的上限：超过就截断并**如实标注**（不假装读全）。 */
const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024;

export type ReadableKind = "docx" | "xlsx" | "pptx" | "pdf" | "html" | "text" | "unsupported";

export function readableKindOf(file: string): ReadableKind {
  const ext = extname(file).toLowerCase();
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".pptx") return "pptx";
  if (ext === ".pdf") return "pdf";
  if (ext === ".html" || ext === ".htm") return "html";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

/** 直读文本文件 → 与 docs read 同形的单块。 */
function readTextAsBlocks(file: string): GenofficeResult {
  let buf: Buffer;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      return { ok: false, kind: "refused", envelope: null, reason: `文本读取不接受符号链接：${file}` };
    }
    if (!stat.isFile()) {
      return { ok: false, kind: "refused", envelope: null, reason: `不是普通文件：${file}` };
    }
    const readBytes = Math.min(stat.size, MAX_TEXT_READ_BYTES);
    buf = readFileSync(file).subarray(0, readBytes);
    const truncated = stat.size > MAX_TEXT_READ_BYTES;
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    return {
      ok: true,
      envelope: {
        status: "ok",
        command: "file",
        summary: `${basename(file)}: ${lines.length} 行${truncated ? `（已截断到 ${MAX_TEXT_READ_BYTES} 字节）` : ""}`,
        detail: {
          blocks: lines.length,
          items: [{ index: 0, type: "text", text }],
          plain: true,
          truncated,
          bytes: stat.size,
        },
      },
    };
  } catch (error) {
    return {
      ok: false, kind: "failed", envelope: null,
      reason: `读取文本文件失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** xlsx `sheet read` 的信封 → 块形状（每个非空行一块）。 */
function sheetRowsToBlocks(envelope: GenofficeEnvelope): { blocks: number; items: unknown[] } {
  const detail = envelope.detail as { rows?: unknown[][]; sheet?: string; range?: string } | null;
  const rows = Array.isArray(detail?.rows) ? detail.rows : [];
  const items: unknown[] = [];
  let index = 0;
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [];
    if (cells.every((cell) => cell === null || cell === undefined || cell === "")) continue;
    items.push({
      index, type: "tableRow",
      text: cells.map((cell) => (cell === null || cell === undefined ? "" : String(cell))).join("\t"),
    });
    index += 1;
  }
  return { blocks: items.length, items };
}

/** pptx `slides read` 的信封 → 块形状（每页一块，含该页全部文本）。 */
function slidesToBlocks(envelope: GenofficeEnvelope): { blocks: number; items: unknown[] } {
  const detail = envelope.detail as { pages?: Array<{ index?: number; elements?: Array<{ type?: string; text?: string }> }> } | null;
  const pages = Array.isArray(detail?.pages) ? detail.pages : [];
  const items: unknown[] = [];
  let index = 0;
  for (const page of pages) {
    const texts = (page.elements ?? [])
      .map((element) => (typeof element.text === "string" ? element.text : ""))
      .filter((text) => text.trim() !== "");
    items.push({
      index, type: "slide", level: 1,
      text: `[slide ${(page.index ?? 0) + 1}] ${texts.join(" · ")}`,
    });
    index += 1;
  }
  return { blocks: items.length, items };
}

/** pdf `pdf read` 的信封 → 块形状（每页一块）。 */
function pdfPagesToBlocks(envelope: GenofficeEnvelope): { blocks: number; items: unknown[] } {
  const detail = envelope.detail as { pages?: Array<{ page?: number; text?: string }> } | null;
  const pages = Array.isArray(detail?.pages) ? detail.pages : [];
  const items: unknown[] = [];
  let index = 0;
  for (const page of pages) {
    items.push({
      index, type: "page",
      text: `[page ${page.page ?? index + 1}] ${typeof page.text === "string" ? page.text : ""}`,
    });
    index += 1;
  }
  return { blocks: items.length, items };
}

/**
 * 【T43】**任意受支持格式 → 与 docs read 同形的块数组**。
 *
 * 调用方（`documentMarkdownRead`）只关心两件事：拿到了什么、以及**这是不是
 * 真正的结构读**。所以信封里带 `via`（`docs read` / `sheet read` / ...）和
 * `structured`（Word 才有块索引；其余格式的 index 是递增序号）。
 */
export async function readAnyDocument(
  ports: GenofficePorts,
  file: string,
  options: { range?: string; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "读取路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const kind = readableKindOf(file);
  const signal = options.signal ? { signal: options.signal } : {};

  if (kind === "text" || kind === "html") {
    const text = readTextAsBlocks(file);
    if (!text.ok) return text;
    const detail = text.envelope.detail as { items: unknown[] };
    return {
      ok: true,
      envelope: {
        ...text.envelope,
        detail: {
          ...(text.envelope.detail as object),
          via: kind === "html" ? "file (html)" : "file",
          structured: false,
          items: detail.items,
        },
      },
    };
  }

  if (kind === "unsupported") {
    return {
      ok: false, kind: "refused", envelope: null,
      reason: `这个格式没有读取路由：${extname(file) || "(无扩展名)"}。` +
        `支持：docx / xlsx / pptx / pdf / html / md / txt / csv / 常见源码。`,
    };
  }

  if (kind === "docx") {
    const read = await docsRead(ports, file, { full: true, ...(options.range ? { range: options.range } : {}), ...signal });
    if (!read.ok) return read;
    return { ok: true, envelope: { ...read.envelope, detail: { ...(read.envelope.detail as object), via: "docs read", structured: true } } };
  }

  if (kind === "xlsx") {
    const read = await sheetRead(ports, file, options.signal);
    if (!read.ok) return read;
    const converted = sheetRowsToBlocks(read.envelope);
    return {
      ok: true,
      envelope: {
        ...read.envelope,
        summary: `${read.envelope.summary ?? basename(file)}（${converted.blocks} 个非空行）`,
        detail: { ...converted, via: "sheet read", structured: false, sheetDetail: read.envelope.detail },
      },
    };
  }

  if (kind === "pptx") {
    const read = await invoke(ports, ["slides", "read", file, "--full", "--json"], signal);
    if (!read.ok) return read;
    const converted = slidesToBlocks(read.envelope);
    return {
      ok: true,
      envelope: {
        ...read.envelope,
        summary: `${read.envelope.summary ?? basename(file)}（${converted.blocks} 页）`,
        detail: { ...converted, via: "slides read", structured: false },
      },
    };
  }

  // pdf
  const read = await pdfRead(ports, file, { full: true, ...(options.range ? { range: options.range } : {}), ...signal });
  if (!read.ok) return read;
  const converted = pdfPagesToBlocks(read.envelope);
  return {
    ok: true,
    envelope: {
      ...read.envelope,
      summary: `${read.envelope.summary ?? basename(file)}（${converted.blocks} 页）`,
      detail: { ...converted, via: "pdf read", structured: false },
    },
  };
}

/**
 * `render <file> --out <dir>`：把 docx/xlsx/pptx/md/html 出成逐页 PNG，模型据此"亲眼看"。
 * `outDir` 由调用方给**受控临时目录**（必须已存在且为空，避免覆盖用户文件）；本函数
 * 不建目录、不猜路径。
 */
export async function renderDocument(
  ports: GenofficePorts,
  file: string,
  outDir: string,
  options: { page?: number; scale?: number; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "渲染源文件");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const page = options.page;
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    return { ok: false, kind: "refused", envelope: null, reason: "render page 必须是大于零的整数" };
  }
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) {
    return { ok: false, kind: "refused", envelope: null, reason: "render scale 超出 0..4" };
  }
  const args = ["render", file, "--out", outDir, "--scale", String(scale), "--json"];
  if (page !== undefined) args.push("--page", String(page));
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}

/** `docs read --range a-b --html`：取一段块的 restricted HTML（Markdown 载体用它精确重建表格）。 */
export async function docsReadRangeHtml(
  ports: GenofficePorts, file: string, range: string, options: { signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "文档路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  return invoke(ports, ["docs", "read", file, "--range", range, "--html", "--json"],
    options.signal ? { signal: options.signal } : {});
}

/** `convert`：格式转换。`out` 同样过路径围栏（CLI 会真的写它）。 */
export async function convertFile(
  ports: GenofficePorts,
  input: string,
  to: string,
  out: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, input, "输入路径")
    ?? requireWorkspacePath(ports, out, "输出路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["convert", input, "--to", to, "--out", out, "--json"];
  if (options.force) args.push("--force");
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}


/**
 * T74 — safe, non-CAS headless subset of the original GenOffice create command.
 * Deliberately uses --from only: pptx ops/spec and Markdown images may
 * reference further files that the caller's workspace gate has not approved.
 * New outputs only: --force must wait for document revision/CAS authorization.
 */
export async function createFromFile(
  ports: GenofficePorts,
  type: "docx" | "xlsx",
  source: string,
  out: string,
  options: { header?: boolean; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, source, "创建源文件")
    ?? requireWorkspacePath(ports, out, "创建输出路径");
  if (refusal !== null) return headlessRefused(refusal);
  if (type !== "docx" && type !== "xlsx") return headlessRefused("该 create 类型未通过无头路径审核");
  const sourceExt = extname(source).toLowerCase();
  const targetExt = extname(out).toLowerCase();
  if (targetExt !== "." + type) return headlessRefused("create 输出扩展名必须匹配类型");
  // HTML uses the upstream restricted fragment parser, without local file
  // resolution. CSV/JSON contain literal table cells, not external assets.
  if (type === "docx" && sourceExt !== ".html" && sourceExt !== ".htm") {
    return headlessRefused("docx create 仅开放原厂 HTML fragment；Markdown 图片路径尚未逐一围栏");
  }
  if (type === "xlsx" && sourceExt !== ".csv" && sourceExt !== ".json") {
    return headlessRefused("xlsx create 仅开放 CSV/JSON");
  }
  if (options.header && type !== "xlsx") return headlessRefused("header 仅用于 xlsx");
  const occupied = refuseExistingOutput(out, "create 输出文件");
  if (occupied !== null) return headlessRefused(occupied);
  if (options.signal?.aborted) return headlessCancelled();
  const args = ["create", "--type", type, "--from", source, "--out", out, "--json"];
  if (options.header) args.push("--header");
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}

/* ─────────────【T43】pptx 设计流水线：create --spec <dir> 的**围栏** ─────────────
 *
 * ## 为什么不能直接把 "pptx" 加进 createFromFile 的联合类型
 *
 * T74 的注释写得很清楚：`--from` 只收**单个文件**，而 pptx 的 `--spec <dir>`
 * 会按名称顺序读目录里**每个** JSON，并且**每个 JSON 里的 image `url` 还能
 * 指向另一批文件**（实测：把 spec 里的 `./assets/pic.png` 挪走，`create` 会
 * 在 `detail.imageFailures` 里报出来 —— 它真的去读了）。放开类型等于让一次
 * 工具调用带着任意多个未过围栏的路径进 CLI，绕过整个工作区判据。
 *
 * ## 方案 B：把 spec 快照进受控临时目录，再对副本调 create
 *
 * 1. **先审**：递归列出源目录里的每个文件，逐个过 `requireWorkspacePath`
 *    （含符号链接的真实路径解析），并用扩展名白名单收窄：
 *    `.json`（页面/大纲/风格）、`.md`（style.md）、图片（`png/jpg/jpeg/gif/webp`）。
 *    其他扩展名一律拒绝 —— spec 不需要它们。
 * 2. **再拷**：把通过审核的文件按**相对路径**拷进调用方给的受控目录
 *    （生产是 `<dataRoot>/docs/export-tmp/...`），源目录只读、不动一个字节。
 * 3. **后建**：对**副本**调 `create --type pptx --spec <副本>/pages`，产物直接
 *    落到调用方指定的工作区内输出路径（那个路径单独过围栏）。
 *
 * 这样 CLI 读到的每个文件都已经在受控目录里，且与源目录逐字节相同 ——
 * 图片相对路径照常工作，但**读不到源目录以外的东西**（拷贝是逐文件白名单，
 * 不是整目录 cp）。
 *
 * 快照目录由调用方清理（本函数只负责写）。
 */

/** spec 目录里允许出现在快照里的扩展名（其余一律拒绝，不是静默跳过）。 */
const SPEC_SNAPSHOT_EXTENSIONS = new Set([
  ".json", ".md", ".markdown",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);
/** 单个文件与整个 spec 目录的体积上限（防把大素材塞进快照）。 */
const MAX_SPEC_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SPEC_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SPEC_FILES = 400;

export interface SpecSnapshotRefusal { ok: false; reason: string }
export interface SpecSnapshotOk { ok: true; files: number; bytes: number }

/**
 * 把 `sourceDir` 快照进 `targetDir`（调用方保证 targetDir 在受控临时根下、
 * 且是一个**新建的空目录**）。返回实际拷贝的文件数与字节数。
 *
 * **不建 targetDir 以外的任何东西**；不跟随符号链接（链接直接拒绝）。
 */
export async function snapshotDeckSpec(
  ports: GenofficePorts,
  sourceDir: string,
  targetDir: string,
): Promise<SpecSnapshotOk | SpecSnapshotRefusal> {
  const sourceRefusal = requireWorkspacePath(ports, sourceDir, "spec 源目录");
  if (sourceRefusal !== null) return { ok: false, reason: sourceRefusal };
  if (existsSync(targetDir)) return { ok: false, reason: `快照目标已存在，拒绝覆盖：${targetDir}` };

  // 1. 递归列文件（不跟链接），逐个过围栏与扩展名白名单。
  const collected: Array<{ abs: string; rel: string; bytes: number }> = [];
  let total = 0;
  const walk = (dir: string, relBase: string, depth: number): string | null => {
    if (depth > 6) return `spec 目录层级过深（>6）：${dir}`;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (error) {
      return `无法列目录 ${dir}：${error instanceof Error ? error.message : String(error)}`;
    }
    for (const name of names) {
      const abs = join(dir, name);
      const rel = relBase === "" ? name : `${relBase}/${name}`;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch (error) {
        return `无法读取 ${abs}：${error instanceof Error ? error.message : String(error)}`;
      }
      if (stat.isSymbolicLink()) return `spec 快照不接受符号链接：${abs}`;
      if (stat.isDirectory()) {
        const nested = walk(abs, rel, depth + 1);
        if (nested !== null) return nested;
        continue;
      }
      if (!stat.isFile()) return `spec 快照只接受普通文件：${abs}`;
      const ext = extname(name).toLowerCase();
      if (!SPEC_SNAPSHOT_EXTENSIONS.has(ext)) {
        return `spec 目录里出现不允许的文件类型 ${ext || "(无扩展名)"}：${rel}（只允许 json/md/图片）`;
      }
      if (stat.size > MAX_SPEC_FILE_BYTES) return `spec 文件过大（>${MAX_SPEC_FILE_BYTES} 字节）：${rel}`;
      const refusal = requireWorkspacePath(ports, abs, `spec 文件 ${rel}`);
      if (refusal !== null) return refusal;
      total += stat.size;
      if (total > MAX_SPEC_TOTAL_BYTES) return `spec 目录总体积超过 ${MAX_SPEC_TOTAL_BYTES} 字节`;
      collected.push({ abs, rel, bytes: stat.size });
      if (collected.length > MAX_SPEC_FILES) return `spec 文件数超过 ${MAX_SPEC_FILES}`;
    }
    return null;
  };
  const walkError = walk(sourceDir, "", 0);
  if (walkError !== null) return { ok: false, reason: walkError };
  if (collected.length === 0) return { ok: false, reason: `spec 目录是空的：${sourceDir}` };
  const hasPageFile = collected.some((file) => /(^|\/)pages\/[^/]+\.json$/i.test(file.rel) || /(^|\/)\d{1,3}\.json$/i.test(file.rel));
  if (!hasPageFile) {
    return {
      ok: false,
      reason: `spec 目录里没有页面文件（需要 pages/NN.json，或目录本身就是 pages 目录）：${sourceDir}`,
    };
  }

  // 2. 逐文件拷贝（不做整目录 cp —— 那条会带走未审的东西）。
  try {
    mkdirSync(targetDir, { recursive: true });
    for (const file of collected) {
      const destination = join(targetDir, ...file.rel.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(file.abs, destination);
    }
  } catch (error) {
    return { ok: false, reason: `spec 快照拷贝失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, files: collected.length, bytes: total };
}

/**
 * 【T43】`create --type pptx --spec <dir> --outline <file>`，**只接受快照副本**。
 *
 * `specDir` 与 `outline` 都必须是调用方已经建好的受控快照里的路径；本函数仍
 * 再过一次 `requireWorkspacePath`（纵深防御：即便调用方传错，围栏也拦得住）。
 * 输出路径必须是工作区内、且**已存在则拒绝**（与 `createFromFile` 同一条纪律）。
 */
export async function createDeckFromSpec(
  ports: GenofficePorts,
  specDir: string,
  out: string,
  options: { outline?: string; render?: string; audit?: boolean; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, specDir, "spec 快照目录")
    ?? requireWorkspacePath(ports, out, "演示文稿输出路径")
    ?? (options.outline !== undefined ? requireWorkspacePath(ports, options.outline, "大纲路径") : null)
    ?? (options.render !== undefined ? requireWorkspacePath(ports, options.render, "渲染输出目录") : null);
  if (refusal !== null) return headlessRefused(refusal);
  if (extname(out).toLowerCase() !== ".pptx") return headlessRefused("pptx create 的输出扩展名必须是 .pptx");
  if (!existsSync(specDir)) return headlessRefused(`spec 快照目录不存在：${specDir}`);
  const occupied = refuseExistingOutput(out, "演示文稿输出文件");
  if (occupied !== null) return headlessRefused(occupied);
  if (options.signal?.aborted) return headlessCancelled();
  const args = ["create", "--type", "pptx", "--spec", specDir, "--out", out, "--json"];
  if (options.outline !== undefined) args.push("--outline", options.outline);
  if (options.render !== undefined) args.push("--render", options.render);
  if (options.audit) args.push("--audit");
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}

/**
 * T74 — source template is read-only; values arrive over stdin, never as an
 * arbitrary file path. --strict defaults on to prevent partial replacement.
 * No --force or in-place write is permitted without a revision check.
 */
export async function mergeTemplate(
  ports: GenofficePorts,
  template: string,
  data: Record<string, unknown>,
  out: string,
  options: { strict?: boolean; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, template, "合并模板路径")
    ?? requireWorkspacePath(ports, out, "合并输出路径");
  if (refusal !== null) return headlessRefused(refusal);
  const ext = extname(template).toLowerCase();
  if (![".docx", ".pptx", ".xlsx"].includes(ext) || ext !== extname(out).toLowerCase()) {
    return headlessRefused("merge 模板和新输出必须同为 docx、pptx 或 xlsx");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return headlessRefused("merge 数据必须是 JSON object");
  }
  const stdin = editorOpsStdin(data);
  if (stdin === null) return refusedEditorOps();
  const occupied = refuseExistingOutput(out, "merge 输出文件");
  if (occupied !== null) return headlessRefused(occupied);
  if (options.signal?.aborted) return headlessCancelled();
  const args = ["merge", template, "--data", "-", "--out", out, "--json"];
  if (options.strict !== false) args.push("--strict");
  return invoke(ports, args, { stdin, ...(options.signal ? { signal: options.signal } : {}) });
}

/**
 * T74 — whole-PDF render (the original pdfRender already wraps single pages).
 * Word/Excel/PowerPoint rendering requires the external GenOffice headless app.
 * A new directory avoids overwriting existing preview images.
 */
export async function renderPdfPages(
  ports: GenofficePorts,
  pdf: string,
  outDir: string,
  options: { page?: number; scale?: number; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, pdf, "渲染源文件")
    ?? requireWorkspacePath(ports, outDir, "渲染输出目录");
  if (refusal !== null) return headlessRefused(refusal);
  if (extname(pdf).toLowerCase() !== ".pdf") return headlessRefused("无头 render 仅支持 PDF；其他格式需要原厂应用");
  if (options.page !== undefined && (!Number.isInteger(options.page) || options.page < 1)) {
    return headlessRefused("render page 必须是大于零的整数");
  }
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) return headlessRefused("render scale 超出 0..4");
  const occupied = refuseExistingOutput(outDir, "渲染输出目录");
  if (occupied !== null) return headlessRefused(occupied);
  if (options.signal?.aborted) return headlessCancelled();
  const args = ["render", pdf, "--out", outDir, "--scale", String(scale), "--json"];
  if (options.page !== undefined) args.push("--page", String(options.page));
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
}

function headlessRefused(reason: string): GenofficeResult {
  return { ok: false, kind: "refused", envelope: null, reason };
}
function headlessCancelled(): GenofficeResult {
  return { ok: false, kind: "failed", envelope: null, reason: "GenOffice CLI 操作已取消" };
}
function refuseExistingOutput(path: string, label: string): string | null {
  // No CAS/overwrite approval is available in this adapter; the upstream CLI
  // could otherwise use --force to overwrite another document or GUI session.
  try {
    lstatSync(path);
    return label + " 已存在；无 CAS/覆盖授权，拒绝改写";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return label + " 状态无法确认，拒绝写入";
  }
}
