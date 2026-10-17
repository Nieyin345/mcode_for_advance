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
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
export function resolveGenofficeCliPath(repoRoot: string): string | null {
  const candidate = join(repoRoot, "genoffice", "packages", "cli", "dist", "genoffice.cjs");
  return existsSync(candidate) ? candidate : null;
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
  // CLI 的 `--json` 把信封打到 stdout;stderr 只在崩溃时才有内容。
  const line = result.stdout.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
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
  if (envelope.status === "ok") return { ok: true, envelope };
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
  return null;
}

/** `docs read`：只读列出 docx 的块。 */
export async function docsRead(
  ports: GenofficePorts, file: string, options: { full?: boolean; range?: string; signal?: AbortSignal } = {},
): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "文档路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  const args = ["docs", "read", file, "--json"];
  if (options.full) args.push("--full");
  if (options.range !== undefined) args.push("--range", options.range);
  return invoke(ports, args, options.signal ? { signal: options.signal } : {});
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
  const args = ["docs", "apply", file, "--ops", "-", "--json"];
  if (options.dryRun) args.push("--dry-run");
  if (options.track) args.push("--track");
  return invoke(ports, args, {
    stdin: JSON.stringify(ops),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** `slides read` / `sheet read`（同一形状，`domain` 区分）。 */
export async function slidesRead(ports: GenofficePorts, file: string, signal?: AbortSignal): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "演示文稿路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  return invoke(ports, ["slides", "read", file, "--json"], signal ? { signal } : {});
}

export async function sheetRead(ports: GenofficePorts, file: string, signal?: AbortSignal): Promise<GenofficeResult> {
  const refusal = requireWorkspacePath(ports, file, "表格路径");
  if (refusal !== null) return { ok: false, kind: "refused", envelope: null, reason: refusal };
  return invoke(ports, ["sheet", "read", file, "--json"], signal ? { signal } : {});
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
