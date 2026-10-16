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
import { homedir } from "node:os";
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
import { extractPdfText } from "@main/library/pdfText.js";
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

export async function readRichDocumentRaw(input: {
  abs: string;
  sheet?: string;
  range?: string;
  maxPages?: number;
  maxSlides?: number;
  maxRows?: number;
  maxCols?: number;
  maxChars?: number;
}): Promise<string> {
  const ext = path.extname(input.abs).toLowerCase();
  const maxChars = Math.max(100, Math.min(input.maxChars ?? MAX_DOCUMENT_OUTPUT_CHARS, 300_000));
  if (ext === ".pdf") {
    const out = await extractPdfText(input.abs, Math.max(1, Math.min(input.maxPages ?? 200, 500)));
    if (!out.ok) throw new Error(out.error);
    const notes = [
      out.truncated ? "按 max_pages 截断,其余页未读取" : "",
      out.failedPages.length ? `解析失败页: ${out.failedPages.join(", ")}` : "",
    ].filter(Boolean);
    return capDocumentOutput(`[PDF ${out.pageCount} 页] [成功读取 ${out.pagesRead} 页${notes.length ? "; " + notes.join("; ") : ""}]\n${out.text || "(没有可抽取的文本层; 未执行 OCR)"}`, "PDF 文本", maxChars);
  }

  if (ext === ".docx" || ext === ".dotx") {
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
      "prs=Presentation(sys.argv[1]);limit=int(sys.argv[2]);slides=[]",
      "for i,slide in enumerate(prs.slides,1):",
      " if i>limit: break",
      " parts=[]",
      " for sh in slide.shapes:",
      "  if hasattr(sh,'text') and sh.text.strip(): parts.append(sh.text.strip())",
      " slides.append({'n':i,'text':'\\n'.join(parts)})",
      "print(json.dumps({'count':len(prs.slides),'slides':slides},ensure_ascii=False))",
    ].join("\n");
    const out = await runCaptured(py, ["-c", script, input.abs, String(Math.max(1, Math.min(input.maxSlides ?? 200, 1000)))], DOCUMENT_READ_BUDGET.maxTimeMs, PYTHON_DOCUMENT_ENV, DOCUMENT_READ_BUDGET.maxChildOutputBytes);
    if (out.code !== 0) throw new Error(`PPTX 抽取失败:${out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`}`);
    const parsed = JSON.parse(out.stdout) as { error?: string; count?: number; slides?: Array<{ n: number; text: string }> };
    if (parsed.error) throw new Error(parsed.error);
    const readCount = parsed.slides?.length ?? 0;
    const clipped = readCount < (parsed.count ?? 0) ? "; 按 max_slides 截断,其余页未读取" : "";
    const body = [`[PPTX ${parsed.count ?? 0} 页] [已读取 ${readCount} 页${clipped}]`, ...(parsed.slides ?? []).map((s) => `\n## Slide ${s.n}\n${s.text || "(无文本)"}`)];
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
    const OOXML_EXTS = new Set([".xlsx", ".xlsm", ".xltx", ".docx", ".dotx", ".pptx", ".potx"]);
    if (OOXML_EXTS.has(path.extname(input.abs).toLowerCase())) {
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
