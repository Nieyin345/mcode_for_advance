/**
 * `agentTools` 的**共用小件**（从 `agentTools.ts` 拆出）。
 *
 * 四组，彼此只靠本文件内的名字联系：
 *   - 路径与沙箱判定（`resolveAgainstCwd` / `sandboxBashWriteDenial`）；
 *   - 子进程与文本处理（`attempt` / `attemptStructured` / `isBinary` / `truncateOutput` /
 *     `truncateHeadTail` / `clipLine` / `readTextRange` / `formatProcessResult` /
 *     `processResultStructured` / `runCaptured` / `appendDecoded` / `newDecoder`）；
 *   - 系统进程（`listSystemProcesses` / `killSystemProcesses` / `fileInfoText`）；
 *   - 富文档与 URL 读取（`readRichDocumentRaw` / `readRichDocument` / `readUrlText` 及
 *     `findPythonExecutable` / `capDocumentOutput`）；
 * 外加那一批 MCP `*_OUTPUT_SCHEMA` 常量。**纯搬迁，函数体逐字节一致。**
 */

import { createReadStream, promises as fs } from "node:fs";
import { createInterface as createReadlineInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ConsoleTextDecoder } from "@main/lib/outBuf.js";
import { pathWithin as realPathWithin } from "@main/lib/realPathWithin.js";
import { text, image } from "./sdk.js";
import { type AgentProcessReadResult } from "./agentProcessSessions.js";
import { type AgentSearchReadResult } from "./agentSearchSessions.js";
import { type RemoteConnectionInfo, type RemoteJobStatus } from "./agentRemoteSsh.js";
import { resolvePythonExe } from "@main/lib/pythonResolve.js";
import { z } from "zod";
import { extractPdfText, extractPdfLayout } from "@main/library/pdfText.js";
import { docsRead, pdfRead, pdfRender, sheetRead, slidesRead, resolveGenofficeCliPath, type GenofficeResult } from "@main/document/genofficeCli.js";
import { killTree } from "@main/lib/spawnRun.js";
import { extractBashWriteTargets, expandTilde } from "@main/providers/pi-sdk/bashWriteGuard.js";
import { fail, structured as structuredResult } from "./sdk.js";
import { readTextPage, formatTextPage } from "./agentTextFiles.js";
import {
  classifyContentType,
  isRedirectStatus,
  readResponseWithinBudget,
  checkZipInflation,
  urlReadGate,
  documentReadGate,
  clampCellBudget,
  URL_READ_BUDGET,
  DOCUMENT_READ_BUDGET,
  MAX_CONCURRENT_URL_READS,
  MAX_CONCURRENT_DOCUMENT_READS,
  MAX_URL_REDIRECTS,
  MAX_CHILD_OUTPUT_BYTES,
  type ReadBudget,
  type ReadOutcome,
} from "@main/lib/readBudget.js";

/* ────────────────────────────── 共用小件 ────────────────────────────── */

/** 批量读取最多几个文件 / 最多返回多少字符，防一次调用把上下文灌满。 */
export const MAX_BATCH_READ_FILES = 20;
export const MAX_BATCH_OUTPUT_CHARS = 80_000;
/** 目录树单次边界。 */
export const MAX_LIST_DEPTH = 4;
export const MAX_LIST_ENTRIES = 1000;
/** bash 输出(stdout/stderr 各自)的保留字符数。 */
export const MAX_OUTPUT_CHARS = 30_000;
/** bash 默认与最大超时。 */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
/** grep 最多扫多少个文件 / 单个文件多大就跳过。 */
export const MAX_GREP_FILES = 20_000;
export const MAX_GREP_FILE_BYTES = 8 * 1024 * 1024;
/** 这些目录在任何递归遍历里都不进去 —— 搜索工具的基本卫生。 */

/**
 * 解析一个路径,并在给了**沙箱根**时把越界的拒掉。
 *
 * 绝对路径默认原样接受 —— 和 claude 引擎一样的自由度,桌面那条路写操作有审批闸门兜着。
 * 但**公网那条路没有闸门**(用户选的是免审批),所以给它一个 `root`:凡是不在这个目录
 * 底下的,一律拒,而且是**明确失败**(说清根在哪、为什么拒),不是静默改成根内路径。
 *
 * 判据用现成的 {@link pathWithin} (`path.relative` 那套)—— 它天然处理 Windows
 * 大小写不敏感与分隔符两种写法,也挡得住"同前缀的兄弟目录"(`CWD-sibling` 那种,
 * 纯字符串前缀比较会把它误判成在内部)。
 *
 * ⚠️ 它**只管文件工具**。`agent_bash` 能 `cd ..`、能读任意绝对路径,所以沙箱是
 * **可绕过的**。这不是疏漏,是取舍:拦 bash 要真解析 shell 语义,做不干净反而给人
 * "限制住了"的错觉(见工具表文件头)。
 */
export function resolveAgainstCwd(cwd: string | null, p: string, root: string | null = null): string {
  const trimmed = p.trim();
  if (!trimmed) throw new Error("路径为空");
  let abs: string;
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    abs = path.normalize(trimmed);
  } else {
    if (!cwd) throw new Error(`这个会话没有工作目录,相对路径「${trimmed}」无法解析,请使用绝对路径`);
    abs = path.resolve(cwd, trimmed);
  }
  if (root && !realPathWithin(root, abs)) {
    throw new Error(
      `路径越界:「${abs}」不在允许的目录「${root}」之内。` +
        `公网进来的调用被限制在这个项目目录里,请改用项目内的路径。`,
    );
  }
  return abs;
}

/**
 * `agent_bash` 里那道**写目标检查** —— 命令里的重定向目标(`> x` / `tee x` /
 * `dd of=x` / `sed -i x`)必须落在沙箱里,否则给一句拒绝理由。
 *
 * ## 它是"防误操作",不是沙箱
 *
 * 解析器复用 Pi 那条路的 {@link extractBashWriteTargets}(不写第二份)。**它只认那几种
 * 形式** —— `cp`/`mv` 的目标参数、heredoc、`python -c "open(...).write(...)"` 这类
 * 它都不认,所以**刻意绕的人仍绕得过**。这条的价值是挡住"顺手往沙箱外写个脚本"那种
 * **无意的**越界 —— 在那之前这条路连这个都没有(2026-09-24 源码审查第 4 条)。
 *
 * 判据用 {@link pathWithin}(与文件工具同一份),所以"什么算在沙箱内"两处一致。
 */
export function sandboxBashWriteDenial(command: string, sandbox: string): string | null {
  for (const raw of extractBashWriteTargets(command)) {
    // 带变量展开的(`$OUT/x`)静态看不准 —— 放行,与 Pi 那边同款取舍(宁可漏,不误杀)。
    if (/\$|\`/.test(raw)) continue;
    const expanded = expandTilde(raw);
    const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(sandbox, expanded);
    if (!realPathWithin(sandbox, abs)) {
      return (
        `拒绝:命令要写入「${abs}」,那在允许的目录「${sandbox}」之外。` +
        `公网进来的调用被限制在这个项目目录里,请把输出写到项目内(或用相对路径)。`
      );
    }
  }
  return null;
}

/** 统一的错误包装 —— handler 不抛,失败也走 ToolResult(模型读得懂、能自己改)。 */
export async function attempt(run: () => Promise<string>): Promise<ReturnType<typeof text>> {
  try {
    return text(await run());
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 同 {@link attempt},但**同时带结构化结果** —— 进程工具那几处用它,因为它们的返回值
 * 有模型该直接读的字段(见 `PROCESS_OUTPUT_SCHEMA`)。
 *
 * `structured: null` 表示**这一支没有结构化形状**:比如 `agent_process_read` 省略
 * `process_id` 时是"列进程",返回的是清单而不是一次读取结果 —— 那时硬套
 * `PROCESS_OUTPUT_SCHEMA` 就是给客户端一份对不上的 schema。宁可这一支不带。
 *
 * 失败时同样只回文本:错误没有可描述的结构化形状。
 */
export async function attemptStructured(
  run: () => Promise<{ text: string; structured: Record<string, unknown> | null; isError?: boolean }>,
): Promise<ReturnType<typeof text>> {
  try {
    const { text: body, structured: fields, isError } = await run();
    const result = fields ? structuredResult(body, fields) : text(body);
    return isError ? { ...result, isError: true } : result;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

export function truncateOutput(s: string, label: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n…[${label} 超过 ${MAX_OUTPUT_CHARS} 字符,已截断]`;
}

/** 远程命令输出的截断:保留**头和尾**。编译/训练/安装的报错几乎都在最后,只留开头
 *  会把真正的错误截掉。 */
export function truncateHeadTail(s: string, label: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const head = Math.floor(MAX_OUTPUT_CHARS * 0.4);
  const tail = MAX_OUTPUT_CHARS - head;
  return `${s.slice(0, head)}\n…[${label} 共 ${s.length} 字符,中间 ${s.length - head - tail} 字符已省略]…\n${s.slice(-tail)}`;
}

export function clipLine(line: string, max = 2000): string { return line.length > max ? `${line.slice(0, max)}…(行超长已截断)` : line; }

export async function readTextRange(abs: string, offset = 1, limit = 2000): Promise<string> {
  return formatTextPage(await readTextPage(abs, { offset, limit }), offset);
}

export function formatProcessResult(out: AgentProcessReadResult): string {
  const meta = [
    `process_id: ${out.processId}`,
    `status: ${out.status}`,
    `next_cursor: ${out.nextCursor}`,
  ];
  if (out.exitCode !== null) meta.push(`exit_code: ${out.exitCode}`);
  if (out.signal) meta.push(`signal: ${out.signal}`);
  if (out.skippedChars > 0) {
    meta.push(`warning: 早期输出已从环形缓冲丢弃 ${out.skippedChars} 字符`);
  }
  if (out.hasMore) meta.push(`more_output: true (继续用 cursor=${out.nextCursor})`);
  return `${meta.join("\n")}\n--- output ---\n${out.output || "(暂无新输出)"}`;
}

/**
 * 同一份结果的**结构化投影** —— 与 {@link formatProcessResult} 说的是同一件事,
 * 只是让模型直接读字段,不用从上面那段文本里正则抠 `next_cursor: 4821`。
 *
 * 两个都要:文本给 SDK 那条路(SDK 不支持 outputSchema)和人读;结构化给网页端。
 * 改字段时**两边一起改** —— 它们是一件事的两种投影,分叉了就是两个谎。
 */
export function processResultStructured(out: AgentProcessReadResult): Record<string, unknown> {
  return {
    process_id: out.processId,
    status: out.status,
    next_cursor: out.nextCursor,
    has_more: out.hasMore,
    output: out.output,
    exit_code: out.exitCode,
    signal: out.signal,
    skipped_chars: out.skippedChars,
  };
}

/** 进程工具的返回结构 —— `agent_process_*` 那一组共用(见 McpToolSpec.outputSchema)。 */
export const PROCESS_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  process_id: z.string().describe("进程会话 id"),
  status: z
    .enum(["running", "exited", "stopped", "timed_out", "failed"])
    .describe("进程状态；exited 表示已结束"),
  next_cursor: z.number().int().describe("下次读的游标；原样传回 agent_process_read 的 cursor"),
  has_more: z.boolean().describe("还有未读输出；true 时应立刻再读一次"),
  output: z.string().describe("本次新增的输出"),
  exit_code: z.number().int().nullable().describe("退出码；未结束为 null"),
  signal: z.string().nullable().describe("结束信号；没有为 null"),
  skipped_chars: z.number().int().describe("因环形缓冲被丢弃的早期字符数；>0 说明漏了输出"),
};

/** 远程任务日志的返回结构 —— 与 `agent_process_read` 同形(同一个"增量读"语义),
 *  只是对象是远端 job。见 McpToolSpec.outputSchema。 */
export const REMOTE_JOB_LOG_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  job_id: z.string().describe("远程任务 id"),
  stream: z.enum(["stdout", "stderr"]).describe("读的是哪条流"),
  cursor: z.number().int().describe("本次从哪个字节开始读"),
  next_cursor: z.number().int().describe("下次读的字节位置；原样传回 cursor"),
  total_bytes: z.number().int().describe("日志文件当前总字节数"),
  more_output: z.boolean().describe("还有未读输出；true 时应立刻再读一次"),
  job_finished: z.boolean().describe("任务已结束（完成/取消/进程不在）；与 more_output=false 同时出现时说明日志已读完，不必再读"),
  output: z.string().describe("本次新增的日志文本"),
};

/** 远程任务状态的返回结构 —— 模型靠 `state` 判断训练跑完没。 */
export const REMOTE_JOB_STATUS_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  job_id: z.string().describe("远程任务 id"),
  state: z
    .enum(["starting", "running", "completed", "cancelled", "lost", "missing"])
    .describe("任务状态；completed = 已跑完（看 exit_code），lost = 进程不在了但没写退出码"),
  pid: z.number().int().nullable().describe("远端进程号；没有为 null"),
  exit_code: z.number().int().nullable().describe("退出码；未结束为 null"),
  mode: z.string().nullable().describe("启动方式（tmux / nohup）"),
  tmux_session: z.string().nullable().describe("tmux 会话名；非 tmux 启动为 null"),
  started_at: z.number().int().nullable().describe("开始时间（unix 秒）"),
  finished_at: z.number().int().nullable().describe("结束时间（unix 秒）"),
  stdout_bytes: z.number().int().describe("stdout 日志当前字节数"),
  stderr_bytes: z.number().int().describe("stderr 日志当前字节数"),
};

/** `agent_ssh_exec` 的返回结构 —— 模型靠 `exit_code` 判断命令成功没有。 */
export const REMOTE_EXEC_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  exit_code: z.number().int().nullable().describe("退出码；被信号终止为 null"),
  signal: z.string().nullable().describe("终止信号；正常退出为 null"),
  stdout: z.string().describe("标准输出"),
  stderr: z.string().describe("标准错误"),
};

/** `agent_context` 的返回结构 —— "我在什么环境里、库里有什么"。 */
export const AGENT_CONTEXT_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  writable_project: z
    .string()
    .nullable()
    .describe("**唯一可写**的项目绝对路径（用户在「远程控制」里选的那个）；null = 还没选"),
  projects: z
    .array(z.object({ name: z.string(), path: z.string() }))
    .describe("用户的全部项目（名字 + 绝对路径）—— **只读**，只有 writable_project 那个能写"),
  library_root: z.string().optional().describe("资料库根的绝对路径（**只读**）"),
  library_total: z.number().int().optional().describe("库里条目总数；0 = 空库"),
  library_items: z
    .array(
      z.object({
        title: z.string(),
        kind: z.string(),
        year: z.number().int().nullable(),
        venue: z.string().nullable(),
        path: z.string().nullable().describe("该条目的文件路径（相对库根）；没有文件为 null"),
      }),
    )
    .optional()
    .describe("库里的条目（截断到上限；给的是**标题**不是哈希文件名）"),
  library_truncated: z.boolean().optional().describe("库条目是否因为超过上限被截断"),
};

export const GLOB_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  count: z.number().int().describe("匹配到的文件总数；0 = 没有匹配（换个模式或起点）"),
  files: z.array(z.string()).describe("路径列表(相对会话工作目录;工作目录外的给绝对路径),最多 500 条"),
  truncated: z.boolean().describe("是否没列全(超过 500 条或目录太大没搜完)"),
  base: z.string().describe("搜索起点目录的绝对路径"),
  partial: z.boolean().describe("【MC-027】是否**漏搜**过位置(某目录无权限/被删,或撞深度上限);true 时 0 结果不能当作「不存在」"),
  skipped_count: z.number().int().describe("【MC-027】没能搜到的位置(目录)总数"),
  skipped_paths: z.array(z.string()).describe("【MC-027】没能搜到的位置(相对 base 的正斜杠路径),最多 50 条"),
};

/** `agent_grep` 的返回结构 —— 同 glob 一个道理:模型靠 count 判断找到没有。 */
export const GREP_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  line_truncated: z.boolean().optional().describe("是否存在只展示命中窗口的长行；与结果条数截断分开"),
  count: z.number().int().describe("匹配到的行数；0 = 没有匹配"),
  matches: z.array(z.string()).describe("匹配行，形如 `相对工作目录的路径:行号: 内容`"),
  scanned_files: z.number().int().describe("实际扫描过的文件数"),
  truncated: z.boolean().describe("是否没搜完(达到 max_results,或文件太多只扫了一部分)"),
  partial: z.boolean().describe("【MC-027】是否**漏搜**过位置(某目录/文件无权限或被删,或撞深度上限);true 时 0 结果不能当作「不存在」"),
  skipped_count: z.number().int().describe("【MC-027】没能搜到的位置(目录/文件)总数"),
  skipped_paths: z.array(z.string()).describe("【MC-027】没能搜到的位置(相对搜索起点的正斜杠路径),最多 50 条"),
};

export function formatRemoteConnection(info: RemoteConnectionInfo): string {
  const lines = [
    `connection_id: ${info.connectionId}`,
    `target: ${info.username}@${info.host}:${info.port}`,
    `state: ${info.state}`,
    `reconnect_attempt: ${info.reconnectAttempt}`,
  ];
  if (info.lastError) lines.push(`last_error: ${info.lastError}`);
  if (info.connectedAt) lines.push(`connected_at: ${new Date(info.connectedAt).toISOString()}`);
  // 【MC-052】首次信任待批准时,把候选指纹显式列出,供用户去服务器带外核对。
  if (info.hostKeyPendingConfirmation) {
    lines.push(`host_key_pending_confirmation: true`);
    lines.push(`host_key_candidate_fingerprint: ${info.hostKeyCandidateFingerprint ?? "(未读到)"}`);
  }
  // 【MC-014 / 第 48.4 节】自填 expected_fingerprint 但无宿主授权 → 被拒。
  if (info.hostKeyExpectedUngranted) {
    lines.push(`host_key_expected_ungranted: true`);
    lines.push(`host_key_candidate_fingerprint: ${info.hostKeyCandidateFingerprint ?? "(未读到)"}`);
  }
  return lines.join("\n");
}

export function formatRemoteJobStatus(status: RemoteJobStatus): string {
  const lines = [
    `job_id: ${status.jobId}`,
    `state: ${status.state}`,
    `pid: ${status.pid ?? "-"}`,
    `exit_code: ${status.exitCode ?? "-"}`,
    `mode: ${status.mode ?? "-"}`,
    `stdout_bytes: ${status.stdoutBytes}`,
    `stderr_bytes: ${status.stderrBytes}`,
  ];
  if (status.tmuxSession) lines.push(`tmux_session: ${status.tmuxSession}`);
  if (status.startedAt) lines.push(`started_at: ${new Date(status.startedAt * 1000).toISOString()}`);
  if (status.finishedAt) lines.push(`finished_at: ${new Date(status.finishedAt * 1000).toISOString()}`);
  return lines.join("\n");
}

/**
 * 远程任务状态的**结构化投影** —— 与 {@link formatRemoteJobStatus} 同一件事的两种投影。
 *
 * 这个尤其值得结构化:模型判断"训练跑完没有"就靠 `state`,从文本里正则抠
 * `state: completed` 又脆又费 token。给了字段它直接读。
 */
export function remoteJobStatusStructured(s: RemoteJobStatus): Record<string, unknown> {
  return {
    job_id: s.jobId,
    state: s.state,
    pid: s.pid,
    exit_code: s.exitCode,
    mode: s.mode,
    tmux_session: s.tmuxSession,
    started_at: s.startedAt,
    finished_at: s.finishedAt,
    stdout_bytes: s.stdoutBytes,
    stderr_bytes: s.stderrBytes,
  };
}
export function formatSearchResult(out: AgentSearchReadResult): string {
  const meta = [
    `search_id: ${out.searchId}`,
    `status: ${out.status}`,
    `offset: ${out.offset}`,
    `next_offset: ${out.nextOffset}`,
    `total_results: ${out.totalResults}`,
    `scanned_files: ${out.scannedFiles}`,
  ];
  if (out.error) meta.push(`error: ${out.error}`);
  // 【MC-027】遍历中有的位置(目录/文件)没能搜到 —— 如实报出来,别把部分结果当全量。
  // 尤其 `total_results: 0` + partial 时,模型**不能**据此断言"没有"。
  if (out.partial) {
    meta.push(`partial: true`);
    meta.push(`skipped_count: ${out.skippedCount}`);
    if (out.skippedPaths.length > 0) {
      const shown = out.skippedPaths.slice(0, 20);
      const more = out.skippedCount > shown.length ? ` …等共 ${out.skippedCount} 个` : "";
      meta.push(`skipped_paths: ${shown.join(", ")}${more}`);
    }
  }
  const body = out.results.length > 0 ? out.results.map((r, i) => `[${out.offset + i}] ${r}`).join("\n") : "(本页暂无结果)";
  const warn = out.partial
    ? `\n⚠️ 本次搜索**不完整**:有 ${out.skippedCount} 个位置(目录或文件)没能搜到,结果可能不全;` +
      (out.totalResults === 0 ? "「没有结果」不能当作「不存在」。" : "请勿据此断言目标不存在。")
    : "";
  return `${meta.join("\n")}\n--- results ---\n${body}${warn}`;
}

export async function runCaptured(exe: string, args: string[], timeoutMs = 10_000, env?: NodeJS.ProcessEnv, maxOutputBytes = MAX_CHILD_OUTPUT_BYTES): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`${exe} 超过 ${timeoutMs}ms 没结束`));
    }, timeoutMs);
    // 每条流一个解码器 —— 抗「多字节字符被 chunk 边界切断」(见 `appendDecoded`)。
    const outAcc = { text: stdout };
    const errAcc = { text: stderr };
    const outDec = newDecoder();
    const errDec = newDecoder();
    // 【MC-065】子进程输出的**输入侧**上界:从前是"让它把文档全跑完、再把结果截到 2M 字符"
    // —— 大输出(超大工作簿/文档)照样被完整产生,峰值不受预算约束。现在按**原始字节**累计,
    // 到界立即 killTree 并**显式报错**(不静默返回一份被砍掉的正文,那会让上层误当完整)。
    // 上界由调用方从 {@link DOCUMENT_READ_BUDGET}.maxChildOutputBytes 传进来(同一份预算)。
    let outBytes = 0;
    let errBytes = 0;
    const overflow = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      reject(new Error(`${exe} 的输出超过 ${maxOutputBytes} 字节上限,已提前终止(这是子进程输出预算,不是文档损坏)`));
    };
    child.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > maxOutputBytes) return overflow();
      appendDecoded(outAcc, outDec, d, maxOutputBytes);
      stdout = outAcc.text;
    });
    child.stderr.on("data", (d: Buffer) => {
      errBytes += d.length;
      if (errBytes > maxOutputBytes) return overflow();
      appendDecoded(errAcc, errDec, d, maxOutputBytes);
      stderr = errAcc.text;
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export interface SystemProcessInfo {
  pid: number;
  ppid?: number;
  name: string;
  memoryBytes?: number;
  command?: string;
}

export async function listSystemProcesses(filter?: string, limit = 300): Promise<SystemProcessInfo[]> {
  let rows: SystemProcessInfo[] = [];
  if (process.platform === "win32") {
    const script = [
      // 强制 UTF-8:管道里 PowerShell 默认按系统代码页(中文系统 GBK)输出,命令行里的中文路径会乱码。
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
      "$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize;",
      "$p | ConvertTo-Json -Compress",
    ].join("");
    const out = await runCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 15_000);
    if (out.code !== 0) throw new Error(`列系统进程失败:${out.stderr.trim() || `exit ${out.code}`}`);
    const parsed: unknown = out.stdout.trim() ? JSON.parse(out.stdout) : [];
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    rows = list.flatMap((v): SystemProcessInfo[] => {
      if (!v || typeof v !== "object") return [];
      const o = v as Record<string, unknown>;
      const pid = Number(o.ProcessId);
      if (!Number.isInteger(pid)) return [];
      return [{
        pid,
        ppid: Number.isInteger(Number(o.ParentProcessId)) ? Number(o.ParentProcessId) : undefined,
        name: String(o.Name ?? ""),
        memoryBytes: Number.isFinite(Number(o.WorkingSetSize)) ? Number(o.WorkingSetSize) : undefined,
        command: typeof o.CommandLine === "string" ? o.CommandLine : undefined,
      }];
    });
  } else {
    const out = await runCaptured("ps", ["-eo", "pid=,ppid=,rss=,comm=,args="], 10_000);
    if (out.code !== 0) throw new Error(`列系统进程失败:${out.stderr.trim() || `exit ${out.code}`}`);
    rows = out.stdout.split(/\r?\n/).flatMap((line): SystemProcessInfo[] => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!m) return [];
      return [{ pid: Number(m[1]), ppid: Number(m[2]), memoryBytes: Number(m[3]) * 1024, name: m[4]!, command: m[5] || undefined }];
    });
  }
  const needle = filter?.trim().toLowerCase();
  if (needle) rows = rows.filter((r) => `${r.pid} ${r.ppid ?? ""} ${r.name} ${r.command ?? ""}`.toLowerCase().includes(needle));
  return rows.sort((a, b) => a.pid - b.pid).slice(0, Math.max(1, Math.min(limit, 1000)));
}

export async function killSystemProcess(pid: number, force: boolean): Promise<string> {
  if (pid === process.pid) throw new Error("拒绝终止 mcode 自己的主进程；否则 MCP 会在返回结果前把自己杀掉");
  if (pid <= 0 || !Number.isInteger(pid)) throw new Error(`pid 不合法:${pid}`);
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const out = await runCaptured("taskkill", args, 15_000);
    if (out.code !== 0) throw new Error(`终止 PID ${pid} 失败:${out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`}`);
    return (out.stdout || `已终止 PID ${pid}`).trim();
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (err) {
    throw new Error(`终止 PID ${pid} 失败:${err instanceof Error ? err.message : String(err)}`);
  }
  return `已向 PID ${pid} 发送 ${force ? "SIGKILL" : "SIGTERM"}`;
}

export async function fileInfoText(abs: string, countLines: boolean): Promise<string> {
  const st = await fs.lstat(abs).catch(() => null);
  if (!st) throw new Error(`路径不存在:${abs}`);
  const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
  const lines = [
    `path: ${abs}`,
    `type: ${type}`,
    `size: ${st.size}`,
    `created_at: ${st.birthtime.toISOString()}`,
    `modified_at: ${st.mtime.toISOString()}`,
    `mode: ${`0${(st.mode & 0o777).toString(8)}`.slice(-4)}`,
  ];
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(abs).catch(() => null);
    if (target) lines.push(`symlink_target: ${target}`);
  }
  if (st.isFile() && countLines) {
    const fd = await fs.open(abs, "r");
    let binary = false;
    try {
      const head = Buffer.alloc(Math.min(st.size, 8192));
      if (head.length > 0) await fd.read(head, 0, head.length, 0);
      binary = isBinary(head);
    } finally {
      await fd.close();
    }
    if (binary) lines.push("text: false");
    else {
      let lineCount = 0;
      const rl = createReadlineInterface({ input: createReadStream(abs, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const _line of rl) lineCount += 1;
      lines.push("text: true", `line_count: ${lineCount}`, `last_line: ${Math.max(0, lineCount - 1)}`, `append_position: ${lineCount}`);
    }
  }
  return lines.join("\n");
}


let pythonExecutablePromise: Promise<string | null> | null = null;

/** 挑一个 python 解释器 —— 与工具链检测 / 代码节点 / 文档操作**共用一份**。
 *
 *  从前这里是"取 PATH 上第一个能跑的 python",会被 `env/agentEnv.ts` 注入到 PATH 最前
 *  的 LibreOffice 捆绑 `python.exe` 抢走(报告附录 M 的"Python 解释器陷阱")。
 *  `resolvePythonExe()` 会跳过捆绑型,与别处一致。 */
export function findPythonExecutable(): Promise<string | null> {
  if (!pythonExecutablePromise) {
    pythonExecutablePromise = (async () => {
      const exe = await resolvePythonExe();
      if (!exe) return null;
      try {
        const out = await runCaptured(exe, ["-c", "import sys;print(sys.executable)"], 4_000);
        return out.code === 0 && out.stdout.trim() ? exe : null;
      } catch {
        return null;
      }
    })();
  }
  return pythonExecutablePromise;
}

/** Resolve the same bundled CLI as document.read / GenOffice MCP install. */
async function findBundledGenofficeCli(): Promise<string | null> {
  const { documentRepoRoot } = await import("@main/ipc/document.js");
  const root = documentRepoRoot();
  return resolveGenofficeCliPath(root) ?? resolveGenofficeCliPath(path.resolve(root, "../.."));
}

/** Vendor PDFium page renderer; temp output is deleted before returning. */
async function renderWithGenoffice(input: {
  abs: string; page: number; maxDimension: number; renderer?: "auto" | "native" | "genoffice";
}): Promise<{ base64: string; mime: "image/png"; pageCount: number; width: number; height: number } | null> {
  const cliPath = await findBundledGenofficeCli();
  if (!cliPath) {
    if (input.renderer === "genoffice") throw new Error("GenOffice CLI 未构建/安装，无法使用其 PDFium 渲染；请选择 renderer=native");
    return null;
  }
  const tmp = await fs.mkdtemp(path.join(tmpdir(), "mcode-pdf-render-"));
  // The metadata read and PDFium render share one bounded operation, not
  // separate CLI timeouts that can each consume a full minute.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const source = await fs.stat(input.abs, { bigint: true });
    const ensureUnchanged = async (): Promise<void> => {
      if (controller.signal.aborted) throw new Error("GenOffice PDFium 页面读取/渲染超过 30 秒总预算");
      const current = await fs.stat(input.abs, { bigint: true });
      if (source.size !== current.size || source.mtimeNs !== current.mtimeNs
          || source.ctimeNs !== current.ctimeNs || source.dev !== current.dev || source.ino !== current.ino) {
        throw new Error("PDF 在页面尺寸读取与渲染期间发生修改；拒绝混合不同版本的结果");
      }
    };
    const checkedInput = path.resolve(input.abs);
    const ports = { cliPath, withinWorkspace: (p: string) => {
      const candidate = path.resolve(p);
      const rel = path.relative(tmp, candidate);
      return candidate === checkedInput || (rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)) || candidate === tmp;
    } };
    const details = await pdfRead(ports, input.abs, { page: input.page, maxChars: 1, signal: controller.signal });
    if (controller.signal.aborted) throw new Error("GenOffice PDFium 页面读取/渲染超过 30 秒总预算");
    if (!details.ok) {
      if (details.kind === "unavailable" && input.renderer !== "genoffice") return null;
      throw new Error(`GenOffice 读取 PDF 页面尺寸失败: ${details.reason}`);
    }
    await ensureUnchanged();
    const metadata = details.envelope.detail as { pages?: unknown; pages_read?: unknown } | null;
    const pageCount = metadata?.pages;
    const pages = metadata?.pages_read;
    if (typeof pageCount !== "number" || !Number.isSafeInteger(pageCount) || pageCount < input.page
        || !Array.isArray(pages) || pages.length !== 1 || pages[0]?.page !== input.page) {
      throw new Error("GenOffice PDFium 页数/请求页码元数据不一致，拒绝渲染错误页面");
    }
    const geometry = pages[0] as { width_pt?: number; height_pt?: number };
    const widthPt = geometry?.width_pt ?? 0;
    const heightPt = geometry?.height_pt ?? 0;
    if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt) || widthPt <= 0 || heightPt <= 0) throw new Error("GenOffice PDFium 未返回有效页面尺寸");
    const scale = Math.min(1, (input.maxDimension - 2) / Math.max(widthPt, heightPt));
    const result = await pdfRender(ports, input.abs, tmp, input.page, scale, { signal: controller.signal });
    if (controller.signal.aborted) throw new Error("GenOffice PDFium 页面读取/渲染超过 30 秒总预算");
    if (!result.ok) {
      if (result.kind === "unavailable" && input.renderer !== "genoffice") return null;
      throw new Error(`GenOffice PDFium 渲染 ${result.kind}: ${result.reason}`);
    }
    await ensureUnchanged();
    const files = (result.envelope.detail as { files?: Array<{ page?: number; path?: string; width?: number; height?: number }> } | null)?.files;
    const matches = files?.filter(f => f?.page === input.page && typeof f.path === "string");
    if (!matches || matches.length !== 1) throw new Error("GenOffice 未返回唯一的请求页 PNG 文件");
    const rendered = matches[0]!;
    if (!rendered.path) throw new Error("GenOffice 没有返回所请求页的 PNG 文件");
    // Even if the vendor returns an unexpected path or symlink, never read
    // outside the unique temp directory created by this call.
    const real = await fs.realpath(rendered.path);
    const rel = path.relative(tmp, real);
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw new Error("GenOffice 渲染结果越过临时目录围栏");
    }
    const st = await fs.stat(real);
    if (!st.isFile() || st.size > 6 * 1024 * 1024) {
      if (input.renderer !== "genoffice") return null;
      throw new Error("GenOffice PDFium PNG 超过 6MiB，减小 max_dimension 或选择 renderer=native");
    }
    const bytes = await fs.readFile(real);
    await ensureUnchanged();
    // PNG requires an 8-byte signature and a complete 25-byte IHDR chunk
    // including its CRC. A 24-byte forged prefix is NOT a renderable image.
    if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("GenOffice 返回的 PNG 头/IHDR 无效或文件被截断");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if ((rendered.width !== undefined && rendered.width !== width)
        || (rendered.height !== undefined && rendered.height !== height)) {
      throw new Error("GenOffice PNG 尺寸与渲染信封元数据不一致");
    }
    if (width < 1 || height < 1 || Math.max(width, height) > input.maxDimension) {
      if (input.renderer !== "genoffice") return null;
      throw new Error(`GenOffice 输出尺寸 ${width}×${height} 超过 ${input.maxDimension}px；请选择 renderer=native`);
    }
    return { base64: bytes.toString("base64"), mime: "image/png", pageCount, width, height };
  } finally {
    clearTimeout(timeout);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Render a PDF page using GenOffice PDFium when available, or optional PyMuPDF compatibility. */
export async function renderPdfPage(input: { abs: string; page: number; maxDimension?: number; renderer?: "auto" | "native" | "genoffice" }): Promise<{
  base64: string; mime: "image/jpeg" | "image/png"; pageCount: number | null; width: number; height: number;
}> {
  if (!Number.isInteger(input.page) || input.page < 1) throw new Error("page 必须是从 1 开始的整数");
  const maxDimension = Math.max(400, Math.min(input.maxDimension ?? 1400, 2000));
  if (!documentReadGate.tryAcquire()) {
    throw new Error(`同时进行的文档读取/渲染已达上限 ${MAX_CONCURRENT_DOCUMENT_READS}`);
  }
  try {
    if (path.extname(input.abs).toLowerCase() !== ".pdf") throw new Error("仅支持 PDF 文件");
    const st = await fs.stat(input.abs);
    if (!st.isFile()) throw new Error("PDF 页面渲染输入不是普通文件");
    if (st.size > DOCUMENT_READ_BUDGET.maxRawBytes) {
      throw new Error(`PDF 页面渲染输入 ${st.size} 字节,超过原始输入上限 ${DOCUMENT_READ_BUDGET.maxRawBytes}(与文档读取共用 ReadBudget)`);
    }
    if (input.renderer !== "native") {
      const vendorImage = await renderWithGenoffice({ ...input, maxDimension });
      if (vendorImage !== null) return vendorImage;
    }
    const py = await findPythonExecutable();
    if (!py) throw new Error("PDF 页面渲染需要本机 Python + PyMuPDF；Python 不可用");
    const script = [
      "import sys,json,base64",
      "try:",
      " import pymupdf as fitz",
      "except ImportError:",
      " print(json.dumps({'error':'缺少 PyMuPDF (pymupdf)。请在本机 Python 环境安装 pymupdf；未渲染任何页面'}));sys.exit(2)",
      "p=sys.argv[1];num=int(sys.argv[2]);mx=int(sys.argv[3])",
      "doc=fitz.open(p)",
      "try:",
      " if doc.needs_pass: raise ValueError('PDF 已加密，需要密码')",
      " if num<1 or num>len(doc): raise ValueError(f'请求第 {num} 页，但文档共 {len(doc)} 页')",
      " page=doc[num-1]",
      " bound=page.rect",
      " if bound.width<=0 or bound.height<=0: raise ValueError('页面尺寸无效')",
      " scale=min(mx/float(max(bound.width,bound.height)),2.0)",
      " pix=page.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False,colorspace=fitz.csRGB)",
      " blob=pix.tobytes('jpeg',jpg_quality=80)",
      " if len(blob)>6*1024*1024: raise ValueError('渲染结果超过 6MiB，减小 max_dimension 再试')",
      " print(json.dumps({'base64':base64.b64encode(blob).decode('ascii'),'pageCount':len(doc),'width':pix.width,'height':pix.height}))",
      "finally:",
      " doc.close()",
    ].join("\n");
    const out = await runCaptured(py, ["-c", script, input.abs, String(input.page), String(maxDimension)],
      30000, PYTHON_DOCUMENT_ENV, 9 * 1024 * 1024);
    if (out.code !== 0) throw new Error(`PDF 页面渲染失败: ${out.stdout.trim() || out.stderr.trim() || `exit ${out.code}`}`);
    const parsed = JSON.parse(out.stdout) as { base64?: string; pageCount?: number; width?: number; height?: number; error?: string };
    if (parsed.error || !parsed.base64 || !parsed.pageCount || !parsed.width || !parsed.height) {
      throw new Error(parsed.error ?? "PDF 页面渲染输出无效");
    }
    if (Buffer.byteLength(parsed.base64, "ascii") > 8 * 1024 * 1024) throw new Error("渲染图像超过输出预算");
    return { base64: parsed.base64, mime: "image/jpeg", pageCount: parsed.pageCount, width: parsed.width, height: parsed.height };
  } finally {
    documentReadGate.release();
  }
}

export const MAX_DOCUMENT_OUTPUT_CHARS = 100_000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function capDocumentOutput(textValue: string, label: string, maxChars = MAX_DOCUMENT_OUTPUT_CHARS): string {
  if (textValue.length <= maxChars) return textValue;
  const marker = `\n…[${label} 超过 ${maxChars} 字符，已截断]`;
  const end = Math.max(0, maxChars - marker.length);
  let prefix = textValue.slice(0, end);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + marker.slice(0, maxChars);
}

// runCaptured decodes UTF-8. Python redirected streams otherwise inherit the
// system code page (e.g. cp1252/GBK), which can reject Chinese/emoji outright.
// Scope overrides to owned document-reader children; never mutate parent env
// or change the encoding of arbitrary shell commands.
export const PYTHON_DOCUMENT_ENV = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

/**
 * Read the actual WordprocessingML body structure rather than guessing headings
 * from plain text. The shared readRichDocument gate validates OOXML zip inflation.
 */
async function docxStructureText(abs: string, start: number, maxBlocks: number, maxChars: number): Promise<string> {
  const py = await findPythonExecutable();
  if (!py) throw new Error("DOCX 结构读取需要本机 Python（使用内置 zipfile/XML）");
  const script = [
    "import sys,zipfile,xml.etree.ElementTree as ET,json",
    "f,start,limit=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])",
    "w='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'",
    "with zipfile.ZipFile(f) as z: root=ET.fromstring(z.read('word/document.xml'))",
    "body=root.find(w+'body')",
    "if body is None: raise ValueError('缺少 Word body')",
    "blocks=[c for c in body if c.tag in (w+'p',w+'tbl')]",
    "if not blocks: print(json.dumps({'total':0,'entries':[]},ensure_ascii=False));sys.exit(0)",
    "if start>len(blocks): raise ValueError(f'block_start={start} 超过文档结构总数 {len(blocks)}')",
    "def txt(e): return ''.join(t.text or '' for t in e.iter(w+'t'))",
    "entries=[]",
    "for n,node in enumerate(blocks[start-1:start-1+limit],start):",
    " if node.tag==w+'p':",
    "  prop=node.find(w+'pPr')",
    "  style=prop.find(w+'pStyle') if prop is not None else None",
    "  entries.append({'n':n,'kind':'paragraph','style':style.get(w+'val') if style is not None else 'Normal','text':txt(node)})",
    " elif node.tag==w+'tbl':",
    "  rows=node.findall(w+'tr')",
    "  columns=max((len(row.findall(w+'tc')) for row in rows),default=0)",
    "  cells=[[txt(cell) for cell in row.findall(w+'tc')[:30]] for row in rows[:100]]",
    "  entries.append({'n':n,'kind':'table','rows':len(rows),'cols':columns,'cells':cells,'clipped':len(rows)>100 or columns>30})",
    "print(json.dumps({'total':len(blocks),'entries':entries},ensure_ascii=False))",
  ].join("\n");
  const out = await runCaptured(py, ["-c", script, abs, String(start), String(maxBlocks)],
    DOCUMENT_READ_BUDGET.maxTimeMs, PYTHON_DOCUMENT_ENV, DOCUMENT_READ_BUDGET.maxChildOutputBytes);
  if (out.code !== 0) throw new Error(`DOCX 结构解析失败: ${out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`}`);
  const parsed = JSON.parse(out.stdout) as {
    total: number;
    entries: Array<{ n: number; kind: "paragraph" | "table"; style?: string; text?: string;
      rows?: number; cols?: number; cells?: string[][]; clipped?: boolean }>;
  };
  const end = start + parsed.entries.length - 1;
  const nextBlock = end < parsed.total ? `；next_block_start=${end + 1}` : "";
  // Keep pagination visible even if a large paragraph forces max_chars to
  // truncate the body before the old continuation footer can be reached.
  const lines = [`[DOCX XML 结构] ${parsed.total} 个顶层段落/表格；本次读取 ${parsed.entries.length} 个，索引 ${start}–${Math.max(start, end)}${nextBlock}`];
  for (const entry of parsed.entries) {
    if (entry.kind === "paragraph") {
      lines.push(`\n## Block ${entry.n} PARAGRAPH style=${entry.style || "Normal"}\n${entry.text || "(空段落)"}`);
    } else {
      lines.push(`\n## Block ${entry.n} TABLE ${entry.rows}×${entry.cols} (${entry.rows}行×${entry.cols}列)`);
      for (const [i, cells] of (entry.cells ?? []).entries()) {
        lines.push(`row ${i + 1}: ${cells.map((v, j) => `[c${j + 1}]${v}`).join(" | ")}`);
      }
      if (entry.clipped) lines.push("[表格仅显示前 100 行、每行前 30 列；其余单元格未读取]");
    }
  }
  if (end < parsed.total) lines.push(`\n[结构仅部分读取；next_block_start=${end + 1}；可传 block_start 翻页]`);
  if (start > 1) lines.push("[此前的块未读取]");
  lines.push("[样式为 OOXML 原始 styleId，不代表已计算字体/页面布局；图片、批注、页眉页脚及嵌套表格不保证复原]");
  return capDocumentOutput(lines.join("\n"), "DOCX 结构", maxChars);
}

/**
 * GenOffice owns Office/PDF parsing. This is a routing adapter, never a second
 * parser: the existing CLI wrappers provide the real implementation and
 * fail-closed path checks. The historical readers remain an explicit compat
 * path for systems without the vendor runtime or unsupported legacy options.
 */
/**
 * Bound the input area before passing --range to GenOffice. Its native
 * readSheet currently materializes the entire requested rectangle *before*
 * --max-rows slices rows, so max_rows=1 alone does not bound allocations.
 * This is only an A1-range budget check; GenOffice stays the sole parser.
 */
function requireBoundedSheetRange(range: string | undefined): void {
  if (range === undefined) return;
  const match = /^([A-Za-z]{1,3})([1-9]\d{0,6})(?::([A-Za-z]{1,3})([1-9]\d{0,6}))?$/.exec(range.trim());
  if (!match) throw new Error(`Excel range 格式不支持:${range}；请指定 A1:D20 形式的单元格区域`);
  const column = (label: string): number => [...label.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const a = column(match[1]!);
  const b = column(match[3] ?? match[1]!);
  const firstRow = Number(match[2]);
  const lastRow = Number(match[4] ?? match[2]);
  if (a < 1 || b > 16_384 || a > 16_384 || b < 1 || firstRow > 1_048_576 || lastRow > 1_048_576) {
    throw new Error(`Excel range 超出工作表坐标上限:${range}`);
  }
  const cells = (Math.abs(lastRow - firstRow) + 1) * (Math.abs(b - a) + 1);
  if (cells > DOCUMENT_READ_BUDGET.maxCells!) {
    throw new Error(`Excel range=${range} 请求 ${cells} 格超过单元格预算 ${DOCUMENT_READ_BUDGET.maxCells} 格；GenOffice 在 --max-rows 截断前会先分配整个区域，请缩小 range`);
  }
}

/** Validate the vendor selection envelope; do not parse workbook contents here. */
function assertGenofficeSheetSelection(
  detail: unknown, input: { sheet?: string; range?: string; maxRows?: number },
): void {
  const d = detail && typeof detail === "object" ? detail as Record<string, unknown> : null;
  if (!d || typeof d.sheet !== "string" || !d.sheet
      || typeof d.range !== "string" || !Array.isArray(d.rows)
      || !Number.isSafeInteger(d.rowsShown) || !Number.isSafeInteger(d.rowsTotal)) {
    throw new Error("GenOffice Excel 工作表 range/rows/行数字段无效，拒绝错误表格结果");
  }
  if (input.sheet !== undefined && d.sheet.toLocaleLowerCase() !== input.sheet.toLocaleLowerCase()) {
    throw new Error(`GenOffice 返回工作表与请求 sheet=${input.sheet} 不一致，拒绝错误工作表内容`);
  }
  const shown = d.rowsShown as number;
  const total = d.rowsTotal as number;
  if (shown < 0 || total < 0 || shown > total || shown !== d.rows.length
      || shown > (input.maxRows ?? 30)) {
    throw new Error("GenOffice Excel 返回行数与 rowsShown/rowsTotal/max_rows 上限不一致");
  }
  const a1 = /^([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/;
  const returned = a1.exec(d.range as string);
  const col = (v: string): number => [...v].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  if (!returned) throw new Error("GenOffice Excel 返回 range 地址格式无效");
  const beginRow = Number(returned[2]);
  const endRow = Number(returned[4]);
  const beginCol = col(returned[1]!);
  const endCol = col(returned[3]!);
  if (beginRow > endRow || beginCol > endCol || endRow > 1_048_576 || endCol > 16_384
      || d.rows.some(row => !Array.isArray(row) || row.length !== endCol - beginCol + 1)) {
    throw new Error("GenOffice Excel 返回 rows 行宽/矩形 range 不一致");
  }
  if (shown > 0 && endRow !== beginRow + shown - 1) {
    throw new Error("GenOffice Excel 返回 range 与实际行数 rowsShown 不一致");
  }
  if (input.range !== undefined) {
    const request = /^([A-Z]{1,3})([1-9]\d{0,6})(?::([A-Z]{1,3})([1-9]\d{0,6}))?$/.exec(input.range.trim().toUpperCase());
    if (!request) throw new Error("GenOffice Excel 请求 range 非法");
    const requestedFirstRow = Math.min(Number(request[2]), Number(request[4] ?? request[2]));
    const requestedLastRow = Math.max(Number(request[2]), Number(request[4] ?? request[2]));
    const requestedFirstCol = Math.min(col(request[1]!), col(request[3] ?? request[1]!));
    const requestedLastCol = Math.max(col(request[1]!), col(request[3] ?? request[1]!));
    if (beginRow !== requestedFirstRow || beginCol !== requestedFirstCol
        || endCol !== requestedLastCol || endRow > requestedLastRow
        || total !== requestedLastRow - requestedFirstRow + 1) {
      throw new Error(`GenOffice Excel 返回 range=${d.range} 与请求 ${input.range} 不一致`);
    }
  }
}

async function readViaGenoffice(input: {
  abs: string; reader?: "auto" | "native" | "genoffice";
  pdfMode?: "text" | "layout"; pageStart?: number; maxPages?: number;
  docxMode?: "text" | "structure"; blockStart?: number; maxBlocks?: number;
  sheet?: string; range?: string; slideStart?: number; maxSlides?: number;
  maxRows?: number; maxCols?: number; maxChars?: number;
}, maxChars: number): Promise<string | null> {
  const ext = path.extname(input.abs).toLowerCase();
  const exact = input.reader === "genoffice";
  if (input.pdfMode === "layout" && ext === ".pdf") {
    if (exact) throw new Error("GenOffice pdf_read 仅返回文本层/页面尺寸，不提供 x/y 排版坐标；请用 reader=native + pdf_mode=layout");
    return null;
  }
  // GenOffice sheet/slides CLI read has different filtering contracts; do not
  // silently ignore legacy options by passing them to an unrelated command.
  const legacyOptions = (([".xlsx", ".xlsm", ".xltx"].includes(ext))
    && input.maxCols !== undefined)
    || (([".pptx", ".potx"].includes(ext)) && (input.maxSlides ?? 1) > 8);
  if (legacyOptions) {
    if (exact && [".pptx", ".potx"].includes(ext) && (input.maxSlides ?? 1) > 8) {
      throw new Error("GenOffice 原生幻灯片逐页读取最多8张/次；请调小 max_slides，或明确使用 reader=native");
    }
    if (exact) throw new Error("该筛选参数暂不能安全映射到 GenOffice read；请使用 reader=native，或直接使用 GenOffice 的 sheet_read/slides_read 工具");
    return null;
  }
  const supported = [".docx", ".dotx", ".pptx", ".potx", ".xlsx", ".xlsm", ".xltx", ".pdf"].includes(ext);
  if (!supported) return null;
  if ([".xlsx", ".xlsm", ".xltx"].includes(ext)) requireBoundedSheetRange(input.range);
  // documentRepoRoot is also used by document.read / MCP installation. Do not
  // invent a different CLI bundle location for the public tool.
  const cliPath = await findBundledGenofficeCli();
  if (!cliPath) {
    if (exact) throw new Error("GenOffice CLI 未构建/未安装；请构建 genoffice/packages/cli，或改用 reader=native");
    return null;
  }
  const allowedPath = path.resolve(input.abs);
  // Public tool pOfRead checks the selected project's symlink fence before
  // this point. Limit the vendor CLI to only that checked single file here.
  const ports = { cliPath, withinWorkspace: (p: string) => path.resolve(p) === allowedPath };
  let result: GenofficeResult;
  let probedDocBlocks: number | null = null;
  let probedPdfPages: number | null = null;
  // PDF/DOCX perform a vendor probe followed by the selected native read.
  // Both calls must share ONE document deadline and one source-file identity;
  // matching page/block counts do not prove the file stayed unchanged.
  const stagedRead = ext === ".pdf" || ext === ".docx" || ext === ".dotx";
  const sourceStat = stagedRead ? await fs.stat(input.abs, { bigint: true }) : null;
  const stageController = stagedRead ? new AbortController() : null;
  const stageTimeout = stageController
    ? setTimeout(() => stageController.abort(), DOCUMENT_READ_BUDGET.maxTimeMs) : null;
  const readCheckedStage = async (run: (signal?: AbortSignal) => Promise<GenofficeResult>): Promise<GenofficeResult> => {
    if (stageController?.signal.aborted) throw new Error(`GenOffice 文档两阶段读取超过 ${DOCUMENT_READ_BUDGET.maxTimeMs}ms 总预算`);
    const part = await run(stageController?.signal);
    if (stageController?.signal.aborted) throw new Error(`GenOffice 文档两阶段读取超过 ${DOCUMENT_READ_BUDGET.maxTimeMs}ms 总预算`);
    if (sourceStat) {
      const current = await fs.stat(input.abs, { bigint: true });
      if (sourceStat.size !== current.size || sourceStat.mtimeNs !== current.mtimeNs
          || sourceStat.ctimeNs !== current.ctimeNs || sourceStat.ino !== current.ino || sourceStat.dev !== current.dev) {
        throw new Error("GenOffice PDF/DOCX 文件在元数据探测或正文读取期间发生修改；拒绝混合不同版本结果");
      }
    }
    return part;
  };
  try {
  if (ext === ".pdf") {
    const start = input.pageStart ?? 1;
    const count = input.maxPages;
    // GenOffice --max-chars is PER PAGE. 500 pages × 4000 chars would
    // overrun our 512-KiB JSON stdout envelope before we can paginate the
    // model response. Bound aggregate previews BEFORE invoking the vendor.
    const previewCharsPerPage = (pages: number): number =>
      Math.max(32, Math.min(4000, Math.floor(160_000 / Math.max(1, pages))));
    if (count === undefined && input.pageStart === undefined) {
      // GenOffice itself defaults to a bounded first-page window and reports
      // the continuation cursor.
      result = await readCheckedStage(signal => pdfRead(ports, input.abs, { maxChars: previewCharsPerPage(20), signal }));
    } else if (count === 1) {
      result = await readCheckedStage(signal => pdfRead(ports, input.abs, { page: start, maxChars: 4000, signal }));
    } else {
      // Vendor --range rejects an end that exceeds the real page count.
      // Probe its own bounded first window for the authoritative count, then
      // clamp the requested range. No duplicate PDF parser or metadata probe.
      const probe = await readCheckedStage(signal => pdfRead(ports, input.abs, { maxChars: 1, signal }));
      if (!probe.ok) {
        result = probe;
      } else {
        const total = (probe.envelope.detail as { pages?: unknown } | null)?.pages;
        if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
          throw new Error("GenOffice pdf_read 未返回可信页数，拒绝猜测翻页区间");
        }
        if (start < 1 || start > total) {
          throw new Error(`GenOffice PDF 页码 ${start} 超出范围 1–${total}`);
        }
        probedPdfPages = total;
        const end = Math.min(total, start + (count ?? 20) - 1);
        const perPage = previewCharsPerPage(end - start + 1);
        result = await readCheckedStage(signal => pdfRead(ports, input.abs,
          start === end ? { page: start, maxChars: perPage, signal }
          : { range: `${start}-${end}`, maxChars: perPage, signal }));
      }
    }
  } else if (ext === ".docx" || ext === ".dotx") {
    // The CLI stdout is capped to 512 KiB. Ask GenOffice itself for the
    // requested 0-based block window BEFORE serializing output; slicing a
    // full-document JSON afterwards fails on otherwise valid large DOCX.
    const from = input.docxMode === "structure" ? (input.blockStart ?? 1) - 1 : 0;
    const limit = input.docxMode === "structure" ? (input.maxBlocks ?? 30) : 30;
    const probe = await readCheckedStage(signal => docsRead(ports, input.abs, { range: "0", maxChars: 100, signal }));
    if (!probe.ok) {
      // A truly empty document has no valid --range 0; read its small empty
      // envelope without a range instead of changing its success semantics.
      if (/0--1/.test(probe.reason)) {
        if (from > 0) throw new Error(`block_start=${from + 1} 超过 GenOffice 结构块数量 0`);
        result = await readCheckedStage(signal => docsRead(ports, input.abs, { maxChars: 100, signal }));
      } else {
        result = probe;
      }
    } else {
      const count = (probe.envelope.detail as { blocks?: unknown } | null)?.blocks;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
        throw new Error("GenOffice docs_read 未返回可信结构块总数，拒绝猜测页段");
      }
      if (from >= count) throw new Error(`block_start=${from + 1} 超过 GenOffice 结构块数量 ${count}`);
      probedDocBlocks = count;
      const end = Math.min(count - 1, from + limit - 1);
      // Use the CLI's existing per-block preview control; never request
      // --full for an unbounded document and then truncate in our process.
      const perBlockChars = Math.max(100, Math.min(4000, Math.floor(maxChars / Math.max(1, limit * 2))));
      result = await readCheckedStage(signal => docsRead(ports, input.abs, { range: `${from}-${end}`, maxChars: perBlockChars, signal }));
    }
  } else if (ext === ".pptx" || ext === ".potx") {
    // GenOffice supports --slide (0-based), not a multi-slide range. Never
    // serialize an entire deck to the bounded 512KiB CLI stdout merely to
    // slice it afterwards; request each selected slide from the original CLI.
    // Eight is a hard bound on subprocess count per public tool call.
    const from = (input.slideStart ?? 1) - 1;
    const limit = input.maxSlides ?? 1;
    const perSlide = Math.max(100, Math.min(1000, Math.floor(maxChars / Math.max(1, limit * 3))));
    // Eight CLI calls must share ONE 60s budget and one file identity. Without
    // either, a caller can wait 8×60s or mix slides from different revisions
    // of a deck that still has the same slide count.
    const initial = await fs.stat(input.abs, { bigint: true });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), DOCUMENT_READ_BUDGET.maxTimeMs);
    const readCheckedSlide = async (slide: number | undefined, preview: number): Promise<GenofficeResult> => {
      if (abort.signal.aborted) throw new Error(`GenOffice 幻灯片窗口超过 ${DOCUMENT_READ_BUDGET.maxTimeMs}ms 总预算`);
      const part = await slidesRead(ports, input.abs, abort.signal, {
        ...(slide === undefined ? {} : { slide }), maxChars: preview,
      });
      if (abort.signal.aborted) throw new Error(`GenOffice 幻灯片窗口超过 ${DOCUMENT_READ_BUDGET.maxTimeMs}ms 总预算`);
      const current = await fs.stat(input.abs, { bigint: true });
      if (initial.size !== current.size || initial.mtimeNs !== current.mtimeNs
          || initial.ctimeNs !== current.ctimeNs || initial.ino !== current.ino || initial.dev !== current.dev) {
        throw new Error("GenOffice PPTX 文件在分页面读取过程中发生修改；拒绝将不同版本幻灯片拼接，请重新读取");
      }
      return part;
    };
    try {
    const first = await readCheckedSlide(from, perSlide);
    if (!first.ok) {
      // An empty valid deck has no slide 0: check GenOffice's own unfiltered
      // metadata only for that specific case, never reinterpret a corrupt PPTX.
      if (from === 0 && /slide out of range/i.test(first.reason)) {
        const empty = await readCheckedSlide(undefined, 100);
        const d = empty.ok ? empty.envelope.detail as { slides?: unknown; pages?: unknown } | null : null;
        result = empty.ok && d?.slides === 0 && Array.isArray(d.pages) && d.pages.length === 0
          ? empty : { ...first, reason: `slide_start=1: ${first.reason}` };
      } else {
        result = { ...first, reason: `slide_start=${from + 1}: ${first.reason}` };
      }
    } else {
      const firstDetail = first.envelope.detail as { slides?: unknown; pages?: unknown } | null;
      const total = firstDetail?.slides;
      const firstPages = firstDetail?.pages;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 1 || !Array.isArray(firstPages)
          || firstPages.length !== 1 || (firstPages[0] as { index?: unknown })?.index !== from) {
        throw new Error("GenOffice slides_read 未返回与请求页码一致的结构，拒绝猜测幻灯片");
      }
      const pages: unknown[] = [...firstPages];
      const end = Math.min(total, from + limit);
      for (let index = from + 1; index < end; index++) {
        const next = await readCheckedSlide(index, perSlide);
        if (!next.ok) throw new Error(`GenOffice 第 ${index + 1} 张幻灯片读取失败：${next.reason}`);
        const info = next.envelope.detail as { slides?: unknown; pages?: unknown } | null;
        if (info?.slides !== total || !Array.isArray(info.pages) || info.pages.length !== 1
            || (info.pages[0] as { index?: unknown })?.index !== index) {
          throw new Error("GenOffice 演示稿在分页过程中发生变化，拒绝拼接不同版本的幻灯片");
        }
        pages.push(info.pages[0]);
      }
      const continuation = end < total ? { next_slide: end + 1, truncated: true } : {};
      result = { ok: true, envelope: {
        ...first.envelope,
        detail: { ...firstDetail, pages, read_slides: [from + 1, end],
          ...(from > 0 ? { prior_slides_omitted: true } : {}), ...continuation,
          note: "按原厂 GenOffice slides --slide 原生读取；slide_start/next_slide 为 1-based，单次最多8页；每页正文可受预览字符限制",
        },
      } };
    }
    } finally {
      clearTimeout(timeout);
    }
  } else {
    // Delegate common sheet selection to GenOffice itself; 30-row default
    // keeps the public preview well below CLI stdout limits. Explicit
    // max_cols cannot be translated without changing native semantics.
    result = await sheetRead(ports, input.abs, undefined, {
      sheet: input.sheet, range: input.range, maxRows: input.maxRows ?? 30,
    });
  }
  } finally {
    if (stageTimeout !== null) clearTimeout(stageTimeout);
  }
  if (!result.ok) {
    if (result.kind === "unavailable" && !exact) return null;
    throw new Error(`GenOffice ${result.kind}: ${result.reason}`);
  }
  let detail = result.envelope.detail;
  // Trust the GenOffice parser for extraction, but not a mismatched selection:
  // returning a different page/sheet as success would silently mislead the
  // agent, especially when the result is clipped and only its heading remains.
  if (ext === ".pdf") {
    const d = detail as { pages?: unknown; pages_read?: unknown } | null;
    if (typeof d?.pages !== "number" || !Number.isSafeInteger(d.pages) || d.pages < 0
        || !Array.isArray(d.pages_read)) throw new Error("GenOffice PDF 页数/读取页段元数据无效");
    const selected = d.pages_read as Array<{ page?: unknown }>;
    const start = input.pageStart ?? 1;
    if (probedPdfPages !== null && d.pages !== probedPdfPages) {
      throw new Error(`GenOffice PDF 页数从 ${probedPdfPages} 变化为 ${d.pages}，拒绝拼接不同版本的分页结果`);
    }
    const valid = selected.every((item, i) => item !== null && typeof item === "object"
      && item.page === start + i && (item.page as number) <= (d.pages as number));
    const expectedCount = input.maxPages === undefined ? null
      : Math.min(input.maxPages, Math.max(0, d.pages - start + 1));
    if (!valid || (selected.length === 0 && d.pages > 0)
        || (expectedCount !== null && selected.length !== expectedCount)) {
      throw new Error(`GenOffice PDF 返回页段与请求页码 ${start} 或请求页数不一致，拒绝缺页/错页内容`);
    }
  }
  if ([".xlsx", ".xlsm", ".xltx"].includes(ext)) {
    assertGenofficeSheetSelection(detail, input);
  }
  if (ext === ".docx" || ext === ".dotx") {
    const d = detail && typeof detail === "object" ? detail as { blocks?: number; items?: unknown[]; range?: unknown } : null;
    if (!d || !Array.isArray(d.items) || !Number.isSafeInteger(d.blocks) || (d.blocks ?? -1) < 0) {
      throw new Error("GenOffice DOCX 结构块字段无效，拒绝假成功或缺失的块结果");
    }
    if (probedDocBlocks !== null && d.blocks !== probedDocBlocks) {
      throw new Error(`GenOffice DOCX 结构块数量从 ${probedDocBlocks} 变化为 ${d.blocks}，拒绝拼接不同版本结果`);
    }
    if (d.blocks === 0 && (d.items.length !== 0 || d.range !== "0--1")) {
      throw new Error("GenOffice DOCX 声明空结构却返回非空块/错误范围，拒绝假成功");
    }
    {
      const from = input.docxMode === "structure" ? (input.blockStart ?? 1) - 1 : 0;
      const maxBlocks = input.docxMode === "structure" ? (input.maxBlocks ?? 30) : 30;
      if (d.blocks! > 0) {
        const expectedEnd = Math.min(d.blocks! - 1, from + maxBlocks - 1);
        const expectedRange = `${from}-${expectedEnd}`;
        if (d.range !== expectedRange || d.items.length !== expectedEnd - from + 1
            || !d.items.every((item, index) => item !== null && typeof item === "object"
              && (item as { index?: unknown }).index === from + index)) {
          throw new Error(`GenOffice DOCX 结构块索引/index/range 与请求 ${expectedRange} 不一致，拒绝错位块内容`);
        }
      }
      const last = from + d.items.length - 1;
      detail = {
        ...d,
        ...(d.items.length > 0 ? { requested_blocks: [from, last] } : {}),
        ...(last + 1 < d.blocks! ? { next_block_start: last + 2, truncated: true } : {}),
        ...(from > 0 ? { prior_blocks_omitted: true } : {}),
        units: "GenOffice 原生索引从 0 开始；public block_start 从 1 开始；每块文本可能按 max_chars 限额预览",
      };
    }
  }
  const engine = ext === ".pdf" ? "GenOffice/PDFium" : "GenOffice/Office";
  const data = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
  const totalPages = data.pages;
  const legacyPdfHeader = ext === ".pdf" && typeof totalPages === "number" ? `[PDF ${totalPages} 页] ` : "";
  // Put truthful pagination metadata BEFORE the potentially large JSON body.
  // Otherwise max_chars=100 hides next_slide/next_block_start/pages_read at
  // the tail, and an agent cannot resume after a clipped preview.
  const cursor: string[] = [];
  if ([".pptx", ".potx"].includes(ext)) {
    const slides = data.read_slides;
    if (Array.isArray(slides) && slides.length === 2 && slides.every(n => Number.isSafeInteger(n))) {
      cursor.push(`slides=${slides[0]}-${slides[1]}`);
    }
    if (Number.isSafeInteger(data.next_slide)) cursor.push(`next_slide=${data.next_slide}`);
    if (data.prior_slides_omitted) cursor.push("prior_slides_omitted");
  } else if ([".docx", ".dotx"].includes(ext)) {
    const blocks = data.requested_blocks;
    if (Array.isArray(blocks) && blocks.length === 2 && blocks.every(n => Number.isSafeInteger(n))) {
      cursor.push(`blocks=${Number(blocks[0]) + 1}-${Number(blocks[1]) + 1}`);
    }
    if (Number.isSafeInteger(data.next_block_start)) cursor.push(`next_block_start=${data.next_block_start}`);
  } else if (ext === ".pdf" && typeof totalPages === "number" && Number.isSafeInteger(totalPages)) {
    const read = data.pages_read;
    if (Array.isArray(read) && read.length > 0) {
      const indices = read.map((p: unknown) => (p !== null && typeof p === "object") ? (p as { page?: unknown }).page : null);
      if (indices.every(n => Number.isSafeInteger(n) && (n as number) > 0)) {
        const last = indices[indices.length - 1] as number;
        cursor.push(`pages=${indices[0]}-${last}`);
        if (last < totalPages) cursor.push(`next_page=${last + 1}`);
      }
    }
  } else if ([".xlsx", ".xlsm", ".xltx"].includes(ext)) {
    if (typeof data.sheet === "string") cursor.push(`sheet=${data.sheet}`);
    if (typeof data.range === "string") cursor.push(`range=${data.range}`);
    if (typeof data.rowsShown === "number" && typeof data.rowsTotal === "number") {
      cursor.push(`rows=${data.rowsShown}/${data.rowsTotal}`);
    }
  }
  const pagination = cursor.length ? ` [${cursor.join("; ")}]` : "";
  return capDocumentOutput(
    `${legacyPdfHeader}[${engine}]${pagination} ${result.envelope.summary ?? ""}\n${JSON.stringify(detail ?? {}, null, 2)}`,
    "GenOffice 文档", maxChars);
}

export async function readRichDocumentRaw(input: {
  abs: string;
  sheet?: string;
  range?: string;
  maxPages?: number;
  pageStart?: number;
  pdfMode?: "text" | "layout";
  reader?: "auto" | "native" | "genoffice";
  docxMode?: "text" | "structure";
  blockStart?: number;
  maxBlocks?: number;
  slideStart?: number;
  maxSlides?: number;
  maxRows?: number;
  maxCols?: number;
  maxChars?: number;
}): Promise<string> {
  const ext = path.extname(input.abs).toLowerCase();
  const maxChars = Math.max(100, Math.min(input.maxChars ?? MAX_DOCUMENT_OUTPUT_CHARS, 300_000));
  if (input.reader !== "native") {
    const viaGenoffice = await readViaGenoffice(input, maxChars);
    if (viaGenoffice !== null) return viaGenoffice;
    if (input.reader === "genoffice") throw new Error(`GenOffice 对 ${ext} 没有匹配的只读路由；请使用 reader=native 或 GenOffice 原生工具`);
  }
  if (ext === ".pdf") {
    if (input.pdfMode === "layout") {
      const layout = await extractPdfLayout(input.abs, input.pageStart ?? 1, input.maxPages ?? 10);
      if (!layout.ok) throw new Error(layout.error);
      return capDocumentOutput(layout.text, "PDF 布局", maxChars);
    }
    const out = await extractPdfText(input.abs, Math.max(1, Math.min(input.maxPages ?? 200, 500)), input.pageStart ?? 1);
    if (!out.ok) throw new Error(out.error);
    const notes = [
      out.truncated ? "只读取请求页段,其余页未读取(按 page_start/max_pages 翻页)" : "",
      out.failedPages.length ? `解析失败页: ${out.failedPages.join(", ")}` : "",
    ].filter(Boolean);
    const next = (input.pageStart ?? 1) + Math.max(1, Math.min(input.maxPages ?? 200, 500));
    // Show the next cursor in the short header, not only after potentially
    // clipped text, and only when unrequested later pages really exist.
    const nextPage = next <= out.pageCount ? `; next_page=${next}` : "";
    return capDocumentOutput(`[PDF ${out.pageCount} 页] [成功读取 ${out.pagesRead} 页${nextPage}${notes.length ? "; " + notes.join("; ") : ""}]\n${out.text || "(没有可抽取的文本层; 未执行 OCR)"}`, "PDF 文本", maxChars);
  }

  if (ext === ".docx" || ext === ".dotx") {
    if (input.docxMode === "structure") {
      return docxStructureText(input.abs, input.blockStart ?? 1, input.maxBlocks ?? 30, maxChars);
    }
    try {
      const out = await runCaptured("pandoc", [input.abs, "-t", "gfm"], DOCUMENT_READ_BUDGET.maxTimeMs, undefined, DOCUMENT_READ_BUDGET.maxChildOutputBytes);
      if (out.code === 0) return capDocumentOutput(out.stdout.trim() || "(文档没有可抽取文本)", "DOCX 文本", maxChars);
    } catch {
      // fall through to the standard-library OOXML extractor below
    }
    const py = await findPythonExecutable();
    if (!py) throw new Error("读取 DOCX 需要 pandoc 或 Python；当前都不可用");
    const script = [
      "import sys,zipfile,xml.etree.ElementTree as ET",
      "p=sys.argv[1]",
      "with zipfile.ZipFile(p) as z:",
      " data=z.read('word/document.xml')",
      " root=ET.fromstring(data)",
      " ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}",
      " for para in root.findall('.//w:p',ns):",
      "  txt=''.join((t.text or '') for t in para.findall('.//w:t',ns))",
      "  if txt: print(txt)",
    ].join("\n");
    const out = await runCaptured(py, ["-c", script, input.abs], DOCUMENT_READ_BUDGET.maxTimeMs, PYTHON_DOCUMENT_ENV, DOCUMENT_READ_BUDGET.maxChildOutputBytes);
    if (out.code !== 0) throw new Error(`DOCX 抽取失败:${out.stderr.trim() || `exit ${out.code}`}`);
    return capDocumentOutput(out.stdout.trim() || "(文档没有可抽取文本)", "DOCX 文本", maxChars);
  }

  if ([".xlsx", ".xlsm", ".xltx"].includes(ext)) {
    const py = await findPythonExecutable();
    if (!py) throw new Error("读取 Excel 需要 Python + openpyxl；当前没有可用 Python");
    // 【MC-065】把 max_rows/max_cols 收进同一份 ReadBudget 的 maxCells(行×列 ≤ maxCells),
    // 而不是两个各自独立的散装上限叠加成 20 万格。夹紧结果显式回报,不静默假装读全。
    const cellBudget = clampCellBudget(
      Math.max(1, Math.min(input.maxRows ?? 200, 1000)),
      Math.max(1, Math.min(input.maxCols ?? 50, 200)),
      DOCUMENT_READ_BUDGET.maxCells!,
    );
    const script = [
      "import sys,json",
      "try:",
      " from openpyxl import load_workbook",
      "except Exception as e:",
      " print(json.dumps({'error':'缺少 openpyxl: '+str(e)},ensure_ascii=False));sys.exit(2)",
      "try:",
      " from openpyxl.utils.cell import range_boundaries",
      "except Exception:",
      " range_boundaries=None",
      "p,sheet,rg,maxr,maxc=sys.argv[1],sys.argv[2],sys.argv[3],int(sys.argv[4]),int(sys.argv[5])",
      "wb=load_workbook(p,read_only=True,data_only=False)",
      "ws=wb[sheet] if sheet else wb[wb.sheetnames[0]]",
      "truncated=False",
      "if rg:",
      " # 【MC-065】显式 range 也在**迭代之前**夹紧:先解析边界再交给 iter_rows 惰性遍历,",
      " # 绝不 `ws[rg]` —— 那会先把整个矩形(可能是百万格)materialize 出来,与 max_rows/max_cols 无关。",
      " if range_boundaries is None:",
      "  print(json.dumps({'error':'openpyxl 版本过旧,缺少 range_boundaries,无法安全解析显式 range'},ensure_ascii=False));sys.exit(2)",
      " try:",
      "  c0,r0,c1,r1=range_boundaries(rg)",
      " except Exception as e:",
      "  print(json.dumps({'error':'range 不合法: '+str(rg)+' ('+str(e)+')'},ensure_ascii=False));sys.exit(2)",
      " if c0 is None or c1 is None: c0,c1=1,(ws.max_column or 1)",
      " if r0 is None or r1 is None: r0,r1=1,(ws.max_row or 1)",
      " minc,minr,maxc_req,maxr_req=int(c0),int(r0),int(c1),int(r1)",
      " maxr_eff=min(minr+maxr-1,maxr_req)",
      " maxc_eff=min(minc+maxc-1,maxc_req)",
      " if (maxr_req-minr+1)>maxr or (maxc_req-minc+1)>maxc: truncated=True",
      " cells=ws.iter_rows(min_row=minr,max_row=maxr_eff,min_col=minc,max_col=maxc_eff)",
      "else:",
      " maxr_eff=min(ws.max_row,maxr);maxc_eff=min(ws.max_column,maxc)",
      " cells=ws.iter_rows(min_row=1,max_row=maxr_eff,min_col=1,max_col=maxc_eff)",
      "rows=[]",
      "for row in cells:",
      " rows.append([c.value for c in row])",
      "print(json.dumps({'sheets':wb.sheetnames,'sheet':ws.title,'rows':rows,'rangeTruncated':truncated},ensure_ascii=False,default=str))",
    ].join("\n");
    const out = await runCaptured(py, ["-c", script, input.abs, input.sheet ?? "", input.range ?? "", String(cellBudget.maxRows), String(cellBudget.maxCols)], DOCUMENT_READ_BUDGET.maxTimeMs, PYTHON_DOCUMENT_ENV, DOCUMENT_READ_BUDGET.maxChildOutputBytes);
    if (out.code !== 0) throw new Error(`Excel 抽取失败:${out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`}`);
    const parsed = JSON.parse(out.stdout) as { error?: string; sheets?: string[]; sheet?: string; rows?: unknown[][]; rangeTruncated?: boolean };
    if (parsed.error) throw new Error(parsed.error);
    const lines = [`sheets: ${(parsed.sheets ?? []).join(", ")}`, `sheet: ${parsed.sheet ?? ""}`];
    if (parsed.rangeTruncated) {
      lines.push("[range 超过 max_rows/max_cols 上限,已在**迭代之前**夹紧 —— 这是部分区域,不是整个 range]");
    }
    if (cellBudget.cellBudgetTruncated) {
      lines.push(`[max_rows×max_cols 超过单元格预算 ${DOCUMENT_READ_BUDGET.maxCells} 格,已把返回行列夹到 ${cellBudget.maxRows}×${cellBudget.maxCols} —— 这是部分区域]`);
    }
    for (const [i, row] of (parsed.rows ?? []).entries()) {
      lines.push(`${i + 1}\t${row.map((v) => v == null ? "" : String(v).replace(/\r?\n/g, " ↵ ")).join("\t")}`);
    }
    return capDocumentOutput(lines.join("\n"), "Excel 文本", maxChars);
  }

  if ([".pptx", ".potx"].includes(ext)) {
    const py = await findPythonExecutable();
    if (!py) throw new Error("读取 PowerPoint 需要 Python + python-pptx；当前没有可用 Python");
    const script = [
      "import sys,json",
      "try:",
      " from pptx import Presentation",
      "except Exception as e:",
      " print(json.dumps({'error':'缺少 python-pptx: '+str(e)},ensure_ascii=False));sys.exit(2)",
      "prs=Presentation(sys.argv[1]);limit=int(sys.argv[2]);start=int(sys.argv[3]);slides=[]",
      "if len(prs.slides)==0 and start==1:",
      " print(json.dumps({'count':0,'slides':[]},ensure_ascii=False));sys.exit(0)",
      "if start > len(prs.slides):",
      " print(json.dumps({'error':f'slide_start={start} 超出 PPTX 幻灯片范围 (总数 {len(prs.slides)})'},ensure_ascii=False));sys.exit(0)",
      "for i,slide in enumerate(prs.slides,1):",
      " if i<start: continue",
      " if i>=start+limit: break",
      " parts=[]",
      " for sh in slide.shapes:",
      "  if hasattr(sh,'text') and sh.text.strip(): parts.append(sh.text.strip())",
      " slides.append({'n':i,'text':'\\n'.join(parts)})",
      "print(json.dumps({'count':len(prs.slides),'slides':slides},ensure_ascii=False))",
    ].join("\n");
    const out = await runCaptured(py, ["-c", script, input.abs,
      String(Math.max(1, Math.min(input.maxSlides ?? 200, 1000))), String(input.slideStart ?? 1)],
      DOCUMENT_READ_BUDGET.maxTimeMs, PYTHON_DOCUMENT_ENV, DOCUMENT_READ_BUDGET.maxChildOutputBytes);
    if (out.code !== 0) throw new Error(`PPTX 抽取失败:${out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`}`);
    const parsed = JSON.parse(out.stdout) as { error?: string; count?: number; slides?: Array<{ n: number; text: string }> };
    if (parsed.error) throw new Error(parsed.error);
    const readCount = parsed.slides?.length ?? 0;
    const start = input.slideStart ?? 1;
    const end = start + readCount - 1;
    const count = parsed.count ?? 0;
    const hasMore = end < count;
    const clipped = `${start > 1 ? `; 已略过前 ${start - 1} 页` : ""}${hasMore ? `; 其余页未读取, next_slide=${end + 1}` : ""}`;
    const body = [`[PPTX ${count} 页] [已读取 ${readCount} 页${clipped}]`, ...(parsed.slides ?? []).map((s) => `\n## Slide ${s.n}\n${s.text || "(无文本)"}`)];
    return capDocumentOutput(body.join("\n"), "PPTX 文本", maxChars);
  }

  throw new Error(`agent_read_document 暂不支持扩展名 ${ext || "(无)"}；支持 PDF/DOCX/XLSX/PPTX`);
}

/**
 * 【MC-065】文档读取的**并发上界**:`readRichDocumentRaw` 会在一个子进程里解压/解析整份
 * 文档(Excel 的 zip 膨胀、PDF 的整页光栅化)。很多个并发读取即便各自"小预算",也会把
 * 峰值内存/子进程数累加成无界。到上限即**立即拒绝**(不是排队攒内存)—— 与 URL 那条
 * `urlReadGate` 同一个约定,共用同一份 {@link DOCUMENT_READ_BUDGET} 里的并发常量。
 */
export async function readRichDocument(input: {
  abs: string;
  sheet?: string;
  range?: string;
  maxPages?: number;
  pageStart?: number;
  pdfMode?: "text" | "layout";
  reader?: "auto" | "native" | "genoffice";
  docxMode?: "text" | "structure";
  blockStart?: number;
  maxBlocks?: number;
  slideStart?: number;
  maxSlides?: number;
  maxRows?: number;
  maxCols?: number;
  maxChars?: number;
}): Promise<string> {
  if (!documentReadGate.tryAcquire()) {
    throw new Error(
      `同时进行的文档读取已达上限 ${MAX_CONCURRENT_DOCUMENT_READS};请稍后重试,避免多个大文档同时解析挤占内存`,
    );
  }
  try {
    // 【MC-065】压缩膨胀(zip 炸弹)在**同一份 ReadBudget** 上的前置信:读 OOXML 容器的中央目录,
    // 累加各成员声明的解压后大小,超 `maxDecompressedBytes` 就在**交给任何解析器/pandoc 之前**拒绝
    // —— 一条 Excel / DOCX(pandoc 或 Python) / PPTX 路径共用这一个点,不各写各的 Python 判据。
    // 放在闸门**之内**:中央目录扫描会把整个容器读进内存,故它本身也受并发上界约束。
    const ext = path.extname(input.abs).toLowerCase();
    // PDFium/pdfjs can eagerly parse file structures before output truncation;
    // apply the SAME raw-file budget before either backend spawns or reads.
    // max_chars is an output budget, never a substitute for an input bound.
    if (ext === ".pdf") {
      const pdfStat = await fs.stat(input.abs);
      if (!pdfStat.isFile()) throw new Error("PDF 输入不是普通文件");
      if (pdfStat.size > DOCUMENT_READ_BUDGET.maxRawBytes) {
        throw new Error(`PDF 文件 ${pdfStat.size} 字节,超过原始输入上限 ${DOCUMENT_READ_BUDGET.maxRawBytes}(这是读取预算,不是 PDF 内容损坏)`);
      }
    }
    const OOXML_EXTS = new Set([".xlsx", ".xlsm", ".xltx", ".docx", ".dotx", ".pptx", ".potx"]);
    if (OOXML_EXTS.has(ext)) {
      // 先按**磁盘原始大小**快速拒绝(声明式,与 URL 的 Content-Length 快拒同一思想):超 maxRawBytes
      // 的容器连读进内存做中央目录扫描都不做。
      const st = await fs.stat(input.abs).catch(() => null);
      if (st && st.size > DOCUMENT_READ_BUDGET.maxRawBytes) {
        throw new Error(
          `OOXML 容器文件 ${st.size} 字节,超过上限 ${DOCUMENT_READ_BUDGET.maxRawBytes}(这是输入预算,不是文档损坏)`,
        );
      }
      const bytes = await fs.readFile(input.abs).catch(() => null);
      if (bytes) {
        const infl = checkZipInflation(bytes, DOCUMENT_READ_BUDGET.maxDecompressedBytes!);
        if (infl.exceededBudget) {
          throw new Error(
            `OOXML 容器声明解压后体积至少 ${infl.declaredBytes} 字节,超过上限 ${DOCUMENT_READ_BUDGET.maxDecompressedBytes}(这是压缩膨胀预算,不是文档损坏)`,
          );
        }
      }
    }
    return await readRichDocumentRaw(input);
  } finally {
    documentReadGate.release();
  }
}

/**
 * 把一次有界 URL 读取的**结局**翻成给模型看的正文。【MC-065 §34.3】
 *
 * 关键在于**失败形态绝不伪装成完整短文**:`READ_ERROR_AFTER_PARTIAL` / `READ_ERROR` /
 * `TIMEOUT` 一律**抛出**(工具层判 isError),并说明"这是部分内容";只有正常 EOF
 * (`COMPLETE`)与按预算主动停止(`TRUNCATED_BY_BUDGET`)算成功,后者的回执显式标注
 * "这是部分正文"。从前读流中途失败会被折成一个 `truncated:false` 的"完整短文" —— 一次
 * 中途断网被当成 read 成功,正是复审反例。
 */
export function urlOutcomeToText(header: string, outcome: ReadOutcome, budget: ReadBudget): string {
  switch (outcome.kind) {
    case "COMPLETE":
      return `${header}\n\n${outcome.text || "(空响应)"}`;
    case "TRUNCATED_BY_BUDGET":
      return (
        `${header}\n\n${outcome.text}\n` +
        `(响应超过 ${budget.maxOutputChars} 字符上限,已在输入端停止读取 —— 这是部分正文,不是完整响应)`
      );
    case "TIMEOUT":
      throw new Error(
        `读取 URL 超过 ${budget.maxTimeMs}ms` +
          (outcome.charsRead ? `;已读到 ${outcome.charsRead} 字符(这是部分内容,不是完整响应)` : ""),
      );
    case "READ_ERROR_AFTER_PARTIAL":
      throw new Error(
        `读取 URL 中途失败:${outcome.error ?? "未知错误"};已读到 ${outcome.charsRead} 字符(这是部分内容,不是完整响应)`,
      );
    case "READ_ERROR":
      throw new Error(`读取 URL 失败:${outcome.error ?? "未知错误"}`);
  }
}

export async function readUrlText(url: string, maxChars: number, timeoutMs: number): Promise<string> {
  let current: URL;
  try { current = new URL(url); } catch { throw new Error(`URL 不合法:${url}`); }
  if (current.protocol !== "http:" && current.protocol !== "https:") throw new Error("只支持 http/https URL");
  const budget: ReadBudget = {
    ...URL_READ_BUDGET,
    maxOutputChars: Math.max(1_000, Math.min(maxChars, 300_000)),
    maxTimeMs: Math.max(1_000, Math.min(timeoutMs, 60_000)),
  };
  // 【MC-065】按端点做并发上界:很多个"小预算"并发也会累加出无界总内存,到上限即**立即拒绝**。
  if (!urlReadGate.tryAcquire()) {
    throw new Error(
      `同时进行的 URL 正文读取已达上限 ${MAX_CONCURRENT_URL_READS};请稍后重试,避免多个大响应同时挤占内存`,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget.maxTimeMs);
  try {
    // 【MC-065】手动跟随重定向,而不是 `redirect:"follow"` 让 undici 无界跟随:
    // 次数/协议在这里显式设上限,超限即报错,不静默跟到底。
    let res: Response;
    for (let redirects = 0; ; ) {
      res = await fetch(current, { signal: controller.signal, redirect: "manual" });
      if (!isRedirectStatus(res.status)) break;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`重定向 ${res.status} 未提供 Location`);
      if (redirects >= MAX_URL_REDIRECTS) throw new Error(`重定向次数超过上限 ${MAX_URL_REDIRECTS}`);
      redirects++;
      let next: URL;
      try { next = new URL(location, current); } catch { throw new Error(`重定向目标不合法:${location}`); }
      if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error(`重定向到非 http/https:${next.protocol}`);
      current = next;
    }
    const contentType = res.headers.get("content-type") ?? "";
    const header = `status: ${res.status} ${res.statusText}\nurl: ${res.url || current.toString()}\ncontent-type: ${contentType || "(未知)"}`;
    // 【MC-065】Content-Length 前置**快速拒绝**(仅作快速拒绝,绝不当计量 —— 可能缺失/伪造)。
    const declared = res.headers.get("content-length");
    if (declared !== null) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > budget.maxRawBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(
          `响应声明 Content-Length=${n} 字节,超过上限 ${budget.maxRawBytes};请改用更合适的工具,或用支持范围请求的来源`,
        );
      }
    }
    // 【MC-065】非文本策略:二进制响应直接拒绝并指向正确工具,不把二进制塞进正文预算。
    if (classifyContentType(contentType) === "binary") {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`响应 Content-Type 是 ${contentType || "(未知)"}(二进制);本工具只读文本,请改用 agent_read_document / agent_read_image`);
    }
    const outcome = await readResponseWithinBudget(res, budget);
    return urlOutcomeToText(header, outcome, budget);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error(`读取 URL 超过 ${budget.maxTimeMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    urlReadGate.release();
  }
}

/**
 * 把子进程的一批字节**安全地**接到累积字符串上。
 *
 * `data` 事件的边界可以落在一个多字节字符的中间 —— 直接 `d.toString()` 会把那个字符
 * 切成两半、各自变成 `U+FFFD`,而这段文本是要交给模型的(还可能落进 `stdout` 字段),
 * **损坏了就是永久的**。`StringDecoder` 会把不完整的尾巴留到下一批,正是干这个的。
 *
 * `decoder` 由调用方持有 —— **每条流各一份**,不能共用(`agent_bash` 与
 * `runCaptured` 都各带自己的那两个)。
 *
 * `cap` 是累计上限:到了就不再接(与原来那句 `if (len < cap)` 同一个判据)。
 */
export function appendDecoded(
  acc: { text: string },
  decoder: ConsoleTextDecoder,
  chunk: Buffer | string,
  cap: number,
  prefix = "",
): void {
  if (acc.text.length >= cap) return;
  const text = decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  if (!text) return;
  acc.text += prefix + text;
}

/** 每条流一个解码器(`appendDecoded` 用)。 */
export function newDecoder(): ConsoleTextDecoder {
  // 不只是扛跨块的半个字符:中文 Windows 上 cmd 的输出是 GBK,见 ConsoleTextDecoder。
  return new ConsoleTextDecoder();
}
