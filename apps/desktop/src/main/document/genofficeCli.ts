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
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
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
