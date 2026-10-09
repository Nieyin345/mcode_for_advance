/**
 * **mcode-agent** —— 网页端模型的通用 agent 工具集(读写文件、目录、搜索、执行命令、
 * 读技能)。只进 `webToolHost` 那张表,**不**注册给桌面三引擎 —— claude/codex/pi
 * 自带 Read/Write/Bash 这类原生工具,同一套东西再造一份只会让审批与权限矩阵多一列。
 *
 * ## 为什么这些必须是 mcode 侧的工具
 *
 * 网页模型唯一能"动手"的途径就是 `tools/call` 打回来(见 `webToolHost.ts`)。挂载的
 * 资料库条目(通用文件管理:文件/论文/笔记/模版,分类用户自定义)在提示词里只是一行
 * `@路径`(渲染端刻意不内联正文,见 `composePromptWithTags`),
 * claude 引擎用原生 Read 就能读,网页模型却没有任何文件工具 —— 这就是"模型说看不到
 * 挂载的文献"的根因。这一套补齐之后,网页端与 API 源的能力才真正对齐。
 *
 * ## 工作目录:相对路径的解析基准
 *
 * handler 拿到的 ctx 只有 sessionId,会话的 cwd 由 {@link AgentToolsDeps.cwdFor}
 * 注入(真实实现是 `RuntimeManager.cwdFor`:live 运行时的 lastCwd,兜底会话所属
 * 项目的路径)。绝对路径默认原样接受 —— 和 claude 引擎一样的自由度,写操作反正
 * 有审批闸门兜着。
 *
 * **例外:公网那条通路没有审批闸门**(用户选的是免审批),所以它额外给一个
 * {@link AgentToolsDeps.sandboxRootFor} —— 文件工具被限制在那个项目目录里。它约束不了
 * `agent_bash`(见 `resolveAgainstCwd` 那段:能 `cd ..` 就能出去),所以是"防误操作"
 * 而不是"防得住"。桌面本机那条不给这个根,行为与从前完全一致。
 *
 * ## 审批分级(与 toolGate.ts 的两份清单对齐)
 *
 *   - 只读({@link AGENT_READONLY_TOOLS}):读文件 / 列目录 / glob / grep / 读技能,
 *     任何权限模式都放行;
 *   - 改文件({@link AGENT_EDIT_TOOLS}):写 / 改,`acceptEdits` 档放行(与 claude 的
 *     Write/Edit 同档),default 模式弹卡;
 *   - bash:风险最高,**不在任何自动放行清单里**,除了 bypass/「始终允许」
 *     一律弹卡(dontAsk 是不问就拒,不在放行之列)。
 */
import { publicSkillReadDenial } from "@main/mcp/publicSkills.js";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface as createReadlineInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readTextPage, formatTextPage, withTextFileLock, replaceTextFile, textFileHash, grepMatchPreview, type TextPageOptions } from "./agentTextFiles.js";
import { ConsoleTextDecoder } from "@main/lib/outBuf.js";
import { z } from "zod";
import {
  defaultSkillsRoot,
  engineEnabled,
  parseSkillFrontmatter,
  readEnginesMap,
  SKILL_ENGINES,
  skillNamesInRoot,
} from "@main/lib/skillEngines.js";
import { extractPdfText } from "@main/library/pdfText.js";
import { killTree, TREE_KILLABLE } from "@main/lib/spawnRun.js";
// `agent_bash` 的写目标检查复用 Pi 那条路已有的解析器(不写第二份,硬规矩 2)。
import { extractBashWriteTargets, expandTilde } from "@main/providers/pi-sdk/bashWriteGuard.js";
// `agent_context` 要在工具层回答"我在什么环境里" —— 与注入到提示词里的那段环境块
// **共用同一份查询**(见 `readEnvSnapshot`),不在这里再查一遍库/项目。
import { readEnvSnapshot } from "@main/providers/envPrompt.js";
import type { LibraryForAi, SandboxReadCheck, SandboxReadKind } from "./sandboxReadPolicy.js";
import { fail, image, text, type McpToolContext, type McpToolSpec } from "./sdk.js";
import { structured as structuredResult } from "./sdk.js";
import {
  createAgentProcessSessions,
  MAX_PROCESS_TIMEOUT_MS,
  MAX_PROCESS_WAIT_MS,
  type AgentProcessReadResult,
} from "./agentProcessSessions.js";
import { createAgentSearchSessions, SKIP_DIRS, type AgentSearchReadResult } from "./agentSearchSessions.js";
import { registerAgentSessionDisposer, registerAgentShutdownHook } from "./agentSessionCleanup.js";
import { createAgentRemoteSshManager, type RemoteConnectionInfo, type RemoteJobStatus, DEFAULT_SSH_EXEC_TIMEOUT_MS, MAX_SSH_EXEC_TIMEOUT_MS, DEFAULT_JOB_LOG_WAIT_MS, MAX_JOB_LOG_WAIT_MS } from "./agentRemoteSsh.js";
import {
  editDocxXml,
  editExcelRange,
  readDocxXml,
  writePdf,
  type AgentPdfOperation,
} from "./agentDocumentOps.js";

/** MCP server 名 —— **唯一的一份**。`toolRules` 的只读索引按它建键,而 Claude 那条路
 *  实际注册的 server 也用这个名字(见 `agentEngineBridge` 的 `AGENT_ENGINE_MCP_SERVER`,
 *  它是本常量的别名)。名字要对得上,否则 SDK 报出来的
 *  `mcp__<server>__agent_read_document` 在索引里查不到 → 这三个只读工具会被当成写工具,
 *  default 档每读一份 PDF 都弹卡、dontAsk 档直接拒(硬规矩 2:同一个事实只写一遍)。 */
export const AGENT_MCP_SERVER = "mcode-agent-tools";

/** 只读工具:任何权限模式都自动放行。 */
export const AGENT_READONLY_TOOLS = new Set([
  "agent_read_file",
  "agent_read_files",
  "agent_read_document",
  "agent_read_image",
  "agent_read_docx_xml",
  "agent_read_url",
  "agent_list_dir",
  "agent_glob",
  "agent_grep",
  "agent_file_info",
  "agent_list_processes",
  "agent_search_start",
  "agent_search_read",
  "agent_search_stop",
  "agent_search_list",
  "agent_process_read",
  "agent_process_sessions",
  "agent_ssh_status",
  "agent_ssh_disconnect",
  "agent_remote_job_status",
  "agent_remote_job_logs",
  "agent_remote_job_list",
  // stop 只能终止当前对话自己创建的 agent 进程，不接受 OS pid；属于安全清理动作。
  "agent_process_stop",
  "agent_skill_list",
  "agent_skill_read",
  // 只报项目 / 资料库概况,不改任何东西。不在这张表里时它被标成 destructive,
  // ChatGPT 之类的客户端每次调它都要弹确认框。
  "agent_context",
]);

/** 改文件工具:acceptEdits 档放行(与 claude 的 Write/Edit 同档)。 */
export const AGENT_EDIT_TOOLS = new Set([
  "agent_write_file",
  "agent_edit_file",
  "agent_move_file",
  "agent_create_directory",
  "agent_write_pdf",
  "agent_edit_excel_range",
  "agent_edit_docx_xml",
]);

export interface AgentToolsDeps {
  /** 会话 id → 工作目录(相对路径的解析基准)。null = 会话没有可用的 cwd,
   *  相对路径会被拒绝并提示用绝对路径。 */
  cwdFor(sessionId: string): string | null;
  /**
   * 会话 id → **沙箱根**(可选)。给了就只允许这个目录底下的路径,越界一律拒。
   *
   * 谁给:公网那条通路(合成会话挂着的项目目录)—— 它**没有审批闸门**,所以需要一道
   * 边界。谁不给(返回 null):桌面本机的会话,保持 claude 引擎那种自由度不变。
   * **别给所有会话都套上** —— 那会改掉本机一直在用的行为。
   *
   * ⚠️ 只约束文件工具,`agent_bash` 不受它限制(见 `resolveAgainstCwd` 那段)。
   */
  sandboxRootFor?(sessionId: string): string | null;
  /**
   * 有沙箱时,**沙箱外**的路径还能不能**只读**地碰(资料库、技能库)—— 见
   * `sandboxReadPolicy.ts`。没给 = 沙箱外一律拒(原来的行为)。写工具不问它。
   */
  sandboxReadCheck?: SandboxReadCheck;
  /**
   * `agent_context` 里资料库那份清单的**给 AI 的口径**(守屏蔽规则、给绝对路径)——
   * 见 `sandboxReadPolicy.ts` 的 `libraryForAi`。没给 = 退回环境快照里的原样条目。
   * 走注入是因为那条链要拉库模块,无头 smoke 的 bundle 装不下。
   */
  libraryForAi?: LibraryForAi;
}

/* ────────────────────────────── 共用小件 ────────────────────────────── */

/** 批量读取最多几个文件 / 最多返回多少字符，防一次调用把上下文灌满。 */
const MAX_BATCH_READ_FILES = 20;
const MAX_BATCH_OUTPUT_CHARS = 80_000;
/** 目录树单次边界。 */
const MAX_LIST_DEPTH = 4;
const MAX_LIST_ENTRIES = 1000;
/** bash 输出(stdout/stderr 各自)的保留字符数。 */
const MAX_OUTPUT_CHARS = 30_000;
/** bash 默认与最大超时。 */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 600_000;
/** 递归走目录时的深度与结果上限。 */
const MAX_WALK_DEPTH = 15;
const MAX_WALK_RESULTS = 800;
/** 一次遍历最多看多少个目录项 —— 结果上限管不住"走了很久一个都没命中"的情况。 */
const MAX_WALK_VISITS = 200_000;
/** grep 最多扫多少个文件 / 单个文件多大就跳过。 */
const MAX_GREP_FILES = 20_000;
const MAX_GREP_FILE_BYTES = 8 * 1024 * 1024;
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
function resolveAgainstCwd(cwd: string | null, p: string, root: string | null = null): string {
  const trimmed = p.trim();
  if (!trimmed) throw new Error("路径为空");
  let abs: string;
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    abs = path.normalize(trimmed);
  } else {
    if (!cwd) throw new Error(`这个会话没有工作目录,相对路径「${trimmed}」无法解析,请使用绝对路径`);
    abs = path.resolve(cwd, trimmed);
  }
  if (root && !pathWithin(root, abs)) {
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
function sandboxBashWriteDenial(command: string, sandbox: string): string | null {
  for (const raw of extractBashWriteTargets(command)) {
    // 带变量展开的(`$OUT/x`)静态看不准 —— 放行,与 Pi 那边同款取舍(宁可漏,不误杀)。
    if (/\$|\`/.test(raw)) continue;
    const expanded = expandTilde(raw);
    const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(sandbox, expanded);
    if (!pathWithin(sandbox, abs)) {
      return (
        `拒绝:命令要写入「${abs}」,那在允许的目录「${sandbox}」之外。` +
        `公网进来的调用被限制在这个项目目录里,请把输出写到项目内(或用相对路径)。`
      );
    }
  }
  return null;
}

/** 统一的错误包装 —— handler 不抛,失败也走 ToolResult(模型读得懂、能自己改)。 */
async function attempt(run: () => Promise<string>): Promise<ReturnType<typeof text>> {
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
async function attemptStructured(
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

function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

function truncateOutput(s: string, label: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n…[${label} 超过 ${MAX_OUTPUT_CHARS} 字符,已截断]`;
}

/** 远程命令输出的截断:保留**头和尾**。编译/训练/安装的报错几乎都在最后,只留开头
 *  会把真正的错误截掉。 */
function truncateHeadTail(s: string, label: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const head = Math.floor(MAX_OUTPUT_CHARS * 0.4);
  const tail = MAX_OUTPUT_CHARS - head;
  return `${s.slice(0, head)}\n…[${label} 共 ${s.length} 字符,中间 ${s.length - head - tail} 字符已省略]…\n${s.slice(-tail)}`;
}

function clipLine(line: string, max = 2000): string { return line.length > max ? `${line.slice(0, max)}…(行超长已截断)` : line; }

async function readTextRange(abs: string, offset = 1, limit = 2000): Promise<string> {
  return formatTextPage(await readTextPage(abs, { offset, limit }), offset);
}

function formatProcessResult(out: AgentProcessReadResult): string {
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
function processResultStructured(out: AgentProcessReadResult): Record<string, unknown> {
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
const PROCESS_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
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
const REMOTE_JOB_LOG_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
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
const REMOTE_JOB_STATUS_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
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
const REMOTE_EXEC_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  exit_code: z.number().int().nullable().describe("退出码；被信号终止为 null"),
  signal: z.string().nullable().describe("终止信号；正常退出为 null"),
  stdout: z.string().describe("标准输出"),
  stderr: z.string().describe("标准错误"),
};

/** `agent_context` 的返回结构 —— "我在什么环境里、库里有什么"。 */
const AGENT_CONTEXT_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
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

const GLOB_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  count: z.number().int().describe("匹配到的文件总数；0 = 没有匹配（换个模式或起点）"),
  files: z.array(z.string()).describe("路径列表(相对会话工作目录;工作目录外的给绝对路径),最多 500 条"),
  truncated: z.boolean().describe("是否没列全(超过 500 条或目录太大没搜完)"),
  base: z.string().describe("搜索起点目录的绝对路径"),
};

/** `agent_grep` 的返回结构 —— 同 glob 一个道理:模型靠 count 判断找到没有。 */
const GREP_OUTPUT_SCHEMA: Record<string, z.ZodTypeAny> = {
  line_truncated: z.boolean().optional().describe("是否存在只展示命中窗口的长行；与结果条数截断分开"),
  count: z.number().int().describe("匹配到的行数；0 = 没有匹配"),
  matches: z.array(z.string()).describe("匹配行，形如 `相对工作目录的路径:行号: 内容`"),
  scanned_files: z.number().int().describe("实际扫描过的文件数"),
  truncated: z.boolean().describe("是否没搜完(达到 max_results,或文件太多只扫了一部分)"),
};

function formatRemoteConnection(info: RemoteConnectionInfo): string {
  const lines = [
    `connection_id: ${info.connectionId}`,
    `target: ${info.username}@${info.host}:${info.port}`,
    `state: ${info.state}`,
    `reconnect_attempt: ${info.reconnectAttempt}`,
  ];
  if (info.lastError) lines.push(`last_error: ${info.lastError}`);
  if (info.connectedAt) lines.push(`connected_at: ${new Date(info.connectedAt).toISOString()}`);
  return lines.join("\n");
}

function formatRemoteJobStatus(status: RemoteJobStatus): string {
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
function remoteJobStatusStructured(s: RemoteJobStatus): Record<string, unknown> {
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
function formatSearchResult(out: AgentSearchReadResult): string {
  const meta = [
    `search_id: ${out.searchId}`,
    `status: ${out.status}`,
    `offset: ${out.offset}`,
    `next_offset: ${out.nextOffset}`,
    `total_results: ${out.totalResults}`,
    `scanned_files: ${out.scannedFiles}`,
  ];
  if (out.error) meta.push(`error: ${out.error}`);
  const body = out.results.length > 0 ? out.results.map((r, i) => `[${out.offset + i}] ${r}`).join("\n") : "(本页暂无结果)";
  return `${meta.join("\n")}\n--- results ---\n${body}`;
}

async function runCaptured(exe: string, args: string[], timeoutMs = 10_000, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cap = 2 * 1024 * 1024;
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
    child.stdout.on("data", (d: Buffer) => { appendDecoded(outAcc, outDec, d, cap); stdout = outAcc.text; });
    child.stderr.on("data", (d: Buffer) => { appendDecoded(errAcc, errDec, d, cap); stderr = errAcc.text; });
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

interface SystemProcessInfo {
  pid: number;
  ppid?: number;
  name: string;
  memoryBytes?: number;
  command?: string;
}

async function listSystemProcesses(filter?: string, limit = 300): Promise<SystemProcessInfo[]> {
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

async function killSystemProcess(pid: number, force: boolean): Promise<string> {
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

async function fileInfoText(abs: string, countLines: boolean): Promise<string> {
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

function findPythonExecutable(): Promise<string | null> {
  if (!pythonExecutablePromise) {
    pythonExecutablePromise = (async () => {
      for (const exe of process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]) {
        try {
          const out = await runCaptured(exe, ["-c", "import sys;print(sys.executable)"], 4_000);
          if (out.code === 0 && out.stdout.trim()) return exe;
        } catch {
          // try next candidate
        }
      }
      return null;
    })();
  }
  return pythonExecutablePromise;
}

const MAX_DOCUMENT_OUTPUT_CHARS = 100_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function capDocumentOutput(textValue: string, label: string, maxChars = MAX_DOCUMENT_OUTPUT_CHARS): string {
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
const PYTHON_DOCUMENT_ENV = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

async function readRichDocument(input: {
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
      const out = await runCaptured("pandoc", [input.abs, "-t", "gfm"], 60_000);
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
    const out = await runCaptured(py, ["-c", script, input.abs], 60_000, PYTHON_DOCUMENT_ENV);
    if (out.code !== 0) throw new Error(`DOCX 抽取失败:${out.stderr.trim() || `exit ${out.code}`}`);
    return capDocumentOutput(out.stdout.trim() || "(文档没有可抽取文本)", "DOCX 文本", maxChars);
  }

  if ([".xlsx", ".xlsm", ".xltx"].includes(ext)) {
    const py = await findPythonExecutable();
    if (!py) throw new Error("读取 Excel 需要 Python + openpyxl；当前没有可用 Python");
    const script = [
      "import sys,json",
      "try:",
      " from openpyxl import load_workbook",
      "except Exception as e:",
      " print(json.dumps({'error':'缺少 openpyxl: '+str(e)},ensure_ascii=False));sys.exit(2)",
      "p,sheet,rg,maxr,maxc=sys.argv[1],sys.argv[2],sys.argv[3],int(sys.argv[4]),int(sys.argv[5])",
      "wb=load_workbook(p,read_only=True,data_only=False)",
      "ws=wb[sheet] if sheet else wb[wb.sheetnames[0]]",
      "rows=[]",
      "cells=ws[rg] if rg else ws.iter_rows(min_row=1,max_row=min(ws.max_row,maxr),min_col=1,max_col=min(ws.max_column,maxc))",
      "if rg and not isinstance(cells,tuple): cells=((cells,),)",
      "elif rg and cells and not isinstance(cells[0],tuple): cells=(cells,)",
      "for row in cells:",
      " vals=[]",
      " for c in row[:maxc]: vals.append(c.value)",
      " rows.append(vals)",
      " if len(rows)>=maxr: break",
      "print(json.dumps({'sheets':wb.sheetnames,'sheet':ws.title,'rows':rows},ensure_ascii=False,default=str))",
    ].join("\n");
    const out = await runCaptured(py, ["-c", script, input.abs, input.sheet ?? "", input.range ?? "", String(Math.max(1, Math.min(input.maxRows ?? 200, 1000))), String(Math.max(1, Math.min(input.maxCols ?? 50, 200)))], 60_000, PYTHON_DOCUMENT_ENV);
    if (out.code !== 0) throw new Error(`Excel 抽取失败:${out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`}`);
    const parsed = JSON.parse(out.stdout) as { error?: string; sheets?: string[]; sheet?: string; rows?: unknown[][] };
    if (parsed.error) throw new Error(parsed.error);
    const lines = [`sheets: ${(parsed.sheets ?? []).join(", ")}`, `sheet: ${parsed.sheet ?? ""}`];
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
    const out = await runCaptured(py, ["-c", script, input.abs, String(Math.max(1, Math.min(input.maxSlides ?? 200, 1000)))], 60_000, PYTHON_DOCUMENT_ENV);
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

async function readUrlText(url: string, maxChars: number, timeoutMs: number): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`URL 不合法:${url}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http/https URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(timeoutMs, 60_000)));
  try {
    const res = await fetch(parsed, { signal: controller.signal, redirect: "follow" });
    const contentType = res.headers.get("content-type") ?? "";
    const textBody = await res.text();
    const body = capDocumentOutput(textBody, "URL 响应", Math.max(1_000, Math.min(maxChars, 300_000)));
    return `status: ${res.status} ${res.statusText}\nurl: ${res.url}\ncontent-type: ${contentType}\n\n${body}`;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error(`读取 URL 超过 ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────── 目录遍历 ────────────────────────────── */

interface WalkHit {
  abs: string;
  rel: string;
  isDir: boolean;
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
function appendDecoded(
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
function newDecoder(): ConsoleTextDecoder {
  // 不只是扛跨块的半个字符:中文 Windows 上 cmd 的输出是 GBK,见 ConsoleTextDecoder。
  return new ConsoleTextDecoder();
}

interface WalkOptions {
  canRead?: (absolutePath: string) => boolean;
  /** 只收**文件名**匹配的(grep 的 `glob` 参数,如 `*.md`)。 */
  nameFilter?: RegExp | null;
  /** 只收**相对 root 的路径**(正斜杠)匹配的(agent_glob)。 */
  relFilter?: RegExp | null;
  /** 进不进 `.` 开头的目录/文件。默认不进(同 ripgrep)。 */
  includeHidden?: boolean;
  /** 命中多少个就停,默认 {@link MAX_WALK_RESULTS}。 */
  maxHits?: number;
}

/**
 * 从 `root` 往下递归收集文件,跳过 {@link SKIP_DIRS}、隐藏项(除非 includeHidden)与超深分支。
 *
 * ⚠️ **过滤必须在遍历里做,上限只数命中的。** 从前是先收前 800 个文件、再在外面按模式
 * 过滤 —— 项目根下随便一个缓存目录就把 800 个名额占满,`**\/foo.ts` 明明存在也回
 * "没有匹配",grep 也只扫了前 800 个文件就说没找到(而且都不说自己没搜完)。
 * 现在命中数和访问数各有上限,撞上了就如实报 `truncated`。
 */
async function walkFiles(root: string, opts: WalkOptions = {}): Promise<{ hits: WalkHit[]; truncated: boolean }> {
  const hits: WalkHit[] = [];
  const maxHits = opts.maxHits ?? MAX_WALK_RESULTS;
  let visited = 0;
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > MAX_WALK_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限 / 已被删 —— 跳过,不炸整次遍历
    }
    for (const entry of entries) {
      if (hits.length >= maxHits || visited >= MAX_WALK_VISITS) {
        truncated = true;
        return;
      }
      visited += 1;
      if (!opts.includeHidden && entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (opts.canRead && !opts.canRead(abs)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs, depth + 1);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (opts.nameFilter && !opts.nameFilter.test(entry.name)) continue;
      const rel = path.relative(root, abs);
      if (opts.relFilter && !opts.relFilter.test(rel.replace(/\\/g, "/"))) continue;
      hits.push({ abs, rel, isDir: false });
    }
  };
  await walk(root, 0);
  return { hits, truncated };
}

/** glob 里不带通配符的前导目录段(`src/main/*.ts` → `src/main`),用来把遍历起点挪进去。 */
function splitGlobPrefix(pattern: string): { prefix: string; rest: string } {
  const segs = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  let i = 0;
  while (i < segs.length - 1 && segs[i] !== "" && !/[*?[\]{}]/.test(segs[i]!)) i += 1;
  return { prefix: segs.slice(0, i).join("/"), rest: segs.slice(i).join("/") };
}

/** 模式里明确写了 `.` 开头的段(`.github/**`、`.env`)就说明要看隐藏项。 */
function globWantsHidden(pattern: string): boolean {
  return pattern
    .replace(/\\/g, "/")
    .split("/")
    .some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 一个够用的 glob → RegExp:支持 `**`(跨段)、`*`/`?`(段内),`/` 统一成正斜杠。
 * 不追求完整 glob 语义 —— 模型用的是"找某个名字的文件"这类粗模式,这里覆盖的就是它。
 */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // `**/` 或段内 `**` 都按"跨任意层级"处理
        i += 2;
        if (normalized[i] === "/") i += 1;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${re}$`, "i");
}

/* ────────────────────────────── 工具表 ────────────────────────────── */

/**
 * agent 工具的**进程级单例**资源(见 `agentSessionCleanup.ts` 的文件头)。
 *
 * 建在模块作用域:工具表会被反复现取(见 `agentMcpTools` 里的说明),资源不能跟着每次取
 * 重建 —— 否则同一个 `proc_...` 句柄在后一次取的表里查不到,而登记的释放函数还只涨不落。
 * 登记也只在模块加载时做一次。
 */
const agentProcesses = createAgentProcessSessions();
const agentSearches = createAgentSearchSessions();
const agentRemoteSsh = createAgentRemoteSshManager();
// Deleting a conversation releases what its agent tools still hold (see
// agentSessionCleanup.ts — OBS-M14-01: SSH otherwise auto-reconnects forever).
registerAgentSessionDisposer((sessionId) => {
  agentProcesses.disposeOwner(sessionId);
  agentSearches.disposeOwner(sessionId);
  agentRemoteSsh.disposeOwner(sessionId);
});
// 应用退出时杀掉还在跑的后台进程,否则它们比 Mcode 活得久(端口一直被占)。
registerAgentShutdownHook(() => agentProcesses.disposeAll());

export function agentMcpTools(deps: AgentToolsDeps): McpToolSpec[] {
  /** 每个工具共用的前置:解析 cwd。失败统一转 fail 文本。 */
  const cwdOf = (ctx: McpToolContext): string | null => deps.cwdFor(ctx.sessionId);
  /** 这个会话的沙箱根(null = 不限制,桌面本机那条路)。 */
  const sandboxOf = (ctx: McpToolContext): string | null => deps.sandboxRootFor?.(ctx.sessionId) ?? null;
  /**
   * 搜索结果里给模型看的路径:在工作目录(有沙箱就是沙箱)里面就给相对它的正斜杠路径 ——
   * 和相对路径的解析基准是同一个,拿去 agent_read_file 直接能用;在外面就给绝对路径。
   */
  const shownPath = (ctx: McpToolContext, abs: string): string => {
    const base = sandboxOf(ctx) ?? cwdOf(ctx);
    if (base && pathWithin(base, abs)) return path.relative(base, abs).replace(/\\/g, "/") || ".";
    return abs;
  };
  /**
   * **文件工具**的路径解析入口 —— cwd 与沙箱根一起带上,走同一次越界判定。
   *
   * 单独包一层是为了"只有一份":20 个文件工具都调它,规矩只写在
   * {@link resolveAgainstCwd} 里一处。`agent_bash` / `agent_process_start` **故意不用它**
   * —— 它们的 cwd 是"命令在哪跑",不是"能碰哪个文件";而且用户明确要求不限制 bash
   * (见 {@link resolveAgainstCwd} 那段)。
   */
  /**
   * 文件工具的路径解析入口。
   *
   * ⚠️ **相对路径的基准是「沙箱根」,不是 `cwdFor` 的缓存。**
   *
   * 这里原来传的是 `cwdOf(ctx)` —— 它优先返回运行时的 `lastCwd`(跟着 `cd` 走、会话
   * 在哪儿 cd 过就永久停在那儿),而**校验用的是沙箱**。两者对不上时的后果很实在:
   * 用户说"读一下 note.md" → 解析成 `<缓存目录>\note.md` → **不在沙箱里 → 一律拒绝**,
   * 于是**所有相对路径都读不了**(用户报的"列目录失败"就是这个形状)。
   *
   * 有沙箱时(公网那条路)就以沙箱为基准 —— 那是用户**明确选过**的目录,也是"当前项目"
   * 该有的含义。没有沙箱(桌面本机会话)时退回 `cwdFor`,那条路行为不变。
   */
  const pOf = (ctx: McpToolContext, p: string): string => {
    const sandbox = sandboxOf(ctx);
    const abs = resolveAgainstCwd(sandbox ?? cwdOf(ctx), p, sandbox);
    if (ctx.audience === "public") {
      const denial = publicSkillReadDenial(sandbox, abs);
      if (denial) throw new Error(denial);
    }
    return abs;
  };
  /**
   * **只读**文件工具的路径解析入口:沙箱内照旧;沙箱外再问一次 `sandboxReadCheck`
   * (资料库 / 技能库只读可达,守屏蔽规则)。写工具一律还走 {@link pOf}。
   */
  const pOfRead = (ctx: McpToolContext, p: string, kind: SandboxReadKind): string => {
    const sandbox = sandboxOf(ctx);
    const abs = resolveAgainstCwd(sandbox ?? cwdOf(ctx), p, null);
    if (ctx.audience === "public") {
      const denial = publicSkillReadDenial(sandbox, abs);
      if (denial) throw new Error(denial);
    }
    if (!sandbox) return abs;
    if (pathWithin(sandbox, abs)) return abs;
    const verdict = deps.sandboxReadCheck?.(abs, kind);
    if (verdict === null) return abs;
    if (typeof verdict === "string") throw new Error(verdict);
    return resolveAgainstCwd(sandbox, p, sandbox);
  };
  const canRead = (ctx: McpToolContext) => (abs: string): boolean => {
    if (ctx.audience !== "public") return true;
    try { pOfRead(ctx, abs, "read"); return true; } catch { return false; }
  };
  // ⚠️ 这三张管理器是**进程级单例**(见 agentSessionCleanup.ts 与文件头)—— 必须建在
  // 模块作用域,不能建在函数体里。这个函数每个「取表」的地方都会调(桥的 specs()
  // 每轮 sendTurn、每次工具调用现取;webToolHost 每条链接建一次),建在里面就等于
  // 每次调用都新建三张空表**再登记一条释放函数**:进程 / 搜索 / SSH 的持有者随调用
  // 次数线性增长,而登记的 set 只涨不落(没有调用方会去注销)。同时那也让
  // `agent_process_start` 与后来的 `agent_process_read` 各自看见一张空表 —— 同一个
  // 进程号在后一次调用里根本查不到。
  return [
    {
      name: "agent_read_file",
      description:
        "分页读取 UTF-8 文本，默认正文最多 30000 字符。structuredContent.content 是无损正文；text 是带行号预览，不能原样写回。" +
        "has_more 时按 next_offset/next_column_offset 续读并带 expected_sha256；长行也能读全。版本变化会拒绝。",
      inputSchema: {
        path: z.string().min(1).describe("文件路径，相对会话目录"),
        offset: z.number().int().min(1).optional().describe("起始行，默认 1"),
        limit: z.number().int().min(1).max(5000).optional().describe("最多行数，默认 2000"),
        column_offset: z.number().int().min(0).optional().describe("起始行内 UTF-16 字符偏移，默认 0；续读使用返回值"),
        max_chars: z.number().int().min(1000).max(60000).optional().describe("正文字符预算，默认 30000；元数据和行号另计"),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("上次读取的 sha256；防止跨版本拼接"),
      },
      handler: (args: TextPageOptions & { path: string }, ctx) =>
        attemptStructured(async () => {
          const page = await readTextPage(pOfRead(ctx, args.path, "read"), args);
          return { text: formatTextPage(page, args.offset ?? 1, args.column_offset ?? 0), structured: { ...page } };
        }),
      outputSchema: {
        path: z.string().optional(), content: z.string().optional(), sha256: z.string().optional(),
        total_lines: z.number().optional(), size_bytes: z.number().optional(), returned_chars: z.number().optional(),
        has_more: z.boolean().optional(), truncated: z.boolean().optional(),
        next_offset: z.number().optional(), next_column_offset: z.number().optional(),
      },
    },

    {
      name: "agent_read_files",
      description:
        "一次读取多个本地文本文件，减少一文件一调用的往返。单个文件失败不会拖垮整批；" +
        "每个文件带行号，默认最多 400 行，总输出有硬上限。",
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_BATCH_READ_FILES)
          .describe(`文件路径列表,最多 ${MAX_BATCH_READ_FILES} 个`),
        offset: z.number().int().min(1).optional().describe("所有文件共同的起始行号,默认 1"),
        limit_per_file: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("每个文件最多读取多少行,默认 400"),
      },
      handler: (args: { paths: string[]; offset?: number; limit_per_file?: number }, ctx) =>
        attempt(async () => {
          const sections: string[] = [];
          let used = 0;
          let omitted = 0;
          for (const requested of args.paths) {
            let body: string;
            try {
              const abs = pOfRead(ctx, requested, "read");
              body = await readTextRange(abs, args.offset ?? 1, args.limit_per_file ?? 400);
            } catch (err) {
              body = `失败:${err instanceof Error ? err.message : String(err)}`;
            }
            const section = `===== ${requested} =====\n${body}`;
            const separatorCost = sections.length > 0 ? 2 : 0;
            const remaining = MAX_BATCH_OUTPUT_CHARS - used - separatorCost;
            if (remaining <= 0) {
              omitted = args.paths.length - sections.length;
              break;
            }
            if (section.length > remaining) {
              const marker = "\n…(这个文件的批量预览达到总输出上限,已截断)";
              sections.push(`${section.slice(0, Math.max(0, remaining - marker.length))}${marker}`);
              omitted = args.paths.length - sections.length;
              used = MAX_BATCH_OUTPUT_CHARS;
              break;
            }
            sections.push(section);
            used += section.length + separatorCost;
          }
          const tail = omitted > 0
            ? `\n\n…(批量输出达到 ${MAX_BATCH_OUTPUT_CHARS} 字符上限,还有 ${omitted} 个文件未展开;请拆成下一批)`
            : "";
          return `${sections.join("\n\n")}${tail}`;
        }),
    },

    {
      name: "agent_read_document",
      description:
        "读取 PDF / DOCX / XLSX / PPTX 为模型可直接使用的文本。PDF 走内置 pdfjs；DOCX 优先 pandoc；" +
        "Excel/PowerPoint 使用本机 Python 文档工具链。Excel 支持 sheet/range，输出有硬上限。",
      inputSchema: {
        path: z.string().min(1).describe("文档路径"),
        sheet: z.string().optional().describe("Excel 工作表名；省略取第一张"),
        range: z.string().optional().describe("Excel 范围，如 A1:D50；省略从左上角读取"),
        max_pages: z.number().int().min(1).max(500).optional().describe("PDF 最多解析页数，默认 200"),
        max_slides: z.number().int().min(1).max(1000).optional().describe("PPTX 最多解析页数，默认 200"),
        max_rows: z.number().int().min(1).max(1000).optional().describe("Excel 最多返回行数，默认 200"),
        max_cols: z.number().int().min(1).max(200).optional().describe("Excel 最多返回列数，默认 50"),
        max_chars: z.number().int().min(100).max(300000).optional().describe("最多返回字符数，默认 100000"),
      },
      handler: (args: {
        path: string;
        sheet?: string;
        range?: string;
        max_pages?: number;
        max_slides?: number;
        max_rows?: number;
        max_cols?: number;
        max_chars?: number;
      }, ctx) =>
        attempt(async () => readRichDocument({
          abs: pOfRead(ctx, args.path, "read"),
          sheet: args.sheet,
          range: args.range,
          maxPages: args.max_pages,
          maxSlides: args.max_slides,
          maxRows: args.max_rows,
          maxCols: args.max_cols,
          maxChars: args.max_chars,
        })),
    },

    {
      name: "agent_read_image",
      description:
        "读取本地 PNG/JPEG/GIF/WebP，并按 MCP 标准 image content block 返回给支持视觉输入的客户端/模型。" +
        "最大 8MB；相对路径按会话工作目录解析。",
      inputSchema: {
        path: z.string().min(1).describe("图片路径（PNG/JPEG/GIF/WebP）"),
      },
      handler: async (args: { path: string }, ctx) => {
        try {
          const abs = pOfRead(ctx, args.path, "read");
          const ext = path.extname(abs).toLowerCase();
          const mime = ({
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
          } as Record<string, string>)[ext];
          if (!mime) return fail("只支持 PNG/JPEG/GIF/WebP 图片");
          const st = await fs.stat(abs).catch(() => null);
          if (!st?.isFile()) return fail(`图片不存在:${abs}`);
          if (st.size > MAX_IMAGE_BYTES) {
            return fail(`图片 ${st.size} B 超过 ${MAX_IMAGE_BYTES} B 上限`);
          }
          const data = await fs.readFile(abs);
          return image(data.toString("base64"), mime, `[image ${path.basename(abs)} ${st.size} B]`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    {
      name: "agent_read_docx_xml",
      description:
        "读取 DOCX 内部 OOXML 的 pretty XML（正文/页眉/页脚），带行号和 offset/limit。" +
        "用于随后 agent_edit_docx_xml 做精确结构化修改；普通读正文优先 agent_read_document。",
      inputSchema: {
        path: z.string().min(1).describe("DOCX 路径"),
        part: z
          .string()
          .optional()
          .describe("word/document.xml、word/headerN.xml、word/footerN.xml；默认正文"),
        offset: z.number().int().min(1).optional().describe("起始 XML 行号，从 1 起"),
        limit: z.number().int().min(1).max(5000).optional().describe("最多返回 XML 行数，默认 400"),
      },
      handler: (args: { path: string; part?: string; offset?: number; limit?: number }, ctx) =>
        attempt(async () => readDocxXml({
          path: pOfRead(ctx, args.path, "read"),
          part: args.part,
          offset: args.offset,
          limit: args.limit,
        })),
    },

    {
      name: "agent_read_url",
      description:
        "直接读取 http/https URL 的文本响应，返回状态码、最终 URL、Content-Type 和正文。" +
        "适合配置、日志、文档或本地开发服务；二进制资源请使用更合适的工具。",
      inputSchema: {
        url: z.string().min(1).describe("http/https URL"),
        max_chars: z.number().int().min(100).max(300000).optional().describe("正文最多字符数，默认 100000"),
        timeout_ms: z.number().int().min(1000).max(60000).optional().describe("超时毫秒数，默认 15000"),
      },
      handler: (args: { url: string; max_chars?: number; timeout_ms?: number }) =>
        attempt(async () => readUrlText(args.url, args.max_chars ?? 100_000, args.timeout_ms ?? 15_000)),
    },

    {
      name: "agent_write_file",
      description:
        "把 UTF-8 文本写入本地文件(整体覆盖;append=true 则追加到末尾)。" +
        "父目录不存在会自动创建。改已有文件优先用 agent_edit_file(只动需要改的那几处)。",
      inputSchema: {
        path: z.string().min(1).describe("目标文件路径"),
        content: z.string().describe("要写入的完整内容"),
        append: z.boolean().optional().describe("true = 追加到文件末尾而不是覆盖,默认覆盖"),
      },
      handler: (args: { path: string; content: string; append?: boolean }, ctx) =>
        attempt(async () => {
          const abs = pOf(ctx, args.path);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await withTextFileLock(abs, (real) => fs.writeFile(real, args.content, { flag: args.append ? "a" : "w" }));
          return `已${args.append ? "追加" : "写入"} ${abs}(${args.content.length} 字符)`;
        }),
    },

    {
      name: "agent_create_directory",
      description:
        "创建目录（可一次创建多层父目录）；目录已经存在时也算成功。属于文件系统修改操作。",
      inputSchema: {
        path: z.string().min(1).describe("要创建的目录路径"),
      },
      handler: (args: { path: string }, ctx) =>
        attempt(async () => {
          const abs = pOf(ctx, args.path);
          await fs.mkdir(abs, { recursive: true });
          return `目录已就绪:${abs}`;
        }),
    },

    {
      name: "agent_write_pdf",
      description:
        "创建或修改 PDF。创建:传 output_path + markdown；修改:传 source_path + operations + output_path。" +
        "修改支持按 0-based page index 删除页面，或插入 markdown/另一个 PDF；永远要求新输出文件，不覆盖原 PDF。",
      inputSchema: {
        output_path: z.string().min(1).describe("新的 PDF 输出路径；不能已存在，也不能与源 PDF 相同"),
        markdown: z.string().optional().describe("创建新 PDF 时的 Markdown/HTML 内容"),
        source_path: z.string().optional().describe("修改已有 PDF 时的源文件"),
        operations: z
          .array(z.object({
            type: z.enum(["delete", "insert"]),
            page_indexes: z.array(z.number().int().min(0)).max(1000).optional(),
            page_index: z.number().int().min(0).optional(),
            markdown: z.string().optional(),
            source_pdf_path: z.string().optional(),
          }))
          .max(100)
          .optional()
          .describe("顺序执行的页面操作；delete 用 page_indexes，insert 用 page_index + markdown/source_pdf_path"),
      },
      handler: (args: {
        output_path: string;
        markdown?: string;
        source_path?: string;
        operations?: Array<{
          type: "delete" | "insert";
          page_indexes?: number[];
          page_index?: number;
          markdown?: string;
          source_pdf_path?: string;
        }>;
      }, ctx) =>
        attempt(async () => {
          // ⚠️ **相对路径的基准必须是沙箱根,不是 `cwdOf`** —— 与 `pOf` 同款。
          //
          // 这里原来写的是 `resolveAgainstCwd(cwdOf(ctx), rel, sandbox)`:用**过期的
          // lastCwd** 解析、却按**沙箱**校验 → 公网会话里每一个相对路径都被判越界,
          // 也就是"agent_write_pdf 永远用不了"(2026-09-24 审查发现,它是 pOf 之外
          // 唯一漏改的一处)。
          const p = (rel: string): string => pOf(ctx, rel);
          const operations: AgentPdfOperation[] | undefined = args.operations?.map((op) => {
            if (op.type === "delete") {
              if (!op.page_indexes) throw new Error("PDF delete 操作缺少 page_indexes");
              return { type: "delete", pageIndexes: op.page_indexes };
            }
            if (op.page_index === undefined) throw new Error("PDF insert 操作缺少 page_index");
            return {
              type: "insert",
              pageIndex: op.page_index,
              ...(op.markdown !== undefined ? { markdown: op.markdown } : {}),
              ...(op.source_pdf_path ? { sourcePdfPath: p(op.source_pdf_path) } : {}),
            };
          });
          const out = await writePdf({
            outputPath: p(args.output_path),
            ...(args.markdown !== undefined ? { markdown: args.markdown } : {}),
            ...(args.source_path ? { sourcePath: p(args.source_path) } : {}),
            ...(operations ? { operations } : {}),
          });
          return `PDF 已生成:${out.outputPath} (${out.pageCount} 页)`;
        }),
    },

    {
      name: "agent_edit_excel_range",
      description:
        "精确写入 Excel 的矩形 Range，语义对齐 edit_block range 模式。range 必须写成 `Sheet!A1:C10`，" +
        "content 必须是尺寸完全一致的二维数组；写入采用临时文件替换，避免半写状态。",
      inputSchema: {
        path: z.string().min(1).describe(".xlsx/.xlsm 文件路径"),
        range: z.string().min(3).describe("目标范围，如 Sheet1!A1:C3"),
        content: z
          .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
          .min(1)
          .max(1000)
          .describe("二维数组；行列尺寸必须与 range 完全一致"),
      },
      handler: (args: { path: string; range: string; content: Array<Array<string | number | boolean | null>> }, ctx) =>
        attempt(async () => {
          const out = await editExcelRange({
            path: pOf(ctx, args.path),
            range: args.range,
            content: args.content,
          });
          return `Excel 已更新:${out.path} ${out.sheet}!${out.range} (${out.cells} cells)`;
        }),
    },

    {
      name: "agent_edit_docx_xml",
      description:
        "对 DOCX 内部 pretty-printed OOXML 做精确 find/replace，并重新打包为合法 DOCX。" +
        "先用 agent_read_docx_xml 复制准确 XML 片段；默认要求 old_string 恰好出现 1 次，可用 expected_replacements 指定精确次数。",
      inputSchema: {
        path: z.string().min(1).describe("DOCX 路径"),
        old_string: z.string().min(1).describe("从 agent_read_docx_xml 复制的精确 XML 片段"),
        new_string: z.string().describe("替换后的 XML 片段"),
        expected_replacements: z.number().int().min(1).max(1000).optional().describe("期望匹配次数，默认 1"),
        part: z
          .string()
          .optional()
          .describe("可限定 word/document.xml/headerN/footerN；省略会搜索正文、页眉和页脚"),
      },
      handler: (args: {
        path: string;
        old_string: string;
        new_string: string;
        expected_replacements?: number;
        part?: string;
      }, ctx) =>
        attempt(async () => {
          const out = await editDocxXml({
            path: pOf(ctx, args.path),
            oldString: args.old_string,
            newString: args.new_string,
            expectedReplacements: args.expected_replacements,
            part: args.part,
          });
          return `DOCX 已修改:${out.path}；替换 ${out.replacements} 处；part=${out.parts.join(",") || "(无)"}`;
        }),
    },

    {
      name: "agent_edit_file",
      description:
        "对本地文本文件做精确替换:old_string 必须与文件内容逐字一致(换行符 LF/CRLF 自动适配)。" +
        "同一处出现多次时会拒绝(除非 replace_all=true);建议先用 agent_read_file 拿到原文再改。" +
        "一次改多处传 edits 数组(按顺序替换,任何一处对不上就整次不写入)。同路径修改串行；可带读取时的 expected_sha256 拒绝过时编辑。",
      inputSchema: {
        path: z.string().min(1).describe("目标文件路径"),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("读取时的 sha256；变化则不写入"),
        old_string: z.string().min(1).optional().describe("要被替换的原文(逐字一致);用 edits 时省略"),
        new_string: z.string().optional().describe("替换后的内容;用 edits 时省略"),
        replace_all: z.boolean().optional().describe("原文出现多次时全部替换,默认只允许恰好一处"),
        edits: z
          .array(
            z.object({
              old_string: z.string().min(1).describe("要被替换的原文(逐字一致)"),
              new_string: z.string().describe("替换后的内容"),
              replace_all: z.boolean().optional().describe("这一处出现多次时全部替换"),
            }),
          )
          .min(1)
          .max(50)
          .optional()
          .describe("一次改多处:按顺序依次替换(后一处看到的是前一处改完的内容)"),
      },
      handler: (
        args: {
          path: string;
          expected_sha256?: string;
          old_string?: string;
          new_string?: string;
          replace_all?: boolean;
          edits?: { old_string: string; new_string: string; replace_all?: boolean }[];
        },
        ctx,
      ) =>
        attempt(async () => {
          const target = pOf(ctx, args.path);
          return withTextFileLock(target, async (abs) => {
          // 失败一律**抛**(→ isError),不是回一句普通文本:从前"没找到 old_string"回的是成功
          // 结果,模型很容易当成改好了接着往下走。
          const edits =
            args.edits ??
            (args.old_string !== undefined && args.new_string !== undefined
              ? [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }]
              : null);
          if (!edits) throw new Error("要么给 old_string + new_string,要么给 edits 数组");
          const st = await fs.stat(abs).catch(() => null);
          if (!st || !st.isFile()) throw new Error(`文件不存在:${abs}`);
          const buf = await fs.readFile(abs);
          if (args.expected_sha256 && textFileHash(buf) !== args.expected_sha256.toLowerCase()) throw new Error("文件版本已变化，本次不写入；请重新读取 / File version changed");
          if (isBinary(buf)) throw new Error(`看起来是二进制文件,改不了:${abs}`);
          let content = buf.toString("utf-8");
          const crlf = content.includes("\r\n");
          const touched: number[] = [];
          let replaced = 0;
          edits.forEach((edit, k) => {
            const which = edits.length > 1 ? `第 ${k + 1} 处 edit:` : "";
            let oldStr = edit.old_string;
            let newStr = edit.new_string;
            // Normalize replacement line endings even when old_string is a single line.
            const newline = crlf ? "\r\n" : "\n";
            if (!content.includes(oldStr)) oldStr = oldStr.replace(/\r?\n/g, newline);
            newStr = newStr.replace(/\r?\n/g, newline);
            const first = content.indexOf(oldStr);
            if (first < 0) {
              throw new Error(`${which}没找到 old_string —— 内容必须逐字一致(含空格缩进),先用 agent_read_file 确认原文;这次没有写入任何改动`);
            }
            const count = content.split(oldStr).length - 1;
            if (count > 1 && !edit.replace_all) {
              throw new Error(
                `${which}old_string 在文件里出现 ${count} 次;请扩大上下文让匹配唯一,或传 replace_all=true;这次没有写入任何改动`,
              );
            }
            touched.push(content.slice(0, first).split("\n").length);
            content = edit.replace_all
              ? content.split(oldStr).join(newStr)
              : content.slice(0, first) + newStr + content.slice(first + oldStr.length);
            replaced += edit.replace_all ? count : 1;
          });
          await replaceTextFile(abs, content, buf);
          const lines = [...new Set(touched)].sort((x, y) => x - y).join("、");
          return `已修改 ${abs}:替换 ${replaced} 处(起始于第 ${lines} 行)`;
          });
        }),
    },

    {
      name: "agent_file_info",
      description:
        "读取文件/目录元数据：类型、大小、创建/修改时间、权限；文本文件可顺带统计行数和追加位置。",
      inputSchema: {
        path: z.string().min(1).describe("文件或目录路径"),
        count_lines: z.boolean().optional().describe("文本文件是否统计行数，默认 true；超大文件不需要时可关掉"),
      },
      handler: (args: { path: string; count_lines?: boolean }, ctx) =>
        attempt(async () => fileInfoText(pOfRead(ctx, args.path, "read"), args.count_lines ?? true)),
    },

    {
      name: "agent_move_file",
      description:
        "移动或重命名文件/目录。默认不覆盖已有目标；overwrite=true 才会先移除目标。属于文件修改操作。",
      inputSchema: {
        source: z.string().min(1).describe("原路径"),
        destination: z.string().min(1).describe("目标路径"),
        overwrite: z.boolean().optional().describe("目标已存在时是否覆盖，默认 false"),
      },
      handler: (args: { source: string; destination: string; overwrite?: boolean }, ctx) =>
        attempt(async () => {
          const source = pOf(ctx, args.source);
          const destination = pOf(ctx, args.destination);
          const src = await fs.lstat(source).catch(() => null);
          if (!src) throw new Error(`原路径不存在:${source}`);
          const dest = await fs.lstat(destination).catch(() => null);
          if (dest && !args.overwrite) throw new Error(`目标已存在:${destination}；确认覆盖时传 overwrite=true`);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          if (dest) await fs.rm(destination, { recursive: true, force: true });
          try {
            await fs.rename(source, destination);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
            await fs.cp(source, destination, { recursive: true, force: true });
            await fs.rm(source, { recursive: true, force: true });
          }
          return `已移动 ${source} -> ${destination}`;
        }),
    },

    {
      name: "agent_list_dir",
      description:
        "列目录树。depth=1 只列直接子项；需要快速了解项目结构时可调到 2~4 层，" +
        "会跳过 .git/node_modules 等巨型目录的继续递归。",
      inputSchema: {
        path: z.string().optional().describe("目录路径,默认会话工作目录"),
        depth: z.number().int().min(1).max(MAX_LIST_DEPTH).optional().describe("递归深度,默认 1,最大 4"),
        max_entries: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_ENTRIES)
          .optional()
          .describe("最多返回多少项,默认 500,最大 1000"),
      },
      handler: (args: { path?: string; depth?: number; max_entries?: number }, ctx) =>
        attempt(async () => {
          const abs = pOfRead(ctx, args.path ?? ".", "list");
          const depth = args.depth ?? 1;
          const cap = args.max_entries ?? 500;
          const rootStat = await fs.stat(abs).catch(() => null);
          if (!rootStat) return `目录不存在:${abs}`;
          if (!rootStat.isDirectory()) return `这不是目录:${abs}`;

          const lines: string[] = [];
          let count = 0;
          let truncated = false;
          const visit = async (dir: string, level: number): Promise<void> => {
            if (count >= cap) {
              truncated = true;
              return;
            }
            const entries = await fs.readdir(dir, { withFileTypes: true });
            entries.sort((a, b) => {
              const ad = a.isDirectory() ? 0 : 1;
              const bd = b.isDirectory() ? 0 : 1;
              return ad - bd || a.name.localeCompare(b.name);
            });
            for (const e of entries) {
              if (count >= cap) {
                truncated = true;
                return;
              }
              const child = path.join(dir, e.name);
              if (!canRead(ctx)(child)) continue;
              const rel = path.relative(abs, child).replace(/\\/g, "/");
              const indent = "  ".repeat(Math.max(0, level - 1));
              if (e.isDirectory()) {
                lines.push(`${indent}- ${rel}/`);
                count += 1;
                if (level < depth && !SKIP_DIRS.has(e.name)) await visit(child, level + 1);
                continue;
              }
              if (e.isSymbolicLink()) {
                lines.push(`${indent}- ${rel} @`);
                count += 1;
                continue;
              }
              const size = await fs.stat(child).then((st) => st.size).catch(() => 0);
              lines.push(`${indent}- ${rel} (${size} B)`);
              count += 1;
            }
          };
          await visit(abs, 1);
          const note = truncated ? `\n…(达到 ${cap} 项上限,请收窄路径/深度)` : "";
          return `[${abs} depth=${depth}]\n${lines.join("\n") || "(空目录)"}${note}`;
        }),
    },

    {
      name: "agent_glob",
      description:
        "按 glob 模式找文件(如 `**/*.pdf`、`src/**/*.ts`、`notes/*.md`),只搜文件名不搜内容。" +
        "`*` 不跨目录,递归要写 `**/`。默认跳过 . 开头的隐藏项和 node_modules/.git/dist 等目录。" +
        "返回的路径相对会话工作目录,可直接交给 agent_read_file。",
      inputSchema: {
        pattern: z.string().min(1).describe("glob 模式,支持 **、*、?;相对 path(默认工作目录)"),
        path: z.string().optional().describe("搜索起点目录,默认会话工作目录"),
        include_hidden: z.boolean().optional().describe("是否包含 . 开头的隐藏目录/文件,默认 false(模式里写了 .xxx 段时自动包含)"),
      },
      handler: (args: { pattern: string; path?: string; include_hidden?: boolean }, ctx) =>
        attemptStructured(async () => {
          // 模式里不带通配符的前导目录直接并进起点:`mcode/apps/src/*.ts` 不必从项目根走一遍。
          const { prefix, rest } = splitGlobPrefix(args.pattern);
          const startRel = prefix ? path.join(args.path ?? ".", prefix) : (args.path ?? ".");
          const base = pOfRead(ctx, startRel, "list");
          const st = await fs.stat(base).catch(() => null);
          const re = globToRegExp(rest);
          const found =
            st?.isDirectory()
              ? await walkFiles(base, {
                canRead: canRead(ctx),
                  relFilter: re,
                  includeHidden: args.include_hidden ?? globWantsHidden(args.pattern),
                  maxHits: 2000,
                })
              : { hits: [] as WalkHit[], truncated: false };
          const rels = found.hits.map((h) => shownPath(ctx, h.abs));
          if (rels.length === 0) {
            const hint = !args.pattern.includes("/") && !args.pattern.includes("**")
              ? `;\`*\` 不跨目录,要递归找请用 \`**/${args.pattern}\``
              : "";
            return {
              text: `没有匹配「${args.pattern}」的文件(从 ${base} 搜起${found.truncated ? ",目录太大没搜完,请缩小起点" : ""})${hint}`,
              // 空结果也要给结构化 —— 模型靠 `count === 0` 判断"真没有,换个模式"，
              // 而不是从人话里读"没有匹配"。
              structured: { count: 0, files: [], truncated: found.truncated, base },
            };
          }
          const shown = rels.slice(0, 500);
          const truncated = found.truncated || rels.length > 500;
          const tail = truncated
            ? `\n…(${found.truncated ? `至少 ${rels.length} 个` : `共 ${rels.length} 个`},只列前 ${shown.length} 个,请收窄模式或起点)`
            : "";
          return {
            text: `匹配 ${found.truncated ? "≥" : ""}${rels.length} 个:\n${shown.map((r) => `- ${r}`).join("\n")}${tail}`,
            structured: { count: rels.length, files: shown, truncated, base },
          };
        }),
      outputSchema: GLOB_OUTPUT_SCHEMA,
    },

    {
      name: "agent_grep",
      description:
        "在文件内容里搜索(类似 ripgrep),跳过隐藏项、.git/node_modules 等目录与二进制文件。" +
        "返回「路径:行号: 该行内容」,路径相对会话工作目录。pattern 默认是 JavaScript 正则(不区分大小写);" +
        "搜代码里的括号、点号等原文时传 literal=true。大目录分页搜用 agent_search_start。",
      inputSchema: {
        pattern: z.string().min(1).describe("正则表达式(JavaScript 语法);literal=true 时按原文"),
        path: z.string().optional().describe("搜索的文件或目录,默认会话工作目录"),
        glob: z.string().optional().describe("只搜文件名匹配这个 glob 的文件,如 *.md、*.ts"),
        literal: z.boolean().optional().describe("按原文(字面量)搜索,默认 false"),
        ignore_case: z.boolean().optional().describe("忽略大小写,默认 true"),
        include_hidden: z.boolean().optional().describe("是否搜 . 开头的隐藏目录/文件,默认 false"),
        max_results: z.number().int().min(1).max(500).optional().describe("最多返回的匹配行数,默认 100"),
      },
      handler: (
        args: {
          pattern: string;
          path?: string;
          glob?: string;
          literal?: boolean;
          ignore_case?: boolean;
          include_hidden?: boolean;
          max_results?: number;
        },
        ctx,
      ) =>
        attemptStructured(async () => {
          const base = pOfRead(ctx, args.path ?? ".", "search");
          const flags = args.ignore_case === false ? "" : "i";
          let re: RegExp;
          let note = "";
          if (args.literal) {
            re = new RegExp(escapeRegExp(args.pattern), flags);
          } else {
            try {
              re = new RegExp(args.pattern, flags);
            } catch {
              // 模型最常见的失手:想搜 `foo(` 却忘了转义。直接按原文搜,比回一句错误再来一轮省事。
              re = new RegExp(escapeRegExp(args.pattern), flags);
              note = "(pattern 不是合法正则,已按原文搜索)\n";
            }
          }
          const include = args.glob ? globToRegExp(args.glob) : null;

          const st = await fs.stat(base).catch(() => null);
          if (!st) throw new Error(`路径不存在:${base}`);
          const walked = st.isFile()
            ? { hits: [{ abs: base, rel: path.basename(base), isDir: false }], truncated: false }
            : await walkFiles(base, {
                canRead: canRead(ctx),
                nameFilter: include,
                includeHidden: args.include_hidden ?? false,
                maxHits: MAX_GREP_FILES,
              });

          const cap = args.max_results ?? 100;
          const lines: string[] = [];
          let scanned = 0;
          let lineTruncated = false;
          for (const t of walked.hits) {
            if (lines.length >= cap) break;
            const size = (await fs.stat(t.abs).catch(() => null))?.size ?? 0;
            if (size > MAX_GREP_FILE_BYTES) continue;
            const buf = await fs.readFile(t.abs).catch(() => null);
            if (!buf || isBinary(buf)) continue;
            scanned += 1;
            const shown = shownPath(ctx, t.abs);
            const textLines = buf.toString("utf-8").split(/\r?\n/);
            for (let i = 0; i < textLines.length && lines.length < cap; i += 1) {
              const match = re.exec(textLines[i]);
              if (!match) continue;
              const clipped = grepMatchPreview(textLines[i], match.index, match[0].length);
              if (clipped !== textLines[i]) lineTruncated = true;
              lines.push(`${shown}:${i + 1}: ${clipped}`);
            }
          }
          const unfinished = walked.truncated
            ? `\n…(文件太多,只扫了前 ${walked.hits.length} 个;请缩小 path 或加 glob)`
            : "";
          if (lines.length === 0) {
            return {
              text: `${note}没有匹配「${args.pattern}」的内容(扫了 ${scanned} 个文件)${unfinished}`,
              structured: { count: 0, matches: [], scanned_files: scanned, truncated: walked.truncated },
            };
          }
          const hitCap = lines.length >= cap;
          return {
            text:
              note +
              lines.join("\n") +
              (hitCap ? `\n…(达到上限 ${cap} 行,可能没搜完)` : "") +
              unfinished,
            structured: {
              count: lines.length,
              line_truncated: lineTruncated,
              matches: lines,
              scanned_files: scanned,
              truncated: hitCap || walked.truncated,
            },
          };
        }),
      outputSchema: GREP_OUTPUT_SCHEMA,
    },

    {
      name: "agent_search_start",
      description:
        "启动可分页的后台搜索会话，支持按文件名(files)或文件内容(content)搜索。" +
        "会立即返回 search_id 和首批结果；大目录不必等全量扫描完。",
      inputSchema: {
        search_type: z.enum(["files", "content"]).describe("files=文件名/路径；content=文件正文"),
        pattern: z.string().min(1).describe("搜索模式；默认按正则解释，literal=true 时按字面量"),
        path: z.string().optional().describe("搜索起点，默认会话工作目录"),
        literal: z.boolean().optional().describe("按字面量而不是正则搜索，默认 false"),
        ignore_case: z.boolean().optional().describe("忽略大小写，默认 true"),
        file_pattern: z.string().optional().describe("只搜索匹配 glob 的文件，如 **/*.ts"),
        include_hidden: z.boolean().optional().describe("是否包含 . 开头的隐藏项，默认 false"),
        context_lines: z.number().int().min(0).max(5).optional().describe("内容命中前后附带几行上下文，默认 0"),
        max_results: z.number().int().min(1).max(5000).optional().describe("整个搜索最多保存多少结果，默认 1000"),
        wait_ms: z.number().int().min(0).max(5000).optional().describe("首批结果最多等待多久，默认 250ms"),
        first_page_length: z.number().int().min(1).max(500).optional().describe("首次最多返回多少条，默认 50"),
      },
      handler: (args: {
        search_type: "files" | "content";
        pattern: string;
        path?: string;
        literal?: boolean;
        ignore_case?: boolean;
        file_pattern?: string;
        include_hidden?: boolean;
        context_lines?: number;
        max_results?: number;
        wait_ms?: number;
        first_page_length?: number;
      }, ctx) =>
        attempt(async () => {
          const root = pOfRead(ctx, args.path ?? ".", "search");
          const out = await agentSearches.start({
            canRead: canRead(ctx),
            ownerSessionId: ctx.sessionId,
            type: args.search_type,
            pattern: args.pattern,
            root,
            literalSearch: args.literal,
            ignoreCase: args.ignore_case,
            filePattern: args.file_pattern,
            includeHidden: args.include_hidden,
            contextLines: args.context_lines,
            maxResults: args.max_results,
            waitMs: args.wait_ms,
            firstPageLength: args.first_page_length,
          });
          return formatSearchResult(out);
        }),
    },

    {
      name: "agent_search_read",
      description:
        "分页读取 agent_search_start 的已有结果；搜索仍在运行时可 wait_ms 等待下一批，不会重复扫描目录。",
      inputSchema: {
        search_id: z.string().min(1).describe("agent_search_start 返回的 search_id"),
        offset: z.number().int().min(0).optional().describe("从第几条结果开始，默认 0"),
        length: z.number().int().min(1).max(500).optional().describe("本页最多多少条，默认 100"),
        wait_ms: z.number().int().min(0).max(5000).optional().describe("暂无新结果时最多等待多久，默认 0"),
      },
      handler: (args: { search_id: string; offset?: number; length?: number; wait_ms?: number }, ctx) =>
        attempt(async () => formatSearchResult(await agentSearches.read({
          ownerSessionId: ctx.sessionId,
          searchId: args.search_id,
          offset: args.offset,
          length: args.length,
          waitMs: args.wait_ms,
        }))),
    },

    {
      name: "agent_search_stop",
      description: "停止当前对话自己启动的后台搜索；已经找到的结果仍可读取。",
      inputSchema: { search_id: z.string().min(1).describe("要停止的 search_id") },
      handler: (args: { search_id: string }, ctx) =>
        attempt(async () => formatSearchResult(agentSearches.stop(ctx.sessionId, args.search_id))),
    },

    {
      name: "agent_search_list",
      description: "列出当前对话的后台搜索会话、状态、结果数量和扫描文件数。",
      inputSchema: {},
      handler: (_args: Record<string, never>, ctx) =>
        attempt(async () => {
          const list = agentSearches.list(ctx.sessionId);
          if (list.length === 0) return "当前对话没有搜索会话";
          return list.map((s) =>
            `${s.searchId}\t${s.status}\t${s.type}\tresults=${s.totalResults}\tscanned=${s.scannedFiles}\t${s.pattern}\t${s.root}`,
          ).join("\n");
        }),
    },

    {
      name: "agent_list_processes",
      description:
        "列出整台机器的系统进程（真实 OS PID、父 PID、内存、命令行）。可用 filter 按名字/命令/PID 收窄。",
      inputSchema: {
        filter: z.string().optional().describe("可选过滤词，如 python、node、1234"),
        limit: z.number().int().min(1).max(1000).optional().describe("最多返回多少个，默认 300"),
      },
      handler: (args: { filter?: string; limit?: number }) =>
        attempt(async () => {
          const rows = await listSystemProcesses(args.filter, args.limit ?? 300);
          if (rows.length === 0) return "没有匹配的系统进程";
          return rows.map((r) => {
            const mem = r.memoryBytes === undefined ? "?" : `${(r.memoryBytes / 1024 / 1024).toFixed(1)}MB`;
            const command = r.command ? clipLine(r.command, 500) : "";
            return `${r.pid}\tppid=${r.ppid ?? "?"}\t${mem}\t${r.name}${command ? `\t${command}` : ""}`;
          }).join("\n");
        }),
    },

    {
      name: "agent_kill_process",
      description:
        "按真实 OS PID 终止系统进程/进程树。它能影响任意本机程序，动手前先确认 PID 没认错（本机会话每次都要用户确认）。" +
        "如果只是清理由 agent_process_start 创建的进程，优先用 agent_process_stop。",
      inputSchema: {
        pid: z.number().int().positive().describe("真实 OS PID（从 agent_list_processes 获取）"),
        force: z.boolean().optional().describe("是否强制终止，默认 true"),
      },
      handler: (args: { pid: number; force?: boolean }) => attempt(async () => killSystemProcess(args.pid, args.force ?? true)),
    },

    {
      name: "agent_bash",
      description:
        "在用户机器上执行一条 shell 命令并返回 stdout / stderr / 退出码(无持久状态,每次独立执行)。" +
        "一次性命令优先用它；REPL、dev server、长构建等需要后续读写 stdin/stdout 的任务用 agent_process_start。" +
        "默认超时 120 秒。" +
        (process.platform === "win32"
          ? "这台机器是 Windows:命令由 cmd.exe 执行(不是 bash;要 PowerShell 写 powershell -NoProfile -Command \"...\")。"
          : "命令由 /bin/sh 执行。") +
        "有副作用的命令按 mcode 的权限规则处理(本机会话可能要用户确认;公网通道只允许写项目目录)。",
      inputSchema: {
        command: z.string().min(1).describe("要执行的命令(单条;多步用 && 串联)"),
        cwd: z.string().optional().describe("工作目录,默认会话工作目录"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(MAX_BASH_TIMEOUT_MS)
          .optional()
          .describe("超时毫秒数,默认 120000,最大 600000"),
      },
      handler: (args: { command: string; cwd?: string; timeout_ms?: number }, ctx) =>
        attemptStructured(
          () =>
            new Promise<{ text: string; structured: Record<string, unknown> }>((resolve, reject) => {
              // bash 的 cwd 是"命令在哪跑",不是"能碰哪个文件" —— 命令里的**重定向目标**
              // 可以指向别处(`> /other/x`)。所以这里额外做一道**写目标检查**:
              // 见下面那个 guard。
              const sandbox = sandboxOf(ctx);
              // ⚠️ **第三参必须给 `sandbox`** —— `resolveAgainstCwd` 的 `root` 默认是
              // null(不检查),只传两个参数的话**命令自己的 cwd 就不受沙箱约束**:
              // `{cwd: "D:\\other", command: "echo x > out.txt"}` 会真的写到 D:\other,
              // 而下面那个重定向检查算的是"相对沙箱"的路径、正好放行 —— 写边界被一个
              // `cwd` 参数绕过去(2026-09-24 审查发现)。
              const cwd = resolveAgainstCwd(sandbox ?? cwdOf(ctx), args.cwd ?? ".", sandbox);
              // **重定向目标也要落在沙箱里** —— 只有公网那条路(有沙箱)才查。
              //
              // 复用的是 Pi 那条路早就有的 `extractBashWriteTargets`(不写第二份解析器,
              // 硬规矩 2)。它认 `>` / `>>` / `tee` / `dd of=` / `sed -i` 那几种形式。
              //
              // ⚠️ **这不是沙箱,是"防误操作"** —— 那个模块的文件头自己写明了:
              // 它只做静态扫描,`cp`/`mv` 的目标参数、heredoc、管道进 `cat >`、`install`
              // 这些它不认,所以刻意绕的人仍绕得过。它的价值是挡住"顺手往 /tmp 写个脚本"
              // 这类**无意的**越界 —— 之前这条路连这个都没有。
              if (sandbox) {
                const denial = sandboxBashWriteDenial(args.command, sandbox);
                if (denial) {
                  reject(new Error(denial));
                  return;
                }
              }
              const timeout = Math.min(args.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
              const child = spawn(args.command, {
                shell: true,
                ...TREE_KILLABLE,
                cwd,
                windowsHide: true,
                env: { ...process.env },
              });
              let settled = false;
              // 每条流一个解码器 + 一个累积盒 —— 抗"多字节字符被 chunk 边界切断"
              // (见 `appendDecoded`)。挂在这次调用上,不与别的调用共用。
              // **只用 acc,不留一份镜像的 `stdout` 变量** —— 两份会漂。
              const bashOutAcc = { text: "" };
              const bashErrAcc = { text: "" };
              const bashOutDec = newDecoder();
              const bashErrDec = newDecoder();
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                // 杀整棵树:`child.kill()` 只杀 shell,命令本身(Windows 的 cmd 子进程、
                // 类 Unix 上 sh 起的那条)会留在后台接着跑。
                killTree(child);
                reject(new Error(`命令超过 ${timeout}ms 没跑完,已终止;可拆成多步或加大 timeout_ms 重试`));
              }, timeout);
              child.stdout.on("data", (d: Buffer) => {
                appendDecoded(bashOutAcc, bashOutDec, d, MAX_OUTPUT_CHARS * 2);
              });
              child.stderr.on("data", (d: Buffer) => {
                appendDecoded(bashErrAcc, bashErrDec, d, MAX_OUTPUT_CHARS * 2);
              });
              child.on("error", (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
              });
              child.on("close", (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const stdout = bashOutAcc.text;
                const stderr = bashErrAcc.text;
                const parts = [`exit: ${code ?? "null"}`];
                if (stdout.trim()) parts.push(`--- stdout ---\n${truncateOutput(stdout.trim(), "stdout")}`);
                if (stderr.trim()) parts.push(`--- stderr ---\n${truncateOutput(stderr.trim(), "stderr")}`);
                resolve({
                  text: parts.join("\n"),
                  // 与 agent_ssh_exec 同形(都是"跑一条命令拿退出码")—— 同一个 schema 复用。
                  structured: { exit_code: code, signal: null, stdout, stderr },
                });
              });
            }),
        ),
      outputSchema: REMOTE_EXEC_OUTPUT_SCHEMA,
    },

    {
      name: "agent_process_start",
      description:
        "启动一个可持续交互的本地进程(REPL、开发服务器、长构建等)，立即返回 process_id 和初始输出。" +
        "之后用 agent_process_read 读增量输出、agent_process_write 写 stdin、agent_process_stop 清理。按 mcode 权限规则处理(本机会话可能要用户确认)。",
      inputSchema: {
        command: z.string().min(1).describe("要启动的命令,例如 `python -i`、`pnpm dev`"),
        cwd: z.string().optional().describe("工作目录,默认会话工作目录"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(MAX_PROCESS_TIMEOUT_MS)
          .optional()
          .describe(`进程最长存活时间,默认 600000ms,最大 ${MAX_PROCESS_TIMEOUT_MS}ms`),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_WAIT_MS)
          .optional()
          .describe("启动后最多等多久收第一批输出,默认 250ms"),
      },
      handler: (args: { command: string; cwd?: string; timeout_ms?: number; wait_ms?: number }, ctx) =>
        attemptStructured(async () => {
          // 同 agent_bash:cwd 也要落在沙箱里(第三参给上,否则 `cwd` 参数能绕出去)。
          const sandbox = sandboxOf(ctx);
          const cwd = resolveAgainstCwd(sandbox ?? cwdOf(ctx), args.cwd ?? ".", sandbox);
          const out = await agentProcesses.start({
            ownerSessionId: ctx.sessionId,
            command: args.command,
            cwd,
            timeoutMs: args.timeout_ms,
            waitMs: args.wait_ms,
          });
          return { text: formatProcessResult(out), structured: processResultStructured(out) };
        }),
      outputSchema: PROCESS_OUTPUT_SCHEMA,
    },

    {
      name: "agent_process_read",
      description:
        "读取持久进程输出。**默认会阻塞等到有输出**（最多约 55 秒）——不用做短轮询，" +
        "一次调用就能等到下一批日志或进程结束。返回的 has_more 为 true 时立刻再读一次。" +
        "传 process_id 时按 cursor 增量读取；省略 process_id 时列出当前对话创建过的进程。",
      inputSchema: {
        process_id: z.string().min(1).optional().describe("agent_process_start 返回的 id；省略则列进程"),
        cursor: z.number().int().min(0).optional().describe("从这个绝对字符游标继续读；用上次的 next_cursor"),
        max_chars: z.number().int().min(1).max(60000).optional().describe("本次最多返回字符数,默认 20000"),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_WAIT_MS)
          .optional()
          .describe(`没有新输出时最多等多久,默认 ${MAX_PROCESS_WAIT_MS}ms（阻塞等待，别传 0 去空轮询）`),
      },
      handler: (args: { process_id?: string; cursor?: number; max_chars?: number; wait_ms?: number }, ctx) =>
        attemptStructured(async () => {
          if (!args.process_id) {
            const items = agentProcesses.list(ctx.sessionId);
            if (items.length === 0) return { text: "当前对话还没有 agent 持久进程", structured: null };
            return {
              text: items
                .map((item) =>
                  `- ${item.processId} [${item.status}] cursor=${item.endCursor} cwd=${item.cwd}\n  ${item.command}`,
                )
                .join("\n"),
              structured: null,
            };
          }
          const out = await agentProcesses.read({
            ownerSessionId: ctx.sessionId,
            processId: args.process_id,
            cursor: args.cursor,
            maxChars: args.max_chars,
            waitMs: args.wait_ms,
          });
          return { text: formatProcessResult(out), structured: processResultStructured(out) };
        }),
      outputSchema: PROCESS_OUTPUT_SCHEMA,
    },

    {
      name: "agent_process_sessions",
      description: "列出当前对话通过 agent_process_start 创建的持久进程会话及状态。",
      inputSchema: {},
      handler: (_args: Record<string, never>, ctx) =>
        attempt(async () => {
          const list = agentProcesses.list(ctx.sessionId);
          if (list.length === 0) return "当前对话没有持久进程会话";
          return list.map((p) =>
            `${p.processId}\t${p.status}\tcursor=${p.endCursor}\t${p.command}\t${p.cwd}`,
          ).join("\n");
        }),
    },

    {
      name: "agent_process_write",
      description:
        "向 agent_process_start 创建的进程写 stdin，并可顺手等待/返回这次输入之后的新输出。" +
        "输入可能执行代码或命令，所以和启动进程走同一档权限规则。",
      inputSchema: {
        process_id: z.string().min(1).describe("agent_process_start 返回的 id"),
        input: z.string().describe("写入 stdin 的文本"),
        append_newline: z.boolean().optional().describe("是否自动补换行,默认 true"),
        cursor: z.number().int().min(0).optional().describe("希望从哪个输出游标开始回传；默认只回这次写入后的新输出"),
        max_chars: z.number().int().min(1).max(60000).optional().describe("本次最多返回字符数,默认 20000"),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_WAIT_MS)
          .optional()
          .describe("写入后最多等多久收新输出,默认 250ms"),
      },
      handler: (
        args: {
          process_id: string;
          input: string;
          append_newline?: boolean;
          cursor?: number;
          max_chars?: number;
          wait_ms?: number;
        },
        ctx,
      ) =>
        attemptStructured(async () => {
          const out = await agentProcesses.write({
            ownerSessionId: ctx.sessionId,
            processId: args.process_id,
            input: args.input,
            appendNewline: args.append_newline,
            cursor: args.cursor,
            maxChars: args.max_chars,
            waitMs: args.wait_ms,
          });
          return { text: formatProcessResult(out), structured: processResultStructured(out) };
        }),
      outputSchema: PROCESS_OUTPUT_SCHEMA,
    },

    {
      name: "agent_process_stop",
      description:
        "停止当前对话自己通过 agent_process_start 创建的进程，并返回停止后的尾部输出。" +
        "不能接收任意 OS pid，因此作为安全清理动作无需重复审批。",
      inputSchema: {
        process_id: z.string().min(1).describe("agent_process_start 返回的 id"),
        cursor: z.number().int().min(0).optional().describe("从哪个输出游标开始返回尾部,默认只返回停止动作后的输出"),
        max_chars: z.number().int().min(1).max(60000).optional().describe("最多返回字符数,默认 20000"),
      },
      handler: (args: { process_id: string; cursor?: number; max_chars?: number }, ctx) =>
        attemptStructured(async () => {
          const out = await agentProcesses.stop({
            ownerSessionId: ctx.sessionId,
            processId: args.process_id,
            cursor: args.cursor,
            maxChars: args.max_chars,
          });
          return { text: formatProcessResult(out), structured: processResultStructured(out) };
        }),
      outputSchema: PROCESS_OUTPUT_SCHEMA,
    },

    {
      name: "agent_ssh_connect",
      // Pre-connection validation failures have no connection record; they return isError + text.
      outputSchema: {
        connection_id: z.string().optional(),
        state: z.enum(["connecting", "ready", "reconnecting", "error", "closed"]).optional(),
        host: z.string().optional(), port: z.number().int().optional(), username: z.string().optional(),
        reconnect_attempt: z.number().int().optional(), retryable: z.boolean().optional(), last_error: z.string().nullable().optional(),
      },
      description:
        "连接已由 AI 与用户明确配置的 SSH 目标。必须给出实际 host、username，并且只选 private_key_path / agent_path / password 一种认证。" +
        "工具不扫描密钥、不读取或修改 ~/.ssh/config、不生成密钥、不启动 agent，也不代办 MFA/解锁等交互；需用户操作时先请求用户完成。" +
        "网络断开后可以重连同一配置；认证失败不重试。敏感凭据仅用于本机连接，不写入工具返回。",
      inputSchema: {
        host: z.string().min(1).describe("已确认的 SSH 主机/IP，不自动展开 SSH Host 别名"),
        port: z.number().int().min(1).max(65535).optional().describe("明确的 SSH 端口，默认 22"),
        username: z.string().min(1).describe("已确认的 SSH 用户名"),
        password: z.string().min(1).optional().describe("明确提供的密码；不要要求用户在公开聊天里粘贴秘密"),
        private_key_path: z.string().min(1).optional().describe("已确认的本机私钥路径；不搜索其他私钥"),
        agent_path: z.string().min(1).optional().describe("已配置 SSH agent 的 socket 或 Windows 命名管道；由调用者明确指定，不自动探测"),
        passphrase: z.string().optional().describe("指定私钥的口令；需要交互解锁时先由用户完成"),
        keepalive_interval_ms: z.number().int().min(5000).max(60000).optional().describe("SSH keepalive 间隔，默认 15000"),
        keepalive_count_max: z.number().int().min(1).max(12).optional().describe("连续多少次 keepalive 无响应才判定断线，默认 4"),
        ready_timeout_ms: z.number().int().min(5000).max(60000).optional().describe("单次握手超时，默认 20000"),
      },
      handler: (args: {
        host: string; port?: number; username: string; password?: string; private_key_path?: string; agent_path?: string;
        passphrase?: string; keepalive_interval_ms?: number; keepalive_count_max?: number; ready_timeout_ms?: number;
      }, ctx) => attemptStructured(async () => {
        const info = await agentRemoteSsh.connect({
          ownerSessionId: ctx.sessionId,
          host: args.host,
          port: args.port,
          username: args.username,
          password: args.password,
          privateKeyPath: args.private_key_path,
          agentPath: args.agent_path,
          passphrase: args.passphrase,
          keepaliveIntervalMs: args.keepalive_interval_ms,
          keepaliveCountMax: args.keepalive_count_max,
          readyTimeoutMs: args.ready_timeout_ms,
        });
        const note = info.state === "error" ? "\n请修正明确的连接配置后重试；认证错误不会自动重连" : "";
        return { text: formatRemoteConnection(info) + note, isError: info.state !== "ready", structured: {
          connection_id: info.connectionId, state: info.state, host: info.host, port: info.port,
          username: info.username, reconnect_attempt: info.reconnectAttempt, retryable: info.state === "reconnecting", last_error: info.lastError,
        } };

      }),
    },

    {
      name: "agent_ssh_status",
      description: "查看当前对话的 SSH 连接状态。省略 connection_id 时列出全部连接；只读，不会触发远程命令。",
      inputSchema: {
        connection_id: z.string().min(1).optional().describe("agent_ssh_connect 返回的 id；省略则列全部"),
      },
      handler: (args: { connection_id?: string }, ctx) => attempt(async () => {
        if (args.connection_id) return formatRemoteConnection(agentRemoteSsh.status(ctx.sessionId, args.connection_id));
        const items = agentRemoteSsh.list(ctx.sessionId);
        return items.length ? items.map(formatRemoteConnection).join("\n\n") : "当前对话没有 SSH 连接";
      }),
    },

    {
      name: "agent_ssh_disconnect",
      description: "主动关闭当前对话自己创建的 SSH 连接并停止自动重连。不会停止服务器上已启动的训练任务。",
      inputSchema: { connection_id: z.string().min(1).describe("要关闭的 connection_id") },
      handler: (args: { connection_id: string }, ctx) => attempt(async () => {
        await agentRemoteSsh.disconnect(ctx.sessionId, args.connection_id);
        return `SSH 连接 ${args.connection_id} 已关闭；远程训练任务不受影响`;
      }),
    },

    {
      name: "agent_ssh_exec",
      description:
        "通过稳定 SSH 连接执行一条短命令并返回 stdout/stderr/exit。" +
        "只适合状态检查、nvidia-smi、mkdir 等短操作；训练/长任务必须用 agent_remote_job_start，避免 SSH 断开牵连任务。" +
        "没有 stdin（读输入的命令会立刻读到 EOF）；超时会杀掉远端整个进程组。",
      inputSchema: {
        connection_id: z.string().min(1),
        command: z.string().min(1),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(MAX_SSH_EXEC_TIMEOUT_MS)
          .optional()
          .describe(`默认 ${DEFAULT_SSH_EXEC_TIMEOUT_MS}，最大 ${MAX_SSH_EXEC_TIMEOUT_MS}`),
      },
      handler: (args: { connection_id: string; command: string; timeout_ms?: number }, ctx) => attemptStructured(async () => {
        const r = await agentRemoteSsh.exec(ctx.sessionId, args.connection_id, args.command, args.timeout_ms);
        const parts = [`exit: ${r.code ?? "null"}${r.signal ? ` signal=${r.signal}` : ""}`];
        const stdout = truncateHeadTail(r.stdout.trim(), "remote stdout");
        const stderr = truncateHeadTail(r.stderr.trim(), "remote stderr");
        if (stdout) parts.push(`--- stdout ---\n${stdout}`);
        if (stderr) parts.push(`--- stderr ---\n${stderr}`);
        return {
          text: parts.join("\n"),
          structured: {
            exit_code: r.code,
            signal: r.signal,
            stdout,
            stderr,
          },
        };
      }),
      outputSchema: REMOTE_EXEC_OUTPUT_SCHEMA,
    },

    {
      name: "agent_remote_job_start",
      description:
        "在远程服务器启动与 SSH 生命周期解耦的训练/长任务。任务事实写到 ~/.mcode/jobs/<job_id>；" +
        "SSH/MCP/聊天断开后任务继续。job_id 是幂等键：网络失败后重试必须复用同一个 job_id，避免重复启动抢 GPU。",
      inputSchema: {
        connection_id: z.string().min(1),
        command: z.string().min(1).describe("训练命令，例如 python train.py ..."),
        cwd: z.string().optional().describe("远程工作目录，默认 $HOME"),
        job_id: z.string().min(1).max(64).optional().describe("强烈建议训练任务显式给稳定 id；重试必须复用它"),
        mode: z.enum(["auto", "tmux", "nohup"]).optional().describe("auto 优先 tmux、没有则 nohup；默认 auto"),
      },
      handler: (args: { connection_id: string; command: string; cwd?: string; job_id?: string; mode?: "auto" | "tmux" | "nohup" }, ctx) =>
        attemptStructured(async () => {
          const r = await agentRemoteSsh.startJob({
            ownerSessionId: ctx.sessionId,
            connectionId: args.connection_id,
            command: args.command,
            cwd: args.cwd,
            jobId: args.job_id,
            mode: args.mode,
          });
          return {
            text: `created: ${r.created}\n${formatRemoteJobStatus(r.status)}${r.created ? "" : "\nnote: 同名 job 已存在，本次没有重复启动"}`,
            // `created: false` 是**幂等命中**(同名 job 已在跑),模型必须能区分它和
            // "这次真的启动了"—— 否则网络失败后重试会以为起了两次。
            structured: { created: r.created, ...remoteJobStatusStructured(r.status) },
          };
        }),
      outputSchema: { created: z.boolean().describe("这次是否真的新建了任务；false = 同名任务已存在（幂等命中）"), ...REMOTE_JOB_STATUS_OUTPUT_SCHEMA },
    },

    {
      name: "agent_remote_job_status",
      description: "查询远程训练任务状态。状态来自服务器 ~/.mcode/jobs，不依赖本机 SSH 连接曾经是否断过。",
      inputSchema: { connection_id: z.string().min(1), job_id: z.string().min(1).max(64) },
      handler: (args: { connection_id: string; job_id: string }, ctx) =>
        attemptStructured(async () => {
          const s = await agentRemoteSsh.jobStatus(ctx.sessionId, args.connection_id, args.job_id);
          return { text: formatRemoteJobStatus(s), structured: remoteJobStatusStructured(s) };
        }),
      outputSchema: REMOTE_JOB_STATUS_OUTPUT_SCHEMA,
    },

    {
      name: "agent_remote_job_logs",
      description:
        "按字节 cursor 增量读取远程训练 stdout/stderr；日志保存在服务器文件里，SSH 重连后可从上次 next_cursor 接着读。" +
        "**默认会阻塞等到有新输出**（最长约 55 秒）——不要传 wait_ms=0 去做短轮询，" +
        "那只会制造大量空往返；一次调用就是等下一批日志。返回里 more_output 为 true 时立刻再读一次；" +
        "任务已结束时不会等待，job_finished=true 且 more_output=false 就表示日志已读完。",
      inputSchema: {
        connection_id: z.string().min(1),
        job_id: z.string().min(1).max(64),
        stream: z.enum(["stdout", "stderr"]).optional().describe("默认 stdout"),
        cursor: z.number().int().min(0).optional().describe("上次 next_cursor；默认 0"),
        max_bytes: z.number().int().min(4).max(60000).optional().describe("本次最多读取字节数，默认 20000；至少 4 字节以容纳完整 UTF-8 字符"),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_JOB_LOG_WAIT_MS)
          .optional()
          .describe(`没有新输出时最多等多久，默认 ${DEFAULT_JOB_LOG_WAIT_MS}ms（阻塞等待，别传 0 去空轮询）`),
      },
      handler: (args: { connection_id: string; job_id: string; stream?: "stdout" | "stderr"; cursor?: number; max_bytes?: number; wait_ms?: number }, ctx) =>
        attemptStructured(async () => {
          const r = await agentRemoteSsh.jobLogs({
            ownerSessionId: ctx.sessionId,
            connectionId: args.connection_id,
            jobId: args.job_id,
            stream: args.stream ?? "stdout",
            cursor: args.cursor,
            maxBytes: args.max_bytes,
            waitMs: args.wait_ms ?? DEFAULT_JOB_LOG_WAIT_MS,
          });
          return {
            text: [
              `job_id: ${r.jobId}`,
              `stream: ${r.stream}`,
              `cursor: ${r.cursor}`,
              `next_cursor: ${r.nextCursor}`,
              `total_bytes: ${r.totalBytes}`,
              `more_output: ${r.truncated}`,
              `job_finished: ${r.jobFinished}`,
              "--- output ---",
              r.text || (r.jobFinished && !r.truncated ? "(任务已结束，没有更多输出)" : "(暂无完整文本，请按游标继续读取)"),
            ].join("\n"),
            structured: {
              job_id: r.jobId,
              stream: r.stream,
              cursor: r.cursor,
              next_cursor: r.nextCursor,
              total_bytes: r.totalBytes,
              more_output: r.truncated,
              job_finished: r.jobFinished,
              output: r.text,
            },
          };
        }),
      outputSchema: REMOTE_JOB_LOG_OUTPUT_SCHEMA,
    },

    {
      name: "agent_remote_job_list",
      description: "列出服务器 ~/.mcode/jobs 下最近的任务 id，便于 SSH/MCP 重启后重新发现训练任务。",
      inputSchema: { connection_id: z.string().min(1) },
      handler: (args: { connection_id: string }, ctx) => attempt(async () => {
        const jobs = await agentRemoteSsh.listJobs(ctx.sessionId, args.connection_id);
        return jobs.length ? jobs.map((id) => `- ${id}`).join("\n") : "服务器上还没有 mcode remote job";
      }),
    },

    {
      name: "agent_remote_job_cancel",
      description: "取消远程训练任务。优先杀 tmux session / runner 进程组；属于有副作用操作，需要审批。",
      inputSchema: { connection_id: z.string().min(1), job_id: z.string().min(1).max(64) },
      handler: (args: { connection_id: string; job_id: string }, ctx) => attempt(async () =>
        formatRemoteJobStatus(await agentRemoteSsh.cancelJob(ctx.sessionId, args.connection_id, args.job_id)),
      ),
    },
    {
      name: "agent_context",
      description:
        "查询基本运行环境：操作系统、shell、当前可写项目及项目列表。默认不查询或列出资料库。" +
        "只有任务明确需要资料库时才传 include_library=true，或使用 library_* 只读查询；资料库仍只读。",
      inputSchema: { include_library: z.boolean().optional().describe("明确需要资料库概况时才开启，默认 false") },
      handler: (args: { include_library?: boolean }, ctx) =>
        attemptStructured(async () => {
          // ⚠️ **"当前项目"取的是沙箱根,不是 `cwdFor`。**
          //
          // `cwdFor` 优先返回运行时的 `lastCwd` —— 那是**跟着 `cd` 走的缓存**,会话
          // 以前在哪儿 `cd` 过就永久停在那儿。用户报的就是这个:设置里明明只选了一个
          // 项目,agent 却报出另一个(缓存里那个),三个路径对不上。
          //
          // 沙箱根 = 用户在「远程控制」里选的那个项目,而且**它才是能写的地方** ——
          // 报给模型时按它说,模型才不会去改一个其实只读的目录。
          // 桌面本机会话没有沙箱根(返回 null),那时退回 cwd —— 那条路行为不变。
          const sandbox = sandboxOf(ctx);
          const snap = readEnvSnapshot(sandbox ?? cwdOf(ctx), { includeLibrary: args.include_library === true });
          if (!snap) {
            return {
              text: "环境信息暂时读不到(项目或数据库尚未就绪)。可以先用 agent_list_dir 看当前目录。",
              structured: null,
            };
          }
          const lines: string[] = [];
          // **说清哪个能写** —— 用户明确要求"项目可写、资料库只读"。只列路径不说
          // 权限,模型会去改一个其实只读的目录,然后撞一鼻子灰(而且它不知道为什么)。
          const projLines = [
            `✅ 可写(就只这一个): ${snap.currentProjectPath ?? "(没选 —— 在 Mcode 的「远程控制」里选一个项目)"}`,
          ];
          if (snap.projects.length > 0) {
            projLines.push(`你的全部项目(${snap.projects.length} 个,只读);`);
            for (const p of snap.projects) projLines.push(`- ${p.name}\n  路径: ${p.path}`);
          }
          lines.push("## 项目\n" + projLines.join("\n"));

          if (!args.include_library) return {
            text: `操作系统: ${process.platform}\nshell: ${process.platform === "win32" ? "cmd.exe" : "/bin/sh"}\n\n${lines.join("\n\n")}`,
            structured: { writable_project: snap.currentProjectPath, projects: snap.projects },
          };

          // **守屏蔽规则**(设置 → 文档管理,见 `LIBRARY_BLOCK_SETTINGS_PAGE`):整条挡的不列,按文件类型挡的那份不给路径 ——
          // 与 `library_search` 同一口径(`suppressionReasonOfItem` / `aiVisibleFilesOf`)。
          // 路径给**绝对路径**:库里存的是相对库根的,原样给出去,模型在公网那条路上会按
          // 项目目录去解析,读不到。
          let ai: ReturnType<LibraryForAi> = null;
          try {
            ai = snap.items.length > 0 ? (deps.libraryForAi?.(snap.items.length) ?? null) : null;
          } catch {
            ai = null;
          }
          const visibleItems = ai
            ? ai.items
            : snap.items.map((it) => ({
                title: it.title,
                kind: it.kind,
                year: it.year,
                venue: it.venue,
                path: it.mdPath || it.pdfPath || null,
              }));
          const hiddenCount = ai ? ai.hidden : 0;
          const libLines = [`库根: ${snap.libraryRoot}`];
          if (snap.totalItems === 0) {
            libLines.push("(库是空的)");
          } else {
            libLines.push(
              `共 ${snap.totalItems} 条${snap.totalItems > snap.items.length ? `,列表只给前 ${snap.items.length} 条` : ""}:`,
            );
            for (const it of visibleItems) {
              const file = it.path;
              // **给标题,不是 sha256 文件名** —— 库是内容寻址的(`papers/ab/cd/<hash>.pdf`),
              // 只给路径的话模型认不出哪篇是哪篇,这份清单就白给了(见 envPrompt 文件头)。
              const bits = [
                it.title?.trim() || "(无标题)",
                it.kind ? `[${it.kind}]` : "",
                it.year ? String(it.year) : "",
                it.venue ? `· ${it.venue}` : "",
              ].filter(Boolean);
              libLines.push(`- ${bits.join(" ")}${file ? `\n  文件: ${file}` : ""}`);
            }
          }
          if (hiddenCount > 0) libLines.push(`(另有 ${hiddenCount} 条被屏蔽规则挡住了,没有列出来。)`);
          libLines.push(ctx.audience === "public" ? "按关键词或分类查询请用 library_query。" : "要按关键词找、或按分类翻,用 library_search / library_collections / library_items(如果有这几个工具)。");
          lines.push("## 资料库\n" + libLines.join("\n"));
          lines.push("⚠️ 资料库只读 —— 读它、复制进项目都行,别在库里改。要改先复制到项目里。");

          return {
            text: lines.join("\n\n"),
            structured: {
              writable_project: snap.currentProjectPath,
              projects: snap.projects,
              library_root: snap.libraryRoot,
              library_total: snap.totalItems,
              library_items: visibleItems.map((it) => ({
                title: it.title,
                kind: it.kind,
                year: it.year ?? null,
                venue: it.venue ?? null,
                path: it.path || null,
              })),
              library_truncated: snap.totalItems > snap.items.length,
            },
          };
        }),
      outputSchema: AGENT_CONTEXT_OUTPUT_SCHEMA,
    },
    {
      name: "agent_skill_list",
      description:
        "列出用户装在 Mcode 技能库里的技能。返回每条技能的名字、一句话说明和 SKILL.md 的路径 —— " +
        "用 agent_skill_read(按名字)或 agent_read_file(按路径)读内容。",
      inputSchema: {},
      handler: (_args: Record<string, never>, _ctx) =>
        attempt(async () => {
          const root = defaultSkillsRoot();
          // 与设置里「技能」页、三个引擎同一套发现规则(`skillNamesInRoot`):名字以 frontmatter
          // 为准、隐藏目录(Codex 的 .system)不算。从前这里自己 readdir、显示 frontmatter 名,
          // 而 agent_skill_read 按**目录名**找 —— 两边一对不上,列出来的技能读不到。
          const byName = skillNamesInRoot(root);
          if (byName.size === 0) return "技能库里没有可用的技能(~/.mcode/skills 下没有带 SKILL.md 的技能目录)";
          const engines = readEnginesMap(root);
          const lines: string[] = [];
          let disabled = 0;
          for (const [name, dir] of byName) {
            // 远程 / 网页端的 AI 不是三个引擎里的哪一个:只有用户把一条技能对**所有**引擎都关了,
            // 才算它不想给 AI 用。从前按 claude 那一列过滤,关了 Claude 的技能在这里就整条消失。
            if (!SKILL_ENGINES.some((engine) => engineEnabled(engines, name, engine))) {
              disabled += 1;
              continue;
            }
            const mdPath = path.join(dir, "SKILL.md");
            const md = await fs.readFile(mdPath, "utf-8").catch(() => null);
            if (md == null) continue;
            const fm = parseSkillFrontmatter(md);
            lines.push(`- ${name}${fm.description ? ` — ${fm.description.trim()}` : ""}\n  ${mdPath}`);
          }
          const note = disabled > 0 ? `\n(另有 ${disabled} 条被用户在设置里对所有引擎关掉了,不列出。)` : "";
          if (lines.length === 0) return `技能库里没有可用的技能。${note}`.trim();
          return `可用技能 ${lines.length} 条:\n${lines.join("\n")}${note}`;
        }),
    },

    {
      name: "agent_skill_read",
      description:
        "读取一条技能的完整 SKILL.md 内容(按 agent_skill_list 里的名字)。读了之后照着里面的步骤执行;" +
        "技能里提到的附属文件(脚本、模板、参考资料)在技能目录下(返回里会给出目录)," +
        "用 agent_read_file / agent_list_dir 读;脚本用 agent_bash 按绝对路径执行。技能目录只读 —— " +
        "产出的文件写到项目里。",
      inputSchema: {
        name: z.string().min(1).describe("技能名(agent_skill_list 里列出的名字)"),
      },
      handler: (args: { name: string }, ctx) =>
        attempt(async () => {
          const root = path.resolve(defaultSkillsRoot());
          // 名字里的路径分隔符一律拒掉 —— 只允许一层目录名,防越出技能根。
          if (args.name.includes("/") || args.name.includes("\\") || args.name.includes("..")) {
            return `技能名不合法:${args.name}`;
          }
          // 先按技能名(frontmatter)找,再退回目录名 —— 与 agent_skill_list 列出的名字一致。
          const byName = skillNamesInRoot(root);
          const dir = byName.get(args.name) ?? path.join(root, args.name);
          if (!pathWithin(root, dir)) return `技能名不合法:${args.name}`;
          const mdPath = path.join(dir, "SKILL.md");
          const md = await fs.readFile(mdPath, "utf-8").catch(() => null);
          if (md == null) {
            return `没有叫「${args.name}」的技能(或它没有 SKILL.md);用 agent_skill_list 看看有哪些`;
          }
          void ctx;
          return `# skill: ${args.name}\n(目录:${dir})\n\n${md}`;
        }),
    },
  ];
}

/** True if `abs` is inside `root`(或等于),解析归一化之后比。与 files.ts 的
 *  pathWithin 同款逻辑 —— 这里不 import 那份是为了不把它的依赖链拉进这张表。 */
function pathWithin(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  const rel = path.relative(r, a);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// homedir 目前只被 defaultSkillsRoot 间接覆盖;这里显式引用避免"看起来没用"的 import
// 被误删 —— 技能根的语义就是"用户主目录下的 .mcode/skills"。
void homedir;
