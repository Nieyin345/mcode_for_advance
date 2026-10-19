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
import {
  promises as fs,
} from "node:fs";
import {
  homedir,
} from "node:os";
import path from "node:path";
import {
  spawn,
} from "node:child_process";
import {
  readTextPage,
  formatTextPage,
  withTextFileLock,
  withAgentTextFileLease,
  replaceTextFile,
  applyTextEdits,
  textFileHash,
  grepMatchPreview,
} from "./agentTextFiles.js";
import { writeConflictCopy } from "@main/lib/conflictCopy.js";
import {
  pathWithin as realPathWithin,
} from "@main/lib/realPathWithin.js";
import { moveFileSafe, isMoveDurable } from "@main/lib/moveFileSafe.js";
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
import { z } from "zod";
import {
  defaultSkillsRoot,
  engineEnabled,
  parseSkillFrontmatter,
  readEnginesMap,
  SKILL_ENGINES,
  skillNamesInRoot,
} from "@main/lib/skillEngines.js";
import {
  killTree,
  TREE_KILLABLE,
} from "@main/lib/spawnRun.js";
import {
  extractBashWriteTargets,
} from "@main/providers/pi-sdk/bashWriteGuard.js";
import { readEnvSnapshot } from "@main/providers/envPrompt.js";
import type { LibraryForAi, SandboxReadCheck, SandboxReadKind } from "./sandboxReadPolicy.js";
import { PUBLIC_SCOPE_UNAVAILABLE } from "@contracts/publicMcpScope";
import { ownersForSession, forgetSyntheticSession } from "@main/providers/bridge/publicClientSessions.js";
import { registerOwnerWorkProbe, registerOwnerResourceCounter, registerOwnerResourceReleaser } from "@main/providers/bridge/publicClientSessions.js";
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
// 从本文件拆出去的两段（拆解见各自文件头）—— 这里把还用得着的名字引回来。
import {
  AGENT_CONTEXT_OUTPUT_SCHEMA,
  DEFAULT_BASH_TIMEOUT_MS,
  GLOB_OUTPUT_SCHEMA,
  GREP_OUTPUT_SCHEMA,
  MAX_BASH_TIMEOUT_MS,
  MAX_BATCH_OUTPUT_CHARS,
  MAX_BATCH_READ_FILES,
  MAX_GREP_FILES,
  MAX_GREP_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_LIST_DEPTH,
  MAX_LIST_ENTRIES,
  MAX_OUTPUT_CHARS,
  PROCESS_OUTPUT_SCHEMA,
  REMOTE_EXEC_OUTPUT_SCHEMA,
  REMOTE_JOB_LOG_OUTPUT_SCHEMA,
  REMOTE_JOB_STATUS_OUTPUT_SCHEMA,
  appendDecoded,
  attempt,
  attemptStructured,
  clipLine,
  fileInfoText,
  formatProcessResult,
  formatRemoteConnection,
  formatRemoteJobStatus,
  formatSearchResult,
  isBinary,
  killSystemProcess,
  listSystemProcesses,
  newDecoder,
  processResultStructured,
  readRichDocument,
  renderPdfPage,
  readTextRange,
  readUrlText,
  remoteJobStatusStructured,
  resolveAgainstCwd,
  sandboxBashWriteDenial,
  truncateHeadTail,
  truncateOutput,
} from "./agentToolRuntime.js";
import {
  WalkResult,
  createWalkSkips,
  escapeRegExp,
  globToRegExp,
  globWantsHidden,
  splitGlobPrefix,
  walkErrnoText,
  walkFiles,
  walkSkipFields,
  walkSkipText,
} from "./agentWalkGlob.js";
import { type TextPageOptions } from "./agentTextFiles.js";

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
  "agent_render_pdf_page",
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
  /**
   * **视觉中继**(报告 D10 / Q1):把一张图交给用户配的"有视觉的模型"转述成文字。
   * `agent_read_image` 传 `describe: true` 时走它。
   *
   * 走注入而不是直接 import `lib/visionRelay.js`,原因与 `libraryForAi` 相同:那条链
   * 拉 `SettingRepo` → `db` → `electron`,会把无关的无头 smoke 一起拖下水。没给 =
   * 这个能力不存在(工具照旧只回图片块),公网那条通路**刻意不给**。
   */
  describeImage?: (args: {
    imageBase64: string;
    mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    source?: string;
    question?: string;
  }) => Promise<{ ok: true; text: string; model: string } | { ok: false; error: string }>;
  /**
   * 用户配没配视觉中继模型 —— `agent_read_image` 用它决定 caption 里要不要写那句
   * "带 describe: true 再读一次"。**没配就不写**:否则等于指引模型去走一条走不通的路,
   * 又骗它一次。没给 = 当作没配。
   */
  visionRelayConfigured?: () => boolean;
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
  // 资源按 owner 分桶:本机那条路 owner = 会话 id;公网那条路 owner = 被验证的客户端
  // 会话(MC-063)。删会话时要把该会话名下**所有** owner 一并释放(见 ownersForSession)。
  for (const owner of ownersForSession(sessionId)) {
    agentProcesses.disposeOwner(owner);
    agentSearches.disposeOwner(owner);
    agentRemoteSsh.disposeOwner(owner);
  }
  forgetSyntheticSession(sessionId);
});
// 应用退出时杀掉还在跑的后台进程,否则它们比 Mcode 活得久(端口一直被占)。
registerAgentShutdownHook(() => agentProcesses.disposeAll());
// 【MC-089 在途资源】归属回收前问一句「这个 owner 名下还有活资源吗」——
// 客户端会话被淘汰后,它的 owner 若还在跑进程/搜索/连着 SSH,**不能**当孤儿清掉归属
// (台账「仍有任务的 owner 受控保留」)。这里把「活资源」的判据、计数、终止三件事**共用同
// 一句谓词/同一批管理器**:探针只回答有没有、计数只回答各几个、释放器真去 `disposeOwner` ——
// 一份实现,不另造第二张注册表(纯模块 publicClientSessions.ts 不 import electron/db/ssh2)。
/** 该 owner 名下各有多少**活**资源(进程/搜索/SSH)—— 判定「有没有」与「有几个」同源。 */
function liveResourcesOf(owner: string): { processes: number; searches: number; ssh: number } {
  return {
    processes: agentProcesses.list(owner).filter((p) => p.status === "running").length,
    searches: agentSearches.list(owner).filter((s) => s.status === "running").length,
    // SSH:存在任一尚未主动关闭的连接即视为在途(连接带 keepalive + 自动重连,不能靠收归属
    // 让它消失;远端 tmux/nohup 任务也按设计继续跑)。
    ssh: agentRemoteSsh.list(owner).filter((c) => c.state !== "closed").length,
  };
}
const hasLiveResources = (owner: string): boolean => {
  const r = liveResourcesOf(owner);
  return r.processes > 0 || r.searches > 0 || r.ssh > 0;
};
registerOwnerWorkProbe(hasLiveResources);
// 【MC-089 留存报告】同一个判据的**计数**版:淘汰时如实报「这条凭据名下还挂着几个资源」。
registerOwnerResourceCounter(liveResourcesOf);
// 【MC-089 安全释放】宿主显式终止某个已失效 owner 的在途资源 —— 直接复用它名下资源的
// 管理器 `disposeOwner`(与删会话走**同一个**释放实现),不另起一条终止路径。
registerOwnerResourceReleaser((owner) => {
  agentProcesses.disposeOwner(owner);
  agentSearches.disposeOwner(owner);
  agentRemoteSsh.disposeOwner(owner);
});

export function agentMcpTools(deps: AgentToolsDeps): McpToolSpec[] {
  /** 每个工具共用的前置:解析 cwd。失败统一转 fail 文本。 */
  const cwdOf = (ctx: McpToolContext): string | null => deps.cwdFor(ctx.sessionId);
  /**
   * **资源归属 id** —— 进程 / 搜索 / SSH 这些"谁建的谁管"的东西按它分桶。
   *
   * 本机那条路没有 `ownerId`(退回 `sessionId`,行为不变)。公网那条路由宿主设为
   * **被验证的客户端会话标识**(`PublicActionContext.clientSessionId`),于是同一个项目
   * 链接被多个 ChatGPT 对话复用时,各对话互不可见、各用各的配额(MC-063)。
   */
  const ownerOf = (ctx: McpToolContext): string => ctx.ownerId ?? ctx.sessionId;
  /**
   * 这个会话的沙箱根(null = 不限制,桌面本机那条路)。
   *
   * ⚠️ **公网那条路必须用鉴权时固化的 `ctx.publicScope.canonicalRoot`,绝不再按当前
   * 链接动态推导**(MC-062):撤销链接后 `deps.sandboxRootFor` 会返回 null,而 null 在这里
   * 表示"不限制" —— 那等于撤销反而放宽在途请求的作用域。公网恒有 `publicScope`(由入口
   * 固化),取它的根就钉死了。缺根时返回 null,由调用方(公网写/执行路径)**fail closed**。
   */
  const sandboxOf = (ctx: McpToolContext): string | null => {
    if (ctx.audience === "public") {
      // ⚠️ **只用鉴权时固化的根,绝不按当前链接动态重推** —— 没有就等于没有根,
      // 由 `requirePublicRoot` fail closed;不回退 `deps.sandboxRootFor`(那正是 MC-062)。
      return ctx.publicScope?.canonicalRoot || null;
    }
    return deps.sandboxRootFor?.(ctx.sessionId) ?? null;
  };
  /**
   * **公网 fail closed 的唯一判据**(MC-062):公网 audience 拿不到有效沙箱根时,
   * 一律拒绝,绝不把 `null` 当"不限路径"、也绝不回退 `cwdFor`/默认项目。
   *
   * 本机那条路(`audience !== "public"`)没有沙箱是**设计**(桌面 claude 引擎那种自由度),
   * 不受这里影响。返回统一错误标记 `PUBLIC_SCOPE_UNAVAILABLE`,便于上游识别与断言。
   */
  const requirePublicRoot = (ctx: McpToolContext): void => {
    if (ctx.audience !== "public") return;
    if (!sandboxOf(ctx)) {
      throw new Error(PUBLIC_SCOPE_UNAVAILABLE);
    }
  };
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
    requirePublicRoot(ctx);
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
    requirePublicRoot(ctx);
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
        "读取 PDF / DOCX / XLSX / PPTX。默认 reader=auto 优先复用 GenOffice 原生 CLI 文档工具；仅其不可用或参数不兼容时使用历史只读解析器。reader=genoffice 禁止静默回退；reader=native 显式使用旧实现。" +
        "Excel/PowerPoint 默认优先复用 GenOffice 原厂 CLI；不支持的兼容筛选参数或未安装时才使用历史 Python 工具链。PPTX 提供 slide_start/max_slides 与 next_slide 续读。PDF 传 pdf_mode=layout 可查看真实书签、逐页文字坐标、图像绘制指令；配合 agent_render_pdf_page 查看图表与扫描页。布局仅近似、不做 OCR。",
      inputSchema: {
        path: z.string().min(1).describe("文档路径"),
        sheet: z.string().optional().describe("Excel 工作表名；省略取第一张"),
        range: z.string().optional().describe("Excel 范围，如 A1:D50；省略从左上角读取"),
        max_pages: z.number().int().min(1).max(500).optional().describe("PDF 最多解析页数；文本模式默认 200，layout 模式默认 10"),
        page_start: z.number().int().min(1).optional().describe("PDF 起始页(从 1 开始)，文本与布局模式均可配合 max_pages 分页"),
        reader: z.enum(["auto", "genoffice", "native"]).optional().describe("读取引擎：auto=GenOffice 优先、不可用才用历史读取(默认)；genoffice=仅 GenOffice/失败如实返回；native=强制历史解析器"),
        pdf_mode: z.enum(["text", "layout"]).optional().describe("PDF：text=按页文本(默认)；layout=本地 pdfjs 的布局线索(GenOffice PDFium 不提供 x/y 坐标，需要 reader=native)"),
        docx_mode: z.enum(["text", "structure"]).optional().describe("DOCX：text=原有 Markdown/纯文本(默认)；structure=OOXML 原始段落 styleId 与表格单元格"),
        block_start: z.number().int().min(1).optional().describe("DOCX structure 模式起始 Block 编号，从 1 开始"),
        max_blocks: z.number().int().min(1).max(100).optional().describe("DOCX structure 每次最多读取的顶层结构块，默认 30、最多 100"),
        slide_start: z.number().int().min(1).optional().describe("PPTX 起始页(1-based)，可按 next_slide 续读"),
        max_slides: z.number().int().min(1).max(1000).optional().describe("PPTX 本次页数：GenOffice 默认1、每次最多8页；native 默认200"),
        max_rows: z.number().int().min(1).max(1000).optional().describe("Excel 最多返回行数，默认 200"),
        max_cols: z.number().int().min(1).max(200).optional().describe("Excel 最多返回列数，默认 50"),
        max_chars: z.number().int().min(100).max(300000).optional().describe("最多返回字符数，默认 100000"),
      },
      handler: (args: {
        path: string;
        sheet?: string;
        range?: string;
        max_pages?: number;
        page_start?: number;
        pdf_mode?: "text" | "layout";
        reader?: "auto" | "native" | "genoffice";
        docx_mode?: "text" | "structure";
        block_start?: number;
        max_blocks?: number;
        slide_start?: number;
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
          pageStart: args.page_start,
          pdfMode: args.pdf_mode,
          reader: args.reader,
          docxMode: args.docx_mode,
          blockStart: args.block_start,
          maxBlocks: args.max_blocks,
          slideStart: args.slide_start,
          maxSlides: args.max_slides,
          maxRows: args.max_rows,
          maxCols: args.max_cols,
          maxChars: args.max_chars,
        })),
    },

    {
      name: "agent_render_pdf_page",
      description:
        "通过 GenOffice 自带 PDFium 渲染 PDF 页面 PNG（优先）并返回 MCP image block；GenOffice 不可用时兼容使用本机 PyMuPDF JPEG。" +
        "页码从 1 开始；输出 ≤6 MiB / 最大边 ≤2000px，不执行 OCR；PNG 仅写入系统临时目录并在本次调用后删除，不更改用户 PDF。" +
        "可用 renderer=genoffice/native 显式选择；无视觉输入的客户端不能看到页面内容。",
      inputSchema: {
        path: z.string().min(1).describe("PDF 文件路径"),
        page: z.number().int().min(1).describe("页码，从 1 开始"),
        max_dimension: z.number().int().min(400).max(2000).optional().describe("最大边像素，默认 1400"),
        renderer: z.enum(["auto", "genoffice", "native"]).optional().describe("渲染引擎：auto=GenOffice PDFium 优先(默认)，genoffice=不回退，native=仅 Python PyMuPDF"),
      },
      handler: async (args: { path: string; page: number; max_dimension?: number; renderer?: "auto" | "genoffice" | "native" }, ctx) => {
        try {
          const abs = pOfRead(ctx, args.path, "read");
          const rendered = await renderPdfPage({ abs, page: args.page, maxDimension: args.max_dimension, renderer: args.renderer });
          return image(rendered.base64, rendered.mime,
            `[PDF 第 ${args.page}${rendered.pageCount === null ? "" : "/" + rendered.pageCount} 页；${rendered.width}×${rendered.height}px；${rendered.mime}] 实际页面图像；未执行 OCR；无视觉输入则不能凭尺寸猜测内容。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },

    {
      name: "agent_read_image",
      description:
        "读取本地 PNG/JPEG/GIF/WebP，并按 MCP 标准 image content block 返回给支持视觉输入的客户端/模型。" +
        "最大 8MB；相对路径按会话工作目录解析。" +
        "⚠️ **只有能读图的模型才看得到内容** —— 无视觉的模型收到的是一个尺寸占位，" +
        "这时不要凭文件名／大小编造画面。" +
        "**读不到画面时带 `describe: true` 再读一次**:如果用户配了「视觉中继模型」," +
        "这张图会交给那个有视觉的模型转述成**文字描述**返回给你(报告 D10:让无视觉的模型也能知道图里有什么)。" +
        "没配中继模型时它会如实说「未配置」,那就改用文件路径交给能看到它的步骤或用户。",
      inputSchema: {
        path: z.string().min(1).describe("图片路径（PNG/JPEG/GIF/WebP）"),
        describe: z
          .boolean()
          .optional()
          .describe(
            "读不到画面时传 true:把图交给用户配的「视觉中继模型」,返回它的文字描述(无视觉的模型靠这个知道图里有什么)。" +
              "能读图的模型不必传(直接就看到 content block 里的图了)。",
          ),
      },
      handler: async (args: { path: string; describe?: boolean }, ctx) => {
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
          const name = path.basename(abs);

          // **视觉中继**(报告 D10 / Q1):`describe: true` = 调用方明说"我读不到画面",
          // 把图交给用户挑定的、有视觉的模型转述成文字。只读、不落盘、不改任何东西 ——
          // 与这个工具其余部分同档。**公网那条通路不给这个 dep**(没有审批闸门,不该再
          // 让拿到链接的人借用户的模型额度):`ctx.audience === "public"` 时直接跳过。
          if (args.describe === true && deps.describeImage && ctx.audience !== "public") {
            const relay = await deps.describeImage({
              imageBase64: data.toString("base64"),
              mimeType: mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              source: name,
            });
            if (relay.ok) {
              return text(
                `[image ${name} ${st.size} B,${mime}] — 以下是「视觉中继模型」(${relay.model})对这张图的转述:\n\n${relay.text}`,
              );
            }
            // 中继失败**不静默** —— 如实说,并说明退路(交给用户 / 有视觉的步骤)。
            return text(
              `[image ${name} ${st.size} B,${mime}] — 视觉中继没能给出描述:${relay.error}\n` +
                "这张图我这里读不到内容(我所在的模型没有视觉输入)。" +
                "可以改用文件路径交给能看到它的步骤或用户,不要凭文件名或大小编造画面。",
            );
          }

          // 没要求中继(或那条路不可用):照旧返回**原样**的 MCP image block。caption 里
          // 那句"请求中继"的话只在**真的配了中继**时才出现 —— 否则会指引模型去走一条
          // 走不通的路,等于又骗它一次。
          const relayHint =
            deps.visionRelayConfigured?.() === true && ctx.audience !== "public"
              ? "读不到画面的话,带 describe: true 再读一次,会返回这张图的文字描述。"
              : "改用文件路径让能看到它的步骤或用户来处理。";
          return image(
            data.toString("base64"),
            mime,
            // **caption 要如实说明"看不看得见"取决于读者**(报告 D10)。图片是**原样**
            // 交出去的(标准 MCP image block),但**能不能读懂**由读它的模型决定:没有
            // 视觉输入的模型收到的只是一块它读不出内容的字节,而它自己**无法分辨**
            // "这图是空的"和"我没长眼睛"。从前 caption 只有 `[image x.png 247369 B]`
            // —— 看着像一句成功回执,于是模型照着自己编,用户拿到的是编出来的描述。
            // 这段话说清三件事:文件名/大小(给有视觉的模型当定位)、**这块图必须真的
            // 被看见才算读到**、看不到就**明说看不到**,并从文件本身另找办法。**不假装
            // 成功**,同 `@contracts/outputConstraint` 那条"查不了就说查不了"。
            `[image ${name} ${st.size} B,${mime}]` +
              " — 这是一张图片;**只有能读图的模型才看得到内容**。" +
              "如果你读不到画面(收到的是尺寸而不是图像),不要凭文件名或大小编造它画了什么:" +
              relayHint,
          );
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
        "父目录不存在会自动创建。改已有文件优先用 agent_edit_file(只动需要改的那几处)。" +
        "可带读取时的 expected_sha256 做乐观并发校验:文件已被别人改过则拒绝覆盖,本次内容另存为同目录冲突副本。",
      inputSchema: {
        path: z.string().min(1).describe("目标文件路径"),
        content: z.string().describe("要写入的完整内容"),
        append: z.boolean().optional().describe("true = 追加到文件末尾而不是覆盖,默认覆盖"),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("上次读取的 sha256；变化则不写入"),
      },
      handler: (args: { path: string; content: string; append?: boolean; expected_sha256?: string }, ctx) =>
        attempt(async () => {
          const abs = pOf(ctx, args.path);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          // 【MC-024】写整文件也要跨进程互斥(从前只有进程内 Map;另一个 Mcode 实例
          // 或外部编辑器并发写同一路径会丢更新)。
          return withAgentTextFileLease(abs, async (real) => {
            // 【MC-024】与桌面 `file.writeFile` 的 `expectedVersion` 同一判据:给了上次
            // 读取的哈希就在**租约内**重读比对;不一致(或文件已不存在)则拒绝覆盖,
            // 并把**本次要写的内容**另存为同目录冲突副本(共享 `@main/lib/conflictCopy.ts`)。
            // 副本内容 = 这次尝试本该让文件变成的样子:覆盖 = content 原文;追加 = 盘上
            // 当前内容 + content(保住"追加这段"的意图)。副本写失败不改变冲突结论,
            // 只是错误消息里没有路径(不谎报)。
            if (args.expected_sha256) {
              const current = await fs.readFile(real).catch(() => null);
              if (!current || textFileHash(current) !== args.expected_sha256.toLowerCase()) {
                const intended = args.append && current ? Buffer.concat([current, Buffer.from(args.content, "utf8")]).toString("utf8") : args.content;
                const conflictPath = await writeConflictCopy(real, intended).catch(() => null);
                const saved = conflictPath
                  ? `；本次要写入的内容已另存为冲突副本:${conflictPath} / This attempt was saved to a conflict copy`
                  : "";
                throw new Error(`文件版本已变化，本次不写入；请重新读取 / File version changed${saved}`);
              }
            }
            await fs.writeFile(real, args.content, { flag: args.append ? "a" : "w" });
            return `已${args.append ? "追加" : "写入"} ${abs}(${args.content.length} 字符)`;
          });
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
          // 【MC-024】整段读-改-写放进**宿主级**租约:两个 Mcode 实例(或 + 外部编辑器)
          // 并发编辑同一物理路径时,后来者要么排在后面(看到新版本),要么校验冲突被拒 ——
          // 不再出现"A 的修改被 B 静默覆盖"。
          return withAgentTextFileLease(target, async (abs) => {
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
          if (args.expected_sha256 && textFileHash(buf) !== args.expected_sha256.toLowerCase()) {
            // 【MC-024】同一判据的第二处(桌面 FILE_WRITE 是第一处):拒绝覆盖,但**本次
            // 要写的内容不能随请求对象丢掉**。把模型这次的编辑应用到**当前盘上内容**
            // (那是它本来会写出的完整新文件)另存为同目录冲突副本,路径原样写进错误消息
            // —— attempt() 会把它转成 isError 回包,模型/用户都看得到。
            // 盘上内容已非文本、或 old_string 在新内容里已对不上时无从重放,则不产出
            // 副本、也不谎报路径(与 ipc/files.ts 的副本失败语义一致)。
            const current = buf.toString("utf-8");
            const conflictPath = isBinary(buf)
              ? null
              : await (async () => {
                  try { return await writeConflictCopy(abs, applyTextEdits(current, edits).content); }
                  catch { return null; }
                })();
            const saved = conflictPath
              ? `；本次要写入的内容已另存为冲突副本:${conflictPath} / This attempt was saved to a conflict copy`
              : "";
            throw new Error(`文件版本已变化，本次不写入；请重新读取 / File version changed${saved}`);
          }
          if (isBinary(buf)) throw new Error(`看起来是二进制文件,改不了:${abs}`);
          const result = applyTextEdits(buf.toString("utf-8"), edits);
          const content = result.content;
          const touched = result.touched;
          const replaced = result.replaced;
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
        "移动或重命名文件/目录。默认不覆盖已有目标；overwrite=true 时才允许替换目标(替换前会先把旧目标存到同目录备份,只有新内容确认就位才清理)。" +
        "源与目标相同为 no-op；把目录移动到它自己的子目录会被拒绝。所有分支都返回结构化结果,失败不会静默丢数据。属于文件修改操作。",
      inputSchema: {
        source: z.string().min(1).describe("原路径"),
        destination: z.string().min(1).describe("目标路径"),
        overwrite: z.boolean().optional().describe("目标已存在时是否覆盖，默认 false"),
      },
      outputSchema: {
        committed: z.boolean().describe("内容是否已稳定提交到目标(部分完成也算 true —— 目标确实有内容)"),
        sourcePreserved: z.boolean().describe("结束后原路径是否仍在"),
        destinationPreserved: z.boolean().describe("目标处是否仍有有效内容"),
        recoverable: z.boolean().describe("是否留下需人工处理的备份/残留"),
        phase: z
          .enum(["PREPARED", "DEST_CREATED", "SOURCE_REMOVED", "COMMITTED", "PARTIALLY_APPLIED", "UNCERTAIN"])
          .describe("生命周期阶段；COMMITTED 才算完全成功,PARTIALLY_APPLIED/UNCERTAIN 有可见副作用、需人工确认"),
        commitOutcome: z
          .enum(["DURABLE", "APPLIED_NOT_DURABLE", "FAILED"])
          .describe("与 ARC-005 对齐的三态；只有 DURABLE 可对外宣布移动成功"),
        backupRef: z.string().optional().describe("需人工恢复时的备份路径"),
        reason: z.string().optional().describe("稳定原因码（SAME_SOURCE_DESTINATION / DESTINATION_INSIDE_SOURCE / UNCERTAIN 等）"),
        operationId: z.string().describe("本次操作的唯一 id"),
      },
      handler: (args: { source: string; destination: string; overwrite?: boolean }, ctx) =>
        attemptStructured(async () => {
          const source = pOf(ctx, args.source);
          const destination = pOf(ctx, args.destination);
          // 安全移动协议(预检 → 暂存旧目标 → 提交 → 失败恢复)只有一份,见 moveFileSafe。
          const r = await moveFileSafe(source, destination, { overwrite: args.overwrite === true });
          const fields: Record<string, unknown> = {
            committed: r.committed,
            sourcePreserved: r.sourcePreserved,
            destinationPreserved: r.destinationPreserved,
            recoverable: r.recoverable,
            phase: r.phase,
            commitOutcome: r.commitOutcome,
            operationId: r.operationId,
          };
          if (r.backupRef) fields.backupRef = r.backupRef;
          if (r.reason) fields.reason = r.reason;
          // 成功 = 内容已稳定 durable 且没有需要人工收拾的残留(源/目标相同这类 no-op 也算成功)。
          // 部分完成(PARTIALLY_APPLIED)、不确定(UNCERTAIN)走 isError,但结构化字段照带 —— 调用者
          // 能据此看出「目标其实已经出现了」,不会误当完全没发生而重跑。
          const ok = isMoveDurable(r);
          return { text: r.message, structured: fields, isError: !ok };
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
          // 【MC-027】起点 stat 失败(EACCES/EPERM/ENOENT…)从前落进 `emptyWalk()` —— 回一个
          // `count: 0, partial: false` 的「完整无命中」,模型据此断言"不存在"。起点根本
          // 没搜过,不能算完整;与 agent_grep 的「路径不存在」同一条口径显式报错。
          const st = await fs.stat(base).catch((err: unknown) => err as NodeJS.ErrnoException);
          if (st instanceof Error) {
            throw new Error(
              st.code === "ENOENT"
                ? `路径不存在:${base}`
                : `搜索起点不可读:${base}(${walkErrnoText(st)})`,
            );
          }
          // 起点不是目录(比如误传了一个文件):同样什么都没搜,不能报「完整无命中」。
          if (!st.isDirectory()) throw new Error(`搜索起点不是目录:${base}`);
          const re = globToRegExp(rest);
          const found = await walkFiles(base, {
            canRead: canRead(ctx),
            relFilter: re,
            includeHidden: args.include_hidden ?? globWantsHidden(args.pattern),
            maxHits: 2000,
          });
          const rels = found.hits.map((h) => shownPath(ctx, h.abs));
          if (rels.length === 0) {
            const hint = !args.pattern.includes("/") && !args.pattern.includes("**")
              ? `;\`*\` 不跨目录,要递归找请用 \`**/${args.pattern}\``
              : "";
            return {
              text: `没有匹配「${args.pattern}」的文件(从 ${base} 搜起${found.truncated ? ",目录太大没搜完,请缩小起点" : ""})${hint}${walkSkipText(found, true)}`,
              // 空结果也要给结构化 —— 模型靠 `count === 0` 判断"真没有,换个模式"，
              // 而不是从人话里读"没有匹配"。
              structured: { count: 0, files: [], truncated: found.truncated, base, ...walkSkipFields(found) },
            };
          }
          const shown = rels.slice(0, 500);
          const truncated = found.truncated || rels.length > 500;
          const tail = truncated
            ? `\n…(${found.truncated ? `至少 ${rels.length} 个` : `共 ${rels.length} 个`},只列前 ${shown.length} 个,请收窄模式或起点)`
            : "";
          return {
            text: `匹配 ${found.truncated ? "≥" : ""}${rels.length} 个:\n${shown.map((r) => `- ${r}`).join("\n")}${tail}${walkSkipText(found, false)}`,
            structured: { count: rels.length, files: shown, truncated, base, ...walkSkipFields(found) },
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
          // 【MC-027】遍历漏搜(readdir 失败 / 深度上限)与随后单个文件 readFile 失败记进**同一份**,
          // 好让「完整无命中」与「不完整无命中」分开。目录根的相对路径出 root 本身。
          const skips = st.isFile() ? createWalkSkips(path.dirname(base)) : createWalkSkips(base);
          const walked = st.isFile()
            ? { hits: [{ abs: base, rel: path.basename(base), isDir: false }], truncated: false }
            : await walkFiles(base, {
                canRead: canRead(ctx),
                nameFilter: include,
                includeHidden: args.include_hidden ?? false,
                maxHits: MAX_GREP_FILES,
                skips,
              });

          const cap = args.max_results ?? 100;
          const lines: string[] = [];
          let scanned = 0;
          let lineTruncated = false;
          for (const t of walked.hits) {
            if (lines.length >= cap) break;
            const size = (await fs.stat(t.abs).catch(() => null))?.size ?? 0;
            if (size > MAX_GREP_FILE_BYTES) {
              // 【MC-027】超过单文件大小上限是**主动预算**决策,但这个文件确实没搜过 ——
              // 从前静默 `continue`,「0 命中」照样报成完整。现在登记为漏搜,与 readFile
              // 失败同一条口径(同族 `agent_search_*` 的 budgetExhausted)。
              skips.record(t.abs, `超过单文件大小上限(${MAX_GREP_FILE_BYTES} 字节)`);
              continue;
            }
            let buf: Buffer | null = null;
            try {
              buf = await fs.readFile(t.abs);
            } catch (err) {
              // 【MC-027】文件打不开(EACCES/EPERM/占用…)。从前 `catch { null }` 当没命中 ——
              // 目标文本恰在这文件里就报成"不存在"。现在如实登记,不抛。
              skips.record(t.abs, walkErrnoText(err));
              continue;
            }
            if (isBinary(buf)) continue;
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
          const walkedResult: WalkResult = { ...walked, ...skips.snapshot() };
          const unfinished = walked.truncated
            ? `\n…(文件太多,只扫了前 ${walked.hits.length} 个;请缩小 path 或加 glob)`
            : "";
          if (lines.length === 0) {
            return {
              text: `${note}没有匹配「${args.pattern}」的内容(扫了 ${scanned} 个文件)${unfinished}${walkSkipText(walkedResult, true)}`,
              structured: { count: 0, matches: [], scanned_files: scanned, truncated: walked.truncated, ...walkSkipFields(walkedResult) },
            };
          }
          const hitCap = lines.length >= cap;
          return {
            text:
              note +
              lines.join("\n") +
              (hitCap ? `\n…(达到上限 ${cap} 行,可能没搜完)` : "") +
              unfinished +
              walkSkipText(walkedResult, false),
            structured: {
              count: lines.length,
              line_truncated: lineTruncated,
              matches: lines,
              scanned_files: scanned,
              truncated: hitCap || walked.truncated,
              ...walkSkipFields(walkedResult),
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
            ownerSessionId: ownerOf(ctx),
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
          ownerSessionId: ownerOf(ctx),
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
        attempt(async () => formatSearchResult(agentSearches.stop(ownerOf(ctx), args.search_id))),
    },

    {
      name: "agent_search_list",
      description: "列出当前对话的后台搜索会话、状态、结果数量和扫描文件数。",
      inputSchema: {},
      handler: (_args: Record<string, never>, ctx) =>
        attempt(async () => {
          const list = agentSearches.list(ownerOf(ctx));
          if (list.length === 0) return "当前对话没有搜索会话";
          return list.map((s) =>
            `${s.searchId}\t${s.status}\t${s.type}\tresults=${s.totalResults}\tscanned=${s.scannedFiles}${s.partial ? `\tpartial=true(${s.skippedCount} 处没搜到)` : ""}\t${s.pattern}\t${s.root}`,
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
              // ⚠️ **公网 fail closed**(MC-062):拿不到有效根就不执行,绝不回退不受限。
              try { requirePublicRoot(ctx); } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
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
          // ⚠️ 公网 fail closed(MC-062):没有有效根就不启动,绝不回退不受限。
          requirePublicRoot(ctx);
          const sandbox = sandboxOf(ctx);
          const cwd = resolveAgainstCwd(sandbox ?? cwdOf(ctx), args.cwd ?? ".", sandbox);
          // 【公网专项台账 §7.3】与 `agent_bash` 同一道**防误操作**写目标检查 —— 这两条
          // 是**同等可执行**的启动命令工具,却只有 bash 那条查重定向目标,process_start
          // 会直接 `args.command` 交给 `agentProcesses.start`。补上同一道(同样复用
          // `extractBashWriteTargets`,不写第二份解析器)。
          //
          // ⚠️ **这不是沙箱** —— 见 `sandboxBashWriteDenial` 的文件头与 bash 那条一样的
          // 声明:静态扫描 `>`/`>>`/`tee`/`dd of=`/`sed -i`,挡的是"顺手往沙箱外写个文件"
          // 这类**无意的**越界;stdin(`agent_process_write` 发任意字节)、变量展开、解释器
          // 任意 IO 都无法靠词法保证 —— 那要靠能力 scope + OS 隔离,不在这里假装做到。
          if (sandbox) {
            const denial = sandboxBashWriteDenial(args.command, sandbox);
            if (denial) throw new Error(denial);
          }
          const out = await agentProcesses.start({
            ownerSessionId: ownerOf(ctx),
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
            const items = agentProcesses.list(ownerOf(ctx));
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
            ownerSessionId: ownerOf(ctx),
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
          const list = agentProcesses.list(ownerOf(ctx));
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
            ownerSessionId: ownerOf(ctx),
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
            ownerSessionId: ownerOf(ctx),
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
        host_key_pending_confirmation: z.boolean().optional(),
        host_key_candidate_fingerprint: z.string().nullable().optional(),
        host_key_expected_ungranted: z.boolean().optional(),
      },
      description:
        "连接已由 AI 与用户明确配置的 SSH 目标。必须给出实际 host、username，并且只选 private_key_path / agent_path / password 一种认证。" +
        "工具不扫描密钥、不读取或修改 ~/.ssh/config、不生成密钥、不启动 agent，也不代办 MFA/解锁等交互；需用户操作时先请求用户完成。" +
        "**首次连接到未知主机**时不会自动信任：本次连接停在待确认状态并返回待独立核对的主机指纹(host_key_candidate_fingerprint)。" +
        "把该指纹填进 expected_fingerprint 重连**不算批准** —— 缺少宿主(受信 UI/事前用户授权)签发的主机信任授权时一律被拒(host_key_expected_ungranted)，" +
        "因为仅凭连接参数无法证明用户真的带外核对过。请让用户在受信入口确认该指纹；未获宿主批准前不记录信任、不发送任何凭据。" +
        "网络断开后可以重连同一配置；认证失败不重试。敏感凭据仅用于本机连接，不写入工具返回。",
      inputSchema: {
        host: z.string().min(1).describe("已确认的 SSH 主机/IP，不自动展开 SSH Host 别名"),
        port: z.number().int().min(1).max(65535).optional().describe("明确的 SSH 端口，默认 22"),
        username: z.string().min(1).describe("已确认的 SSH 用户名"),
        password: z.string().min(1).optional().describe("明确提供的密码；不要要求用户在公开聊天里粘贴秘密"),
        private_key_path: z.string().min(1).optional().describe("已确认的本机私钥路径；不搜索其他私钥"),
        agent_path: z.string().min(1).optional().describe("已配置 SSH agent 的 socket 或 Windows 命名管道；由调用者明确指定，不自动探测"),
        passphrase: z.string().optional().describe("指定私钥的口令；需要交互解锁时先由用户完成"),
        expected_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/).optional().describe(
          "调用方希望**展示给用户核对**的候选主机公钥指纹(OpenSSH SHA256: 形状)。它**不是**批准凭据：缺少宿主签发的主机信任授权时一律拒绝，不会因为填了它就记录信任",
        ),
        keepalive_interval_ms: z.number().int().min(5000).max(60000).optional().describe("SSH keepalive 间隔，默认 15000"),
        keepalive_count_max: z.number().int().min(1).max(12).optional().describe("连续多少次 keepalive 无响应才判定断线，默认 4"),
        ready_timeout_ms: z.number().int().min(5000).max(60000).optional().describe("单次握手超时，默认 20000"),
      },
      handler: (args: {
        host: string; port?: number; username: string; password?: string; private_key_path?: string; agent_path?: string;
        passphrase?: string; expected_fingerprint?: string; keepalive_interval_ms?: number; keepalive_count_max?: number; ready_timeout_ms?: number;
      }, ctx) => attemptStructured(async () => {
        const info = await agentRemoteSsh.connect({
          ownerSessionId: ownerOf(ctx),
          host: args.host,
          port: args.port,
          username: args.username,
          password: args.password,
          privateKeyPath: args.private_key_path,
          agentPath: args.agent_path,
          passphrase: args.passphrase,
          expectedFingerprint: args.expected_fingerprint,
          keepaliveIntervalMs: args.keepalive_interval_ms,
          keepaliveCountMax: args.keepalive_count_max,
          readyTimeoutMs: args.ready_timeout_ms,
        });
        const note = info.state === "error"
          ? (info.hostKeyExpectedUngranted
            ? "\n首次连接到未知主机：expected_fingerprint 只是请求，不能代替宿主批准；请让用户在受信入口确认该主机指纹"
            : info.hostKeyPendingConfirmation
              ? "\n首次连接到未知主机：请先让用户在受信入口核对并批准上面的主机指纹；未获批准前不会发送任何凭据"
              : "\n请修正明确的连接配置后重试；认证错误不会自动重连")
          : "";
        return { text: formatRemoteConnection(info) + note, isError: info.state !== "ready", structured: {
          connection_id: info.connectionId, state: info.state, host: info.host, port: info.port,
          username: info.username, reconnect_attempt: info.reconnectAttempt, retryable: info.state === "reconnecting", last_error: info.lastError,
          host_key_pending_confirmation: info.hostKeyPendingConfirmation,
          host_key_candidate_fingerprint: info.hostKeyCandidateFingerprint,
          host_key_expected_ungranted: info.hostKeyExpectedUngranted,
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
        if (args.connection_id) return formatRemoteConnection(agentRemoteSsh.status(ownerOf(ctx), args.connection_id));
        const items = agentRemoteSsh.list(ownerOf(ctx));
        return items.length ? items.map(formatRemoteConnection).join("\n\n") : "当前对话没有 SSH 连接";
      }),
    },

    {
      name: "agent_ssh_disconnect",
      description: "主动关闭当前对话自己创建的 SSH 连接并停止自动重连。不会停止服务器上已启动的训练任务。",
      inputSchema: { connection_id: z.string().min(1).describe("要关闭的 connection_id") },
      handler: (args: { connection_id: string }, ctx) => attempt(async () => {
        await agentRemoteSsh.disconnect(ownerOf(ctx), args.connection_id);
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
        const r = await agentRemoteSsh.exec(ownerOf(ctx), args.connection_id, args.command, args.timeout_ms);
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
            ownerSessionId: ownerOf(ctx),
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
          const s = await agentRemoteSsh.jobStatus(ownerOf(ctx), args.connection_id, args.job_id);
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
            ownerSessionId: ownerOf(ctx),
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
        const jobs = await agentRemoteSsh.listJobs(ownerOf(ctx), args.connection_id);
        return jobs.length ? jobs.map((id) => `- ${id}`).join("\n") : "服务器上还没有 mcode remote job";
      }),
    },

    {
      name: "agent_remote_job_cancel",
      description: "取消远程训练任务。优先杀 tmux session / runner 进程组；属于有副作用操作，需要审批。",
      inputSchema: { connection_id: z.string().min(1), job_id: z.string().min(1).max(64) },
      handler: (args: { connection_id: string; job_id: string }, ctx) => attempt(async () =>
        formatRemoteJobStatus(await agentRemoteSsh.cancelJob(ownerOf(ctx), args.connection_id, args.job_id)),
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

/** True if `abs` is inside `root`(或等于)。
 *
 * 【MC-001/MC-006】从前这里是**手抄的一份** pathWithin(纯字面),有两个问题:① 裸
 * `startsWith("..")` 会把合法的 `..config` 当成越界;② 不跟 symlink/junction,工区里的
 * 链接指向外面时字面看着仍在里面。现在统一复用零依赖叶子的 {@link realPathWithin}
 * —— 与 files/git/LSP/快照 是**同一份**实现(仓规:共享实现只有一份)。它只 import
 * node:* ,不会把 files.ts 的依赖链拉进这张表。 */
function pathWithin(root: string, abs: string): boolean {
  return realPathWithin(root, abs);
}

// homedir 目前只被 defaultSkillsRoot 间接覆盖;这里显式引用避免"看起来没用"的 import
// 被误删 —— 技能根的语义就是"用户主目录下的 .mcode/skills"。
void homedir;
