import { join as memoryInstructionPath } from "node:path";
import { ensureMaterialized, instructionsSourcePath } from "@main/lib/appContext.js";
/**
 * Claude Agent SDK provider — wraps `query()` from @anthropic-ai/claude-agent-sdk
 * and implements the AgentProvider interface from @contracts/provider.
 *
 * This replaces the legacy ClaudeRuntime (spawn + NDJSON parse).
 * The SDK bundles its own claude binary, so ClaudePathResolver is no longer needed.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { is } from "@main/utils.js";
import type { Options, CanUseTool, OnUserDialog, OnElicitation, ElicitationRequest, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentProvider,
  StartTurnRequest,
  ProviderContext,
  TurnHandle,
  ProviderCapabilities,
  UserInputAnswers,
  EngineCommandEntry,
} from "@contracts/provider";
import type { AskUserQuestionItem, AskUserQuestionOption, PermissionMode } from "@contracts/runtime";
import { SdkMessageAdapter, parseQuestions } from "./SdkMessageAdapter.js";
import { buildCustomEnv, MCODE_CONFIG_DIR, resolveActiveModel } from "./customEnv.js";
import type { ClaudeContextWindowTag } from "./claudeTokenUsage.js";
import { ASK_SYSTEM_PROMPT } from "@main/lib/askQuestion.js";
import { CLAUDE_IDENTITY_PROMPT, CLAUDE_PLAN_MODE_NUDGE, fileArchitecturePrompt, joinPromptSections } from "@main/lib/systemPrompt.js";
import { turnContextSections } from "@main/providers/contextPrompt.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { scriptsDir } from "@main/workflows/seed.js";
import { log } from "@main/lib/logger.js";
import { bashPathHintFor, detectBashEnv } from "@main/lib/bashEnv.js";
import { getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import {
  FILE_MUTATING_TOOLS,
  getToolFilePath,
  normalizeToolFilePath,
} from "@main/lib/fileSnapshot.js";
// 「库只读」那条硬规则要用它判"落点在不在库里"(见 canUseTool)。
import { isInsideLibrary } from "@main/library/paths.js";
import { resolveSdkBinaryPath } from "./sdkBinaryPath.js";
import { resolveGitBash } from "@main/lib/binaryResolve.js";
import {
  getMcpManagement,
  mcpServersOf,
  parseMcpConfig,
  readUserClaudeJson,
} from "@main/lib/mcpConfig.js";
import { getOutputStyleSetting } from "@main/lib/outputStyleConfig.js";
import { getEnabledPlugins, getPluginMcpServers, getEnabledPluginSkillRoots } from "@main/plugins/pluginManager.js";
import { defaultSkillsRoot, enabledSkillNames, engineEnabled, readEnginesMap, skillNamesInRoot } from "@main/lib/skillEngines.js";
import { readMcpEnginesMap, mcpEngineEnabled } from "@main/lib/mcpEngines.js";
import { resolveSubagentModelValue } from "@main/lib/subagentModel.js";
import { normalizeBashCommand } from "@main/lib/msysPath.js";
import {
  buildStructuredOutputPrompt,
  parseStructuredOutput,
  type StructuredOutputSpec,
} from "@main/lib/structuredOutput.js";
import {
  browserList,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserKeys,
  browserScroll,
  browserWait,
  browserHistory,
  browserSelect,
  browserFind,
  browserSwitchTab,
  browserCloseTab,
  browserUploadFile,
  browserSavePdf,
  browserDownloads,
  browserEvaluate,
  browserScreenshot,
  BROWSER_TOOL_SPECS,
  BROWSER_TOOLS_FLOW,
} from "@main/browser/agentBrowserTools.js";
import {
  buildLibraryMcpServer,
  LIBRARY_MCP_SERVER,
} from "@main/mcp/libraryServer.js";
import {
  buildWorkflowMcpServer,
  WORKFLOW_MCP_SERVER,
} from "@main/mcp/mcodeServer.js";
import {
  buildMemoryMcpServer,
  MEMORY_MCP_SERVER,
} from "@main/mcp/memoryServer.js";
import { buildAppMcpServer } from "@main/mcp/appServer.js";
import { APP_MCP_SERVER } from "@contracts/appControl";
// 审批闸门(哪些工具不用问用户)只有一份 —— 它得与网页端那条通路共用,见该文件头。
import { BROWSER_MCP_SERVER, shouldAutoApprove } from "@main/providers/toolGate.js";
import { loadCreateMcpServer } from "@main/mcp/sdk.js";
import { loadSubagents, subagentsToAgentsRecord } from "@main/claude/subagentStore.js";

// Lazy-load the Agent SDK so the (large) module and its bundled claude binary
// stay out of the main-process startup path. The SDK is only needed once the
// user sends their first message or a health check runs - both happen well
// after the window is visible. Mirrors the node-pty lazy-load pattern in
// TerminalManager.ts.
let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;
async function loadQuery(): Promise<typeof import("@anthropic-ai/claude-agent-sdk").query> {
  if (!queryFn) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = sdk.query;
  }
  return queryFn;
}

// `forkSession` 与 `query` 从同一个模块出来,但**不在启动路径上**(用户右键分叉才会
// 用到),所以单独懒加载 —— 跟着 query 一起预热的话,分叉用不上的人白付一次模块解析。
let forkFn: typeof import("@anthropic-ai/claude-agent-sdk").forkSession | null = null;
async function loadForkSession(): Promise<
  typeof import("@anthropic-ai/claude-agent-sdk").forkSession
> {
  if (!forkFn) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    forkFn = sdk.forkSession;
  }
  return forkFn;
}

/** Anthropic image content-block media-type allowlist — mirrors
 *  SendTurnImageSchema.mimeType (the zod enum already restricts to this set). */
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Promise that resolves when the signal fires (immediately if already
 *  aborted). Used to unblock the prompt iterable's hold on user stop. */
function abortSignalPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A turn-settle gate: the prompt iterable awaits `promise` after yielding the
 *  user message, and the adapter calls `release` once the turn is settled
 *  (result received AND no subagents / background tasks still running). See
 *  buildPromptInput for why the hold exists. */
function makeSettleGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/**
 * 这一轮的**输入通道** —— 一个能往里塞消息的 AsyncIterable(见 {@link makePromptChannel})。
 */
interface PromptChannel {
  /** 交给 SDK 的 `prompt`。 */
  stream: AsyncIterable<SDKUserMessage>;
  /** 塞一条用户消息进去。返回"收下了没有"。 */
  push(text: string): boolean;
}

/** 把一段文字包成 SDK 要的那条用户消息。 */
function userMessage(content: SDKUserMessage["message"]["content"]): SDKUserMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/**
 * Build the SDK `prompt` argument for a turn: an AsyncIterable yielding the
 * user's message (text block + any inline base64 image blocks — the same
 * inline-encoding the Claude Code CLI uses for user-attached images), then
 * HOLDING OPEN until the turn settles.
 *
 * Why the hold: with a plain string (or a one-shot iterable) the SDK closes
 * the CLI's stdin after the first result message (`isSingleUserTurn` /
 * `streamInput` endInput). The CLI process then exits while backgrounded
 * subagents are still running, orphaning them — they keep writing the shared
 * session file, and a turn that resumes in that window reads torn state in
 * which every permission ask dies instantly ("Tool permission request
 * failed: AbortError: Stream closed"; observed with plan-mode sessions,
 * 2026-08-26). Holding stdin open keeps the CLI process alive until the
 * adapter confirms the turn settled, so the session file is complete before
 * the next turn can resume it. The hold races the abort signal so a user
 * stop never deadlocks the iterable.
 *
 * ## 顺带就是"生成过程中插话"那条路
 *
 * 既然 stdin 本来就是开着的,那么**再往里塞一条用户消息**就是 SDK 那边的"异步用户
 * 消息":模型会在下一个安全点看到它,这一轮**不中断**。{@link PromptChannel.push} 就是
 * 塞的动作 —— 用户的原话:「ai 生成的过程中插入」。
 *
 * 三条不能含糊的:
 *
 * 1. **只塞文本。** 图片要重新编码成 base64 内容块,而这条路(IPC → 这里)现在只传
 *    字符串。要支持图片时,**改的是这个函数的入参形状**,不是在这里悄悄忽略掉它们。
 * 2. **这一轮结束之后不能再塞。** 生成器一返回就等于关掉了 stdin,这时推进去的消息
 *    没人读,用户会以为说过了。所以 `push` 在通道关闭后返回 `false`,由调用方决定
 *    怎么兜(见 `RuntimeManager.injectMessage`:兜回普通的发送)。
 * 3. **一条都不丢。** 队列 + 唤醒,而不是"上一次的推送被下一次覆盖"。
 *
 * A new channel + gate is created per call because the transport-retry path
 * needs a replayable source after recreating the query.
 */
function makePromptChannel(
  req: StartTurnRequest,
  gate: { promise: Promise<void> },
  signal: AbortSignal,
): PromptChannel {
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } }
  )[] = [];
  // Image-only turns send no text block (the images still reach the model).
  if (req.prompt.trim()) content.push({ type: "text", text: req.prompt });
  for (const img of req.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mimeType as ImageMediaType, data: img.data },
    });
  }

  const pending: SDKUserMessage[] = [];
  let closed = false;
  /** 生成器正卡在"还有没有新的"上时,由这里把它叫醒。 */
  let wake: (() => void) | null = null;

  const stream = (async function* (): AsyncIterable<SDKUserMessage> {
    yield userMessage(content);
    while (!closed) {
      const next = pending.shift();
      if (next) {
        yield next;
        continue;
      }
      // 三件事里先来哪一件就听哪一件:又塞进来一条 / 这一轮收尾了 / 用户按了停止。
      // 后面两件都要让生成器**返回** —— 返回即关掉 stdin,SDK 那边才收得了尾。
      const reason = await Promise.race([
        new Promise<"push">((resolve) => {
          wake = () => resolve("push");
        }),
        gate.promise.then(() => "gate" as const),
        abortSignalPromise(signal).then(() => "abort" as const),
      ]);
      wake = null;
      if (reason !== "push") {
        closed = true;
        return;
      }
    }
  })();

  return {
    stream,
    push: (text) => {
      // 关掉之后不能再收 —— 收了也没人读(见文件头第 2 条)。
      if (closed || signal.aborted || text.trim().length === 0) return false;
      pending.push(userMessage([{ type: "text", text }]));
      wake?.();
      return true;
    },
  };
}

// `createSdkMcpServer` builds an in-process MCP server that surfaces custom
// tools to the model without spawning a subprocess. The loader lives in
// `@main/mcp/sdk.js` — it's shared with the mcp/ servers themselves (see that
// file for why), and `preloadClaudeSdk` below is what warms it.

/** Warm the Agent SDK module in idle time, well after the window is visible.
 *  The lazy imports above keep the (large) module off the startup path, but
 *  without this the FIRST turn pays the parse cost inline in startTurn,
 *  right on the send→first-reply critical path. A deferred fire-and-forget
 *  import moves it into the gap while the user is still finding their
 *  project / typing their first message. Errors are swallowed — loadQuery()
 *  retries on real first use and surfaces failures through the normal turn
 *  error path. */
export function preloadClaudeSdk(): void {
  setTimeout(() => {
    void loadQuery().catch(() => {});
    void loadCreateMcpServer().catch(() => {});
  }, SDK_PRELOAD_DELAY_MS);
}

/** Delay before the SDK preload fires (see preloadClaudeSdk). Long enough to
 *  stay out of the startup window-creation burst, short enough to finish
 *  before a user realistically sends their first message. */
const SDK_PRELOAD_DELAY_MS = 3_000;

/**
 * Build the in-process MCP server that exposes the `browser_*` tools to
 * Claude (the SDK equivalent of Pi's `pi.registerTool`). Each tool's handler
 * delegates to the shared `agentBrowserTools` implementation so both
 * providers drive the browser identically.
 *
 * Claude surfaces each tool to canUseTool as `mcp__mcode-browser__<name>`;
 * the read-only ones (list/snapshot/screenshot) are auto-approved by
 * `shouldAutoApprove`, while navigate/click go through the normal approval
 * prompt. Screenshots return an image content block that the store parses
 * from the tool_result to render inline.
 */
async function buildBrowserMcpServer(
  projectPath: string,
  ctx: ProviderContext,
  sessionId: string,
  turnNumber?: number,
) {
  const createSdkMcpServer = await loadCreateMcpServer();

  return createSdkMcpServer({
    name: BROWSER_MCP_SERVER,
    version: "1.0.0",
    instructions:
      "Mcode 应用内浏览器控制工具。" + BROWSER_TOOLS_FLOW,
    alwaysLoad: true,
    tools: [
      {
        name: "browser_list",
        description: BROWSER_TOOL_SPECS.browser_list.description,
        inputSchema: {},
        handler: async () => browserList(),
      },
      {
        name: "browser_navigate",
        description: BROWSER_TOOL_SPECS.browser_navigate.description,
        inputSchema: {
          url: z.string().describe("目标 URL,http(s):// 网页或 file:/// 本地文件"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则自动复用当前目标视图或新建"),
          device: z
            .enum(["desktop", "iphone", "android"])
            .optional()
            .describe("打开方式:desktop(PC 全宽,默认)/iphone(移动端)/android(移动端),仅新建视图时生效"),
          newTab: z.boolean().optional().describe("true=强制新开一个标签页再导航"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserNavigate(
            {
              url: args.url as string,
              browserId: args.browserId as string | undefined,
              device: args.device as "desktop" | "iphone" | "android" | undefined,
              newTab: args.newTab === true,
            },
            projectPath,
          ),
      },
      {
        name: "browser_snapshot",
        description: BROWSER_TOOL_SPECS.browser_snapshot.description,
        inputSchema: {
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSnapshot({ browserId: args.browserId as string | undefined }),
      },
      {
        name: "browser_click",
        description: BROWSER_TOOL_SPECS.browser_click.description,
        inputSchema: {
          index: z.number().optional().describe("要点击元素的索引(来自最近一次 browser_snapshot 的 [n]),优先使用"),
          selector: z.string().optional().describe("要点击元素的 CSS selector(index 的替代写法)"),
          coordinateX: z.number().optional().describe("视口坐标点击的 X(canvas 等无 selector 元素用)"),
          coordinateY: z.number().optional().describe("视口坐标点击的 Y"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserClick({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            coordinateX: typeof args.coordinateX === "number" ? args.coordinateX : undefined,
            coordinateY: typeof args.coordinateY === "number" ? args.coordinateY : undefined,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_type",
        description: BROWSER_TOOL_SPECS.browser_type.description,
        inputSchema: {
          index: z.number().optional().describe("目标输入元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe("目标输入元素的 CSS selector(index 的替代写法)"),
          text: z.string().describe("要输入的文本内容;空串=清空字段"),
          clear: z.boolean().optional().describe("true(默认)=清空后输入;false=追加到现有内容之后"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserType({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : "",
            clear: args.clear !== false,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_keys",
        description: BROWSER_TOOL_SPECS.browser_keys.description,
        inputSchema: {
          keys: z.string().describe('按键或组合键,如 "Enter" / "Escape" / "Tab" / "ArrowDown" / "Control+a" / "Shift+Enter"'),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserKeys({
            keys: typeof args.keys === "string" ? args.keys : "",
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_scroll",
        description: BROWSER_TOOL_SPECS.browser_scroll.description,
        inputSchema: {
          direction: z.enum(["up", "down"]).describe("滚动方向"),
          pages: z.number().optional().describe("滚动量(单位=视口高,默认 1;10≈滚到底)"),
          selector: z.string().optional().describe("改为滚动该元素内部的滚动区"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserScroll({
            direction: args.direction === "up" ? "up" : "down",
            pages: typeof args.pages === "number" ? args.pages : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_wait",
        description: BROWSER_TOOL_SPECS.browser_wait.description,
        inputSchema: {
          selector: z.string().optional().describe("等待该 CSS selector 元素出现"),
          text: z.string().optional().describe("等待该文本出现在页面中"),
          seconds: z.number().optional().describe("固定等待秒数"),
          timeoutSeconds: z.number().optional().describe("等待超时(默认 10,上限 30)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserWait({
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            seconds: typeof args.seconds === "number" ? args.seconds : undefined,
            timeoutSeconds: typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_history",
        description: BROWSER_TOOL_SPECS.browser_history.description,
        inputSchema: {
          action: z.enum(["back", "forward", "reload"]).describe("后退/前进/刷新"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserHistory({
            action: args.action as "back" | "forward" | "reload",
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_select",
        description: BROWSER_TOOL_SPECS.browser_select.description,
        inputSchema: {
          index: z.number().optional().describe("下拉框元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe("下拉框元素的 CSS selector(index 的替代写法)"),
          value: z.string().describe("选项的 value 或精确可见文本"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSelect({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            value: typeof args.value === "string" ? args.value : "",
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_find",
        description: BROWSER_TOOL_SPECS.browser_find.description,
        inputSchema: {
          selector: z.string().optional().describe("按 CSS 查询元素(与 text 二选一)"),
          text: z.string().optional().describe("在页面文本中搜索(与 selector 二选一)"),
          regex: z.boolean().optional().describe("text 按正则解释(默认字面)"),
          caseSensitive: z.boolean().optional().describe("区分大小写(默认不区分)"),
          contextChars: z.number().optional().describe("文本匹配的上下文字符数(默认 150)"),
          maxResults: z.number().optional().describe("最多返回条数(默认 25)"),
          attributes: z.array(z.string()).optional().describe('selector 模式下要提取的属性,如 ["href","src"]'),
          cssScope: z.string().optional().describe("把查找范围限定在该 CSS selector 内"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserFind({
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            regex: args.regex === true,
            caseSensitive: args.caseSensitive === true,
            contextChars: typeof args.contextChars === "number" ? args.contextChars : undefined,
            maxResults: typeof args.maxResults === "number" ? args.maxResults : undefined,
            attributes: Array.isArray(args.attributes) ? (args.attributes as unknown[]).filter((a): a is string => typeof a === "string") : undefined,
            cssScope: typeof args.cssScope === "string" ? args.cssScope : undefined,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_switch_tab",
        description: BROWSER_TOOL_SPECS.browser_switch_tab.description,
        inputSchema: {
          browserId: z.string().describe("要切换到的浏览器视图 id(browser_list 查询)"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSwitchTab({ browserId: args.browserId as string }),
      },
      {
        name: "browser_close_tab",
        description: BROWSER_TOOL_SPECS.browser_close_tab.description,
        inputSchema: {
          browserId: z.string().describe("要关闭的浏览器视图 id"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserCloseTab({ browserId: args.browserId as string }),
      },
      {
        name: "browser_upload_file",
        description: BROWSER_TOOL_SPECS.browser_upload_file.description,
        inputSchema: {
          index: z.number().optional().describe("文件输入框元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe('文件输入框元素的 CSS selector(index 的替代写法)'),
          paths: z.array(z.string()).describe("要上传的本地文件路径数组(绝对路径,或相对项目根的路径)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserUploadFile(
            {
              index: typeof args.index === "number" ? args.index : undefined,
              selector: typeof args.selector === "string" ? args.selector : undefined,
              paths: args.paths,
              browserId: args.browserId as string | undefined,
            },
            projectPath,
          ),
      },
      {
        name: "browser_save_pdf",
        description: BROWSER_TOOL_SPECS.browser_save_pdf.description,
        inputSchema: {
          fileName: z.string().optional().describe("保存的文件名(不含路径;省略则按时间戳命名)"),
          paperFormat: z.enum(["letter", "legal", "tabloid", "a3", "a4", "a5"]).optional().describe("纸张格式,默认 a4"),
          landscape: z.boolean().optional().describe("横向(默认纵向)"),
          printBackground: z.boolean().optional().describe("是否打印背景色/图(默认 true)"),
          scale: z.number().optional().describe("缩放 0.1-2(默认 1)"),
          headerFooter: z.boolean().optional().describe("显示页眉页脚(默认 false)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSavePdf(
            {
              fileName: typeof args.fileName === "string" ? args.fileName : undefined,
              paperFormat: typeof args.paperFormat === "string" ? args.paperFormat : undefined,
              landscape: args.landscape === true,
              printBackground: args.printBackground !== false,
              scale: typeof args.scale === "number" ? args.scale : undefined,
              headerFooter: args.headerFooter === true,
              browserId: args.browserId as string | undefined,
            },
            {
              toolCallId: randomUUID(),
              sessionId,
              turnNumber,
            },
          ),
      },
      {
        name: "browser_downloads",
        description: BROWSER_TOOL_SPECS.browser_downloads.description,
        inputSchema: {},
        handler: async () => browserDownloads(),
      },
      {
        name: "browser_evaluate",
        description: BROWSER_TOOL_SPECS.browser_evaluate.description,
        inputSchema: {
          script: z.string().describe("要在页面中执行的 JavaScript 代码(可访问 document/window 等页面对象)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserEvaluate({
            script: args.script as string,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_screenshot",
        description: BROWSER_TOOL_SPECS.browser_screenshot.description,
        inputSchema: {
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
          fullPage: z.boolean().optional().describe("true=截整页(含滚动外内容)"),
        },
        handler: async (args: Record<string, unknown>) => {
          // The returned image content block flows back to the model via the
          // SDK and is also surfaced to the user: the claude binary round-
          // trips the tool_result content (including the image) back as a user
          // message, which SdkMessageAdapter transparently forwards as a
          // ToolResultEvent; the store then extracts the image (in Anthropic
          // {source:{data,media_type}} or MCP {data,mimeType} form) and
          // attaches an inline image block. No separate browser.image emit is
          // needed here — unlike the Pi path, the toolCallId isn't available
          // in the MCP handler's extra, so we rely solely on the tool_result.
          return browserScreenshot(
            { browserId: args.browserId as string | undefined, fullPage: args.fullPage === true },
            {
              toolCallId: randomUUID(),
              sessionId,
              turnNumber,
            },
          );
        },
      },
    ],
  });
}

/**
 * 按名字清单筛一组带 `name` 的东西 —— **空/缺席 = 不限制,原样返回**。
 *
 * 三个"可选的东西"(技能 / MCP 服务器 / 插件)共用这一条读法:不填就是"全都给",
 * 填了才是"只要这几个"。所以这里必须是"没要求就不动",而不是"没要求就一个都不给"
 * —— 后者会让每一个没填过这个参数的旧节点突然失去全部插件。
 *
 * 名字对不上的项**静默丢掉**:插件可能在别的机器上没装(Mcode 的工作流是要能分享的),
 * 那种情况该表现为"这个插件不生效",而不是整轮起不来。
 */
function narrowByName<T extends { name: string }>(items: T[], names: string[] | undefined): T[] {
  if (!names || names.length === 0) return items;
  const allow = new Set(names);
  return items.filter((item) => allow.has(item.name));
}

/**
 * claude 的 `Options.skills` 值（无 composer 显式点选时的默认态）。
 *
 * - 矩阵对该引擎**无限制** → "all"（现状：引擎自己全量发现，含 CLAUDE_CONFIG_DIR
 *   下的用户技能与插件技能）。
 * - 矩阵**有限制** → 显式 allowlist：启用的通用技能名 + 矩阵仍启用的插件技能的
 *   `":name"` 后缀条目。显式列表模式下引擎按 canonical name（`<plugin>:<name>`）
 *   精确匹配或 `":name"` 后缀匹配，所以插件贡献（含内置四件）也要逐个点名才会
 *   加载。插件技能与通用技能共用同一张矩阵 —— 被用户从 claude 收走的插件技能
 *   不进名单，引擎就看不到。
 */
async function claudeSkillsOption(
  pluginNames?: readonly string[],
  allowNames?: readonly string[],
): Promise<Options["skills"]> {
  // A node allowlist narrows the globally enabled set; it must never revive a
  // skill the user disabled for Claude in global management. Unknown names are
  // retained for shareable workflows and builtin/plugin discovery.
  if (allowNames?.length) {
    const enginesMap = readEnginesMap(defaultSkillsRoot());
    return allowNames.filter((name) => engineEnabled(enginesMap, name, "claude"));
  }
  const enabled = enabledSkillNames(defaultSkillsRoot(), "claude");
  if (enabled === null) return "all";
  const enginesMap = readEnginesMap(defaultSkillsRoot());
  const pluginSkillNames = new Set<string>();
  for (const root of await getEnabledPluginSkillRoots(pluginNames, "claude-sdk")) {
    for (const name of skillNamesInRoot(root).keys()) {
      if (engineEnabled(enginesMap, name, "claude")) pluginSkillNames.add(name);
    }
  }
  return [...enabled, ...[...pluginSkillNames].map((n) => `:${n}`)];
}

/** Max provider-level retries for a TRANSPORT failure (stdio break, binary
 *  crash, network timeout). API-level transient errors (429 / overloaded /
 *  5xx) are retried separately by the SDK itself — surfaced via `api_retry`
 *  system messages the adapter now logs — and do NOT consume this budget,
 *  because those end the iterator cleanly with a `result{subtype:"error"}`
 *  rather than throwing. This wrapper only catches the thrown-exception case
 *  the SDK's own retry loop doesn't cover. */
const CLAUDE_MAX_TRANSPORT_RETRIES = 3;

/** Hard cap on the prompt iterable's stdin hold (see buildPromptInput). If
 *  the adapter's settle signal never fires, release the hold after this long
 *  so the turn can still finish — the CLI exits and any straggler background
 *  agents orphan, which is exactly the pre-fix behavior, not a deadlock. */
const PROMPT_SETTLE_FALLBACK_MS = 5 * 60_000;

/** True for a thrown error that warrants a transport-level retry. Covers
 *  stream/stdio breaks, network failures, timeouts, and HTTP 429/5xx that
 *  escape the SDK's retry loop and surface as a thrown exception (possible on
 *  non-Anthropic gateways). AbortError is excluded (it's a user stop, handled
 *  separately). Auth/config errors are excluded (retrying won't help). The
 *  SDK's thrown errors aren't strongly typed, so this is a message-based
 *  heuristic — intentionally permissive on the side of retrying transient-
 *  sounding failures. */
function isRetryableTransportError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return false;
  // User-initiated stop — never retry.
  if (/abort/.test(msg)) return false;
  // Stream / stdio / transport breaks.
  if (/stream closed|stream.*closed|connection|econnreset|socket|hang up|epipe|\bpipe\b|transport/.test(msg)) return true;
  // Timeouts.
  if (/timeout|etimedout|timed out/.test(msg)) return true;
  // Network / DNS / fetch.
  if (/network|enotfound|getaddrinfo|fetch failed|failed to fetch/.test(msg)) return true;
  // EOF / premature close.
  if (/eof|premature|unexpected end|closed before/.test(msg)) return true;
  // HTTP 429 / 5xx that escaped the SDK retry (rare; custom gateways).
  if (/429|rate limit|overloaded|too many requests|5\d{2}|server error|service unavailable|bad gateway|gateway timeout/.test(msg)) return true;
  return false;
}

/** Promise-based sleep that rejects early if the signal aborts, so a user
 *  stop during a retry backoff doesn't wait out the full delay. The rejecting
 *  path is how the retry loop detects an abort mid-backoff and bails out. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** System prompt injected when the environment lacks native AskUserQuestion tool.
 * Now imported from the shared @main/lib/askQuestion module (single source of
 * truth, shared with the Pi provider's before_agent_start extension). */

export class ClaudeAgentSdkProvider implements AgentProvider {
  readonly id = "claude-sdk";
  readonly displayName = "Claude";
  readonly capabilities: ProviderCapabilities = {
    supportsApproval: true,
    supportsResume: true,
    supportsStreaming: true,
    supportsMcp: true,
    supportsAskUserQuestion: true, // optimistic; may be negated at runtime
    // MCP elicitation（服务器要用户输入/授权）：onElicitation 桥接进
    // requestUserInput 弹窗（见 startTurn 里 onElicitation 一段）。
    supportsElicitation: true,
    // 自定义子代理（Settings → 子代理）：startTurn 读 `claude.subagents`
    // 传给 SDK 的 Options.agents（见下面 agents 一段）。
    supportsCustomSubagents: true,
    // 生成过程中可以插话(SDK 那侧是"异步用户消息",见 `makePromptChannel`)。
    supportsInject: true,
    // Claude 的会话文件可以整份复制成新的(SDK 的 `forkSession`),所以"复制一份对话"
    // 在这个提供方上是**真的**带着上下文 —— 见下面 forkSession 的实现。
    supportsFork: true,
    // Declarative descriptors for the renderer's dynamic dropdowns.
    thinkingLevels: [
      { value: "default", label: "Auto", hint: "让 Claude 自选" },
      { value: "low", label: "Low", hint: "最快,少思考" },
      { value: "medium", label: "Med", hint: "平衡" },
      { value: "high", label: "High", hint: "更多思考" },
      { value: "xhigh", label: "XHigh", hint: "深度思考" },
      { value: "max", label: "Max", hint: "最充分,最慢" },
    ],
    permissionModes: [
      { value: "default", label: "Default", icon: "shield", hint: "标准行为,工具按规则触发审批" },
      { value: "acceptEdits", label: "Edit Auto", icon: "shieldCheck", color: "text-warning", hint: "工作目录内的文件编辑自动放行" },
      { value: "plan", label: "Plan", icon: "shieldHalf", color: "text-info", hint: "只读探索,所有写操作都需审批" },
      { value: "bypassPermissions", label: "Bypass", icon: "shieldLock", color: "text-danger", hint: "跳过所有权限检查(慎用)" },
    ],
    builtinModels: [
      { id: "default", label: "Auto", hint: "让 Claude 自选" },
      { id: "sonnet", label: "Sonnet", hint: "claude-sonnet" },
      { id: "opus", label: "Opus", hint: "claude-opus" },
      { id: "fable", label: "Fable", hint: "claude-fable" },
    ],
    supportsCustomEndpoint: true,
  };

  /**
   * 把一段 Claude 会话复制成新的一段(右键对话 → 复制一份)。
   *
   * ## 为什么在**分叉的这一刻**就复制,而不是等新对话的第一次发言
   *
   * SDK 的 `Options.forkSession` 也能做同一件事(配合 `resume`),但那是**每一轮**都要
   * 判断的:新对话的第一次发言要带 `forkSession: true`、之后每次都不带。那个"第一次"
   * 得**存下来**(应用重启后还得知道),而多一个状态就多一处会对不上的地方。
   *
   * 在这里早早复制完,新会话的 `claudeSessionId` 当场就是**它自己的** id —— 之后每一轮
   * 都是一次普通的 resume,执行路径上一行都不用改。
   *
   * ## 复制的是会话**文件**
   *
   * SDK 那份实现会把源会话的转录逐条抄进新文件,并**重新编一遍消息 UUID**(保留
   * parentUuid 链)。所以两边之后各走各的,谁也不会写到对方的文件里去。
   *
   * ⚠️ 已知的一点缺失:**撤销历史(文件快照)不复制**。也就是新对话里"撤销上一轮改动"
   * 对分叉之前的那几轮不生效 —— SDK 就是这么定义的,不是这里漏了。
   */
  async forkSession(providerSessionId: string, opts: { cwd: string; title: string }): Promise<string> {
    const forkSession = await loadForkSession();
    const res = await forkSession(providerSessionId, { dir: opts.cwd, title: opts.title });
    return res.sessionId;
  }

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const ac = new AbortController();

    // UI "Plan" mode → run the CLI under `default` and steer the model into
    // plan mode via the EnterPlanMode tool instead. The CLI's plan
    // permission-mode reliably kills the ExitPlanMode approval round-trip
    // when a turn resumes right after a backgrounded subagent completes
    // (rule-layer instant deny recorded as "Tool permission request failed:
    // AbortError: Stream closed", permission_denials → "Permission denied
    // (ExitPlanMode)"; observed on CLI 2.1.218 AND 2.1.238, 2026-08-26 — the
    // ask never reaches canUseTool/onUserDialog). Under `default` the
    // EnterPlanMode→ExitPlanMode flow is the battle-proven path. Safety is
    // preserved host-side: the ApprovalBridge still sees the config-level
    // "plan" mode, so shouldAutoApprove prompts for every mutating tool.
    const isUiPlanMode = req.permissionMode === "plan";
    // Look up the session's snapshot via the module-scope registry.
    // The runtime creates it lazily on first sendTurn and clears it
    // between turns; the provider only reads. No-op fallbacks if the
    // snapshot is missing (e.g. startTurn called without a preceding
    // sendTurn, which shouldn't happen but we don't want a crash).
    const snapshot = getFileSnapshot(req.sessionId);

    const options: Options = {
      abortController: ac,
      cwd: req.cwd,
      model: req.model && req.model !== "default" ? req.model : undefined,
      // Per-turn reasoning effort. The contract's `EffortLevel` is now an open
      // string (so providers can declare their own levels); the SDK's own
      // `EffortLevel` is a narrow union (low/medium/high/xhigh/max). We collapse
      // "default" to `undefined` (don't pass the option) and cast the rest --
      // only the five named levels reach the wire, validated by the UI's
      // capabilities.thinkingLevels list.
      // See https://platform.claude.com/docs/en/build-with-claude/effort
      effort: req.effort && req.effort !== "default" ? (req.effort as Options["effort"]) : undefined,
      // Permission mode: the contract is an open string; the SDK's type is a
      // narrow union. The UI only offers claude's 4 modes for this provider
      // (declared in capabilities.permissionModes), so the cast is safe. The
      // UI "plan" mode is translated to "default" (see isUiPlanMode above).
      permissionMode: (isUiPlanMode ? "default" : req.permissionMode) as Options["permissionMode"],
      resume: req.resumeProviderSessionId ?? undefined,
      includePartialMessages: true,
      // Forward the subagents' full conversation (text/thinking included, not
      // just tool_use/tool_result) as assistant/user messages carrying the
      // spawning Task tool_use id in `parent_tool_use_id`. The adapter routes
      // those to the per-subagent transcript channel (subagent.transcript)
      // for the side-panel subagent viewer — they never enter the main
      // message stream (see SdkMessageAdapter's parent_tool_use_id guards).
      forwardSubagentText: true,
      // Skills: when the user picked specific skills in the composer, pass them
      // as an explicit allowlist so the model's `Skill` tool can actually reach
      // them. This is REQUIRED because query() runs the bundled binary with
      // `--input-format stream-json`, under which the CLI does NOT re-parse
      // `/name` slash commands from the prompt text — the `/name` literals the
      // composer inlines are display-only and would never trigger the Skill
      // tool on their own. With no picks, the universal library's per-engine
      // matrix decides (claudeSkillsOption): unrestricted → 'all' (the model
      // can still self-discover/autoload skills), restricted → an allowlist of
      // the enabled skills + plugin contributions. Do NOT also add 'Skill' to
      // allowedTools. See sdk.d.ts Options.skills.
      skills: await claudeSkillsOption(req.pluginNames, req.skills),
      // SDK #359: On Windows there is a timing/buffering race in the stdio
      // control-stream transport that causes "Tool permission request failed:
      // AbortError: Tool permission stream closed before response received"
      // for subagent/MCP tools (WebSearch, WebFetch, etc.). Setting debug:true
      // forces synchronous control-channel flushing and eliminates the race.
      // See https://github.com/anthropics/claude-agent-sdk-typescript/issues/359
      debug: process.platform === "win32" ? true : undefined,
      // 轮预算的 native 双保险（host 侧 enforceBudget 是主强制，这里照传）：
      // SDK 在 maxTurns / maxBudgetUsd 触顶时自己收束回合（result 子类型
      // error_max_turns / error_max_budget_usd），比 interrupt 更温和。两个
      // 引擎里只有 Claude 有这两个 native 旋钮；token 上限谁都没有。
      maxTurns: req.budget?.maxTurns,
      maxBudgetUsd: req.budget?.maxUsd,
      // 失败回退链的 native 双保险：SDK 在主模型失败（overload/unavailable）
      // 时自行切到 fallbackModel 重试。host 侧 turn.done error 的整回合换
      // 模型重发（RuntimeManager）是主路径；SDK 只有单槽位，递链首。
      fallbackModel: req.fallbackModels?.[0],
    };

    // 自定义子代理（Settings → 子代理，`claude.subagents`）。每轮现读：编辑
    // 从下一轮生效；空列表不设键（别把 SDK 的 agents 语义搅成"覆盖为空"）。
    // 校验/容错在 subagentStore（坏条目丢弃 + warn，不让一条脏配置弄瘫回合）。
    const subagentDefs = loadSubagents();
    if (subagentDefs.length > 0) {
      options.agents = subagentsToAgentsRecord(subagentDefs);
      ctx.log.info(`claude: ${subagentDefs.length} custom subagent(s) attached (${subagentDefs.map((d) => d.name).join(", ")})`);
    }

    // 结构化输出（StartTurnRequest.structuredOutput）：
    //  - 默认 Anthropic 端点 → SDK 原生 `outputFormat`(json_schema)：CLI 用
    //    end-turn 工具强制 schema，result 消息自带 structured_output 附件，
    //    宿主无需再校验。
    //  - 自定义网关（apiConfig 存在）→ outputFormat 依赖 CLI→网关的透传，
    //    第三方网关不保证支持（风险表对策），降级为提示词注入 + 轮末校验。
    const structuredFallback: StructuredOutputSpec | null = req.structuredOutput
      ? req.apiConfig
        ? req.structuredOutput
        : null
      : null;
    if (req.structuredOutput && !req.apiConfig) {
      options.outputFormat = { type: "json_schema", schema: req.structuredOutput.schema };
    }

    // The runtime binary comes from the managed install
    // (userData/runtimes, downloaded via Settings → Agent Runtimes) or, in
    // dev, from node_modules. Point the SDK at the real on-disk path — the
    // asar-unpacked fallback in sdkBinaryPath.ts only matters for builds that
    // still bundle the platform package. Missing runtime (packaged, not yet
    // downloaded) → friendly error instead of the SDK's cryptic spawn
    // failure. See sdkBinaryPath.ts for the full rationale.
    const binaryPath = resolveSdkBinaryPath();
    if (binaryPath) {
      options.pathToClaudeCodeExecutable = binaryPath;
    } else if (is.prod) {
      throw new Error(
        "Claude 未安装。请到 设置 → Agent 点击安装(Claude is not installed — open Settings → Agent and install it).",
      );
    }

    // Plan files location: the bundled CLI forces the model to write its plan
    // to a file before calling ExitPlanMode (the tool errors with "No plan file
    // found ... Please write your plan to this file before calling ExitPlanMode"
    // if the file is missing). The plan directory is resolved by the CLI from
    // the `plansDirectory` setting (must be within project root), defaulting to
    // ~/.claude/plans/ when unset. Without this, plan files leak into the
    // GLOBAL ~/.claude/plans/ directory instead of staying project-scoped.
    //
    // We set it to ".claude/plans" (relative to cwd = project root) via the
    // flag-settings layer (Options.settings), which has the highest
    // user-controlled priority and applies regardless of `settingSources`.
    // Add ".claude/plans/" to .gitignore to keep these ephemeral drafts out of
    // version control.
    options.settings = { plansDirectory: ".claude/plans" };

    // Always redirect the claude binary's user-level config root to Mcode's
    // own directory (~/.mcode) via CLAUDE_CONFIG_DIR. This decouples Mcode from
    // the user's Claude Code CLI installation: tools like "cc switch" that
    // overwrite ~/.claude/settings.json no longer affect Mcode's turns, and
    // user-level skills are loaded from ~/.mcode/skills/ (where Mcode's import
    // feature places them). Applied to BOTH the standard and custom-endpoint
    // paths so behavior is consistent.
    //
    // The SDK's Options.env REPLACES the subprocess env entirely (per sdk.d.ts),
    // so we always spread process.env first - otherwise PATH/HOME disappear and
    // the binary can't boot.
    if (req.apiConfig) {
      // Custom endpoint: buildCustomEnv layers on auth, per-tier model bindings,
      // gateway request headers, and CLAUDE_CONFIG_DIR on top of process.env.
      // The session id names the gateway's session header (gateways that
      // require one want a stable id per conversation, not per request).
      options.env = buildCustomEnv(req.apiConfig, { sessionId: req.sessionId });
    } else {
      // Standard Anthropic endpoint: still redirect the config root so Mcode
      // manages its own skills/settings, but no auth/model overrides needed.
      options.env = { ...process.env, CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR };
    }

    // Subagent model pin (per provider config, settings panel「模型配置」):
    // CLAUDE_CODE_SUBAGENT_MODEL is the binary's native channel for routing
    // Task-tool subagents. Layered AFTER the block above so the pin overrides
    // the custom-endpoint path's default mirror of the main model. The value
    // is re-checked against the config's model list (see subagentModel.ts) —
    // a stale id is dropped with a warning rather than injected, because a
    // broken id here kills the Task tool with 503s (the exact failure the
    // tier-mirroring exists to prevent). Official-endpoint turns and configs
    // without a pin keep following the main model.
    const pinnedSubagentModel = resolveSubagentModelValue(req.apiConfig);
    if (pinnedSubagentModel) {
      options.env = { ...options.env, CLAUDE_CODE_SUBAGENT_MODEL: pinnedSubagentModel };
    } else if (req.apiConfig?.subagentModel) {
      ctx.log.warn(
        `subagent model pin ignored: id ${JSON.stringify(req.apiConfig.subagentModel)} not in config ${req.apiConfig.baseUrl} model list`,
      );
    }

    // Bash tool shell: force Git Bash when one is resolvable. claude.exe's own
    // Windows bash detection can fall back to WSL's System32\bash.exe (or
    // PowerShell), neither of which understands the `/d/...`, `/mnt/d/...`, or
    // `D:\...` paths the model emits. Git Bash's MSYS runtime converts them
    // natively, and the canUseTool Bash branch below normalizes the remaining
    // dialects to `D:/...` form. Only set when a real Git Bash is found;
    // otherwise leave the SDK's default resolution untouched.
    if (process.platform === "win32") {
      const gitBash = resolveGitBash();
      if (gitBash) {
        options.env = { ...options.env, CLAUDE_CODE_GIT_BASH_PATH: gitBash };
      }
    }

    // settingSources 显式钉在 ["user"]：Mcode 不继承任何外部项目级配置。
    // 默认值是 ["user","project","local"]，其中 "project"/"local" 会让二进制从
    // cwd 向上扫 CLAUDE.md、.claude/、.mcp.json —— 外部桌面端（或用户手放）的
    // 项目级内容会被静默卷进每一轮（实测：外部 .mcp.json 的两个 stdio 服务器
    // 懒枚举 ~110 个工具，一轮 +26k token，且工具块逐轮漂移打断前缀缓存）。
    // 钉在 ["user"] 后：user 级仍解析到 CLAUDE_CONFIG_DIR=~/.mcode（skills、
    // settings.json、CLAUDE.md 都还是 Mcode 托管的那份），项目级一律不读。
    options.settingSources = ["user"];
    options.env = { ...options.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
    ensureMaterialized(instructionsSourcePath(dataRoot()), [memoryInstructionPath(MCODE_CONFIG_DIR, "CLAUDE.md")]);

    // Diagnostic: dump the effective env actually handed to the SDK
    // subprocess, so model-routing failures against third-party gateways can
    // be triaged without a packet capture. Only the Anthropic-* / Claude-*
    // vars matter for routing; PATH/HOME/etc are filtered out for brevity.
    // Mask the auth token (keep first 2 / last 4) - never log cleartext.
    if (req.apiConfig) {
      const diagEnv: Record<string, string | undefined> = {};
      const diagKeys = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "API_TIMEOUT_MS",
      ];
      const e = options.env as Record<string, string | undefined>;
      for (const k of diagKeys) {
        if (e[k] !== undefined) diagEnv[k] = e[k];
      }
      const tok = e.ANTHROPIC_AUTH_TOKEN ?? e.ANTHROPIC_API_KEY;
      diagEnv.__authTokenMasked = tok ? `${tok.slice(0, 2)}***${tok.slice(-4)} (mode=${e.ANTHROPIC_API_KEY ? "api_key" : "auth_token"})` : "(none)";
      ctx.log.info(
        `claude custom env: selectedModel=${req.apiConfig.selectedModel} betas=${JSON.stringify(options.betas ?? null)} env=${JSON.stringify(diagEnv)}`,
      );
    }

    // --- canUseTool bridge ---
    // Three kinds of tool calls route through here:
    //  (a) AskUserQuestion — BLOCKS via ctx.requestUserInput (Deferred). The
    //      user's answers come back as `updatedInput.answers`, the SDK hands
    //      them to the model, and the SAME turn continues. This is the only
    //      way the conversation proceeds after a question — see
    //      https://code.claude.com/docs/en/agent-sdk/user-input. Returning
    //      null here (the old behavior) left the tool blocked indefinitely
    //      while onUserDialog cancelled it, ending the turn prematurely.
    //  (b) ExitPlanMode — BLOCKS via ctx.requestPlanApproval (Deferred). The
    //      model has drafted a plan in plan mode and needs user approval to
    //      proceed. Allow → SDK exits plan mode for this turn; deny → stays
    //      in plan mode and the model can revise.
    //  (c) every other tool — standard host-moderated approval via
    //      ctx.requestApproval.
    const requestApproval = ctx.requestApproval;
    const requestUserInput = ctx.requestUserInput;
    const requestPlanApproval = ctx.requestPlanApproval;

    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      // Shared memory handlers perform fail-closed approval even when SDK modes bypass hooks.
      if (toolName.startsWith(`mcp__${MEMORY_MCP_SERVER}__memory_`)) return { behavior: "allow" };
      // mcode-app 同理:放行在这里,审批在 handler 里按「调的是哪个功能」分档做(main/appControl/tools.ts)。
      if (toolName.startsWith(`mcp__${APP_MCP_SERVER}__app_`)) return { behavior: "allow" };
      if (toolName === "AskUserQuestion") {
        // AskUserQuestion only fires here when the native tool is available
        // (capabilities.supportsAskUserQuestion). Sentinel fallback path
        // doesn't reach canUseTool.
        if (!requestUserInput) {
          // No host bridge wired — fall back to deny so the model isn't stuck.
          return { behavior: "deny", message: "User input not available" };
        }
        const questions = parseQuestions(input);
        if (questions.length === 0) {
          return { behavior: "deny", message: "Malformed AskUserQuestion input" };
        }
        const requestId = randomUUID();
        const decision = await requestUserInput({
          requestId,
          toolUseId: opts.toolUseID,
          questions,
        });
        // User closed the question card without answering: deny the tool so
        // the SDK surfaces it to the model as a clear error and the SAME
        // turn continues (the model decides how to proceed).
        if (decision.dismissed) {
          return { behavior: "deny", message: "用户关闭了提问,未提供答案,请继续当前任务" };
        }
        // Build the SDK's expected answers map: { [question.text]: label }.
        // SDK accepts a string (single label or comma-joined) per question.
        const sdkAnswers: Record<string, string> = {};
        for (const q of questions) {
          const v = decision.answers[q.question];
          if (v == null) continue;
          sdkAnswers[q.question] = Array.isArray(v) ? v.join(", ") : v;
        }
        return {
          behavior: "allow",
          updatedInput: { questions: input.questions, answers: sdkAnswers },
        };
      }

      if (toolName === "ExitPlanMode") {
        // Fallback path: newer SDK versions route ExitPlanMode approval through
        // onUserDialog (request_user_dialog) instead of canUseTool, so this
        // branch is typically NOT reached. It's kept as a defensive fallback
        // for SDK versions / code paths that still use can_use_tool. The real
        // handling lives in onUserDialog above.
        ctx.log.info("canUseTool: ExitPlanMode fallback path hit (expected to be handled by onUserDialog)");
        // Plan mode: the model has drafted a plan and is asking the user to
        // approve it before execution. The plan text arrives in input.plan
        // (the SDK's ExitPlanModeInput type omits it, but it's present at
        // runtime). Allow → SDK exits plan mode for this turn; deny → SDK
        // stays in plan mode and the model can revise. See
        // https://docs.snowflake.com/en/user-guide/cortex-code-agent-sdk/user-input
        if (!requestPlanApproval) {
          return { behavior: "deny", message: "Plan approval not available" };
        }
        const plan = typeof (input as { plan?: unknown })?.plan === "string"
          ? ((input as { plan: string }).plan)
          : "";
        const requestId = randomUUID();
        const decision = await requestPlanApproval({
          requestId,
          plan,
          toolUseId: opts.toolUseID,
        });
        if (decision.approved) {
          const finalPlan = decision.editedPlan ?? plan;
          return {
            behavior: "allow",
            updatedInput: { ...input, plan: finalPlan, message: "Plan approved by user" },
          };
        }
        return {
          behavior: "deny",
          message: decision.reason ?? "Plan rejected by user",
        };
      }

      // --- File-write path guard (strict in-project policy) ---
      // Claude sometimes emits WSL-style `/mnt/<drive>/...` paths even on
      // native Windows (a training-data artifact). On Windows those resolve
      // to a garbage root-relative folder (e.g. `D:\mnt\d\...`), and nothing
      // used to stop the write — acceptEdits auto-approved them silently, so
      // files landed outside the project. Here we (1) normalize such paths
      // to native Windows paths and (2) deny writes that resolve outside the
      // project working directory in EVERY permission mode except
      // bypassPermissions/dontAsk (the user explicitly opted out of all
      // checks there). The normalized path rides back to the SDK via
      // `updatedInput` so the actual write lands at the corrected location.
      // The strict deny runs BEFORE the always-allowed gate below — the
      // project boundary wins over a per-tool grant.
      let effectiveInput: Record<string, unknown> | undefined;
      if (FILE_MUTATING_TOOLS.has(toolName)) {
        const raw = getToolFilePath(toolName, input);
        if (raw) {
          const norm = normalizeToolFilePath(req.cwd, raw);
          if (norm) {
            const pathKey = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
            effectiveInput = { ...input, [pathKey]: norm.absPath };
            const mode = ctx.getPermissionMode?.();
            const bypass = mode === "bypassPermissions" || mode === "dontAsk";
            // **资料库只读** —— 独立于项目边界的一条硬规则,`bypass` 也拦。
            //
            // 为什么不能只靠下面那条"越出项目就拒":那只是**恰好**成立 —— 库根默认在
            // `<数据根>/library`,与用户的项目目录不重叠,于是"写只能在项目内"顺带
            // 等于"库只读"。可一旦库被搬进项目目录(或项目设在数据根下),那条规则就
            // **静默失效**,而没有任何东西会提醒。用户明确要求"库的内容不能动",所以
            // 它得是显式的一条,不是巧合的副产品。
            //
            // 判据复用 `library/paths.ts` 的 `isInsideLibrary`(那里本来就负责
            // "别让人写坏库路径",不另写一份)。
            if (isInsideLibrary(norm.absPath)) {
              ctx.log.info(`denied library-write ${toolName}: ${norm.absPath}`);
              return {
                behavior: "deny",
                message:
                  `拒绝:目标路径在**资料库**内(${norm.absPath})。资料库是只读的 —— ` +
                  `请先把它读到项目目录里(或复制过去),在项目里改。`,
              };
            }
            if (!norm.insideProject && !bypass) {
              ctx.log.info(
                `denied out-of-project ${toolName}: ${norm.absPath} (cwd=${req.cwd})`,
              );
              return {
                behavior: "deny",
                message: `拒绝:目标路径在项目工作目录之外(${norm.absPath})。只允许在项目目录内写入文件,请改用相对路径。`,
              };
            }
          }
        }
      }

      // --- Bash command path-dialect normalization ---
      // The model emits Git Bash `/d/...` and WSL `/mnt/d/...` paths inside
      // bash commands. Only Git Bash understands `/d/...` (MSYS conversion);
      // neither dialect works in PowerShell or WSL bash. Rewrite both to
      // native `D:/...` form so the command succeeds in whatever shell the
      // SDK resolves. The normalized command rides back via `updatedInput`
      // (same mechanism as the file-path guard above) — the approval dialog
      // also shows the corrected command. Backslash-native paths (`D:\...`)
      // are left alone; those are fixed by steering the shell to Git Bash
      // (CLAUDE_CODE_GIT_BASH_PATH, see startTurn).
      if (toolName === "Bash") {
        const raw = (input as { command?: unknown }).command;
        if (typeof raw === "string" && raw.length > 0) {
          const normalized = normalizeBashCommand(raw);
          if (normalized !== raw) {
            effectiveInput = { ...input, command: normalized };
          }
        }
      }

      // Standard tool approval. Before prompting the user, check two
      // host-side gates so the change takes effect immediately:
      //  (1) "always allow" — the user previously granted this tool with
      //      the always checkbox; skip the prompt for the rest of the session.
      //  (2) permission mode — bypassPermissions/dontAsk auto-allows every
      //      tool; acceptEdits auto-allows file-editing tools. The SDK's own
      //      permissionMode option is fixed at query() start, but our host
      //      gate reads the LIVE value so a mid-turn flip applies to the
      //      next tool right away. Out-of-project writes never reach these
      //      gates — they were denied above.
      if (ctx.isToolAlwaysAllowed?.(toolName)) {
        return effectiveInput
          ? { behavior: "allow", updatedInput: effectiveInput }
          : { behavior: "allow" };
      }
      const mode = ctx.getPermissionMode?.();
      if (shouldAutoApprove(mode, toolName)) {
        return effectiveInput
          ? { behavior: "allow", updatedInput: effectiveInput }
          : { behavior: "allow" };
      }

      if (!requestApproval) {
        return effectiveInput
          ? { behavior: "allow", updatedInput: effectiveInput }
          : { behavior: "allow" };
      }
      const r = await requestApproval({
        requestId: randomUUID(),
        toolName,
        input: effectiveInput ?? input,
      });
      return r.allow
        ? {
            behavior: "allow" as const,
            updatedInput: (r.updatedInput ?? effectiveInput) as
              | Record<string, unknown>
              | undefined,
          }
        : { behavior: "deny" as const, message: r.reason ?? "Denied by user" };
    };
    options.canUseTool = canUseTool;

    // --- onUserDialog bridge ---
    // SDK 0.3.x routes ExitPlanMode's user-approval step through
    // `request_user_dialog` control requests (dialogKind-based), NOT through
    // canUseTool. The CLI is fail-closed: it only emits a dialog kind declared
    // in `supportedDialogKinds` - without the declaration the flow degrades to
    // its no-dialog behavior (the turn aborts with "Tool permission request
    // failed: AbortError: Stream closed") and the approval UI never shows.
    // See sdk.d.ts OnUserDialog / supportedDialogKinds docs.
    //
    // The real dialogKind for ExitPlanMode is `permission_exit_plan_mode_v2`,
    // confirmed by analyzing the bundled claude.exe v2.1.218 binary: the
    // ExitPlanMode tool (var `oz`, name "ExitPlanMode") is mapped to dialog
    // `fcr` whose `.kind` is "permission_exit_plan_mode_v2" in the LBy routing
    // table (KUe({matches:(e)=>e===oz, dialog:fcr, build:qZu})). The CLI gates
    // emission on `ewt() && (twt() ?? []).includes(dialogKind)`, so a mismatch
    // silently suppresses the dialog. The legacy guesses below are kept as
    // defensive fallbacks in case a future SDK version renames the kind.
    const EXIT_PLAN_DIALOG_KINDS = new Set([
      "permission_exit_plan_mode_v2", // real value (claude.exe v2.1.218)
      "exit_plan_mode", // legacy guess - defensive
      "ExitPlanMode", // legacy guess - defensive
      "plan_approval", // legacy guess - defensive
    ]);
    const onUserDialog: OnUserDialog = async (request, opts) => {
      ctx.log.info(
        `onUserDialog: dialogKind=${request.dialogKind} toolUseID=${request.toolUseID ?? "n/a"} payloadKeys=${JSON.stringify(Object.keys(request.payload ?? {}))}`,
      );
      // ExitPlanMode plan approval: route to the existing plan-approval bridge
      // (renderer shows <PlanApprovalPrompt>). The model's plan text lives in
      // payload.plan (the qZu build fn sets {requestId, toolName,
      // permissionResult, plan, planFilePath, usage}); fall back to the older
      // payload.input.plan shape for SDK versions that nested it there.
      if (EXIT_PLAN_DIALOG_KINDS.has(request.dialogKind) || typeof (request.payload as { plan?: unknown })?.plan === "string") {
        if (!requestPlanApproval) {
          return { behavior: "cancelled" as const };
        }
        const p = request.payload as { plan?: unknown; input?: { plan?: unknown } };
        const plan = typeof p.plan === "string" ? p.plan
          : typeof p.input?.plan === "string" ? p.input.plan
          : "";
        const requestId = request.toolUseID ?? randomUUID();
        const decision = await requestPlanApproval({
          requestId,
          plan,
          toolUseId: request.toolUseID,
        });
        if (decision.approved) {
          const finalPlan = decision.editedPlan ?? plan;
          // User's adjustment feedback (typed into the approval sheet) rides
          // along in the dialog result message so the model reads it right
          // after approval and incorporates it during execution. Without
          // feedback the message stays the stock approval text.
          const feedback = decision.feedback?.trim();
          const message = feedback
            ? `计划已批准。用户调整意见:${feedback}`
            : "Plan approved by user";
          return {
            behavior: "completed" as const,
            result: { approved: true, plan: finalPlan, message },
          };
        }
        return {
          behavior: "completed" as const,
          result: { approved: false, reason: decision.reason ?? "Plan rejected by user" },
        };
      }
      // Unrecognized dialog kind — SDK requires `cancelled` so the CLI applies
      // its default behavior for that dialog.
      return { behavior: "cancelled" as const };
    };
    options.onUserDialog = onUserDialog;
    options.supportedDialogKinds = Array.from(EXIT_PLAN_DIALOG_KINDS);

    // --- onElicitation bridge ---
    // MCP elicitation（服务器向用户要输入/授权）。渲染端零改动：复用
    // AskUserQuestion 的 requestUserInput 选项卡，把请求映射成一或多道题：
    //  - url 模式 → 「打开链接」（accept）/「拒绝」（decline），URL 放在题面里
    //    （限制：宿主不代开浏览器，用户从卡片里复制 —— 代开需要渲染端配合）；
    //  - form 模式且 schema **每个**属性都带非空 enum → 逐属性出题（≤4），答案
    //    按属性名收进 ElicitResult.content；否则退化为「同意」/「拒绝」，
    //    accept 不带内容（服务器要么接受空表单，要么自行 decline）。
    // 用户关掉卡片 → cancel（MCP 语义：用户取消，区别于服务器 decline）。
    // 不设 onElicitation 时 SDK 会自动 decline —— 显式接桥后才有交互。
    const onElicitation: OnElicitation = async (request: ElicitationRequest) => {
      if (!requestUserInput) return { action: "decline" };
      const schemaProps =
        request.mode !== "url" && request.requestedSchema
          ? (request.requestedSchema.properties as
              | Record<string, { enum?: unknown; title?: string; description?: string }>
              | undefined)
          : undefined;
      const propNames = schemaProps ? Object.keys(schemaProps) : [];
      const props = schemaProps ?? {};
      const allEnum =
        propNames.length > 0 &&
        propNames.every((n) => Array.isArray(props[n].enum) && (props[n].enum as unknown[]).length > 0);
      let declineLabel: string | null = null;
      let questions: AskUserQuestionItem[];
      if (schemaProps && allEnum) {
        questions = propNames.slice(0, 4).map((n) => {
          const prop = props[n];
          const text = `${prop.description ?? request.message}（${prop.title ?? n}）`;
          return {
            header: prop.title ?? n,
            question: text,
            multiSelect: false,
            options: (prop.enum as unknown[]).map((v) => ({ label: String(v) })),
          };
        });
      } else {
        declineLabel = "拒绝";
        questions = [
          {
            header: request.title ?? request.displayName ?? request.serverName,
            question: request.mode === "url" && request.url ? `${request.message}\n${request.url}` : request.message,
            multiSelect: false,
            options:
              request.mode === "url"
                ? [{ label: "打开链接", description: request.url }, { label: "拒绝" }]
                : [{ label: "同意" }, { label: "拒绝" }],
          } satisfies AskUserQuestionItem & { options: AskUserQuestionOption[] },
        ];
      }
      const decision = await requestUserInput({ requestId: randomUUID(), questions });
      if (decision.dismissed) return { action: "cancel" };
      if (declineLabel !== null) {
        const refused = questions.some((q) => {
          const a = decision.answers[q.question];
          return Array.isArray(a) ? a.includes(declineLabel) : a === declineLabel;
        });
        if (refused) return { action: "decline" };
      }
      // enum 表单：答案按属性名回填（answers 以题面文本为键，映射时记录）。
      const content: Record<string, string> = {};
      if (schemaProps && allEnum) {
        for (const n of propNames.slice(0, 4)) {
          const prop = schemaProps[n];
          const text = `${prop.description ?? request.message}（${prop.title ?? n}）`;
          const a = decision.answers[text];
          if (a != null) content[n] = Array.isArray(a) ? a.join(", ") : a;
        }
      }
      return { action: "accept", content: Object.keys(content).length > 0 ? content : undefined };
    };
    options.onElicitation = onElicitation;

    // --- systemPrompt appends ---
    // (0) Claude identity: always appended (every platform, every turn) so the
    //     model answers "who/what are you" by introducing itself as Mcode's
    //     assistant rather than a bare Claude CLI/API.
    // (1) Windows path hint: Claude's training data is saturated with
    //     WSL-style `/mnt/<drive>/...` paths; whether those actually resolve
    //     depends on the bash the CLI spawns, which varies by machine (Git
    //     Bash → native `D:\...` only; no Git Bash → WSL, where `/mnt/...` is
    //     the only absolute form). `detectBashEnv("claude")` mirrors the CLI's
    //     resolution (Git Bash from the git install root, WSL as fallback) so
    //     the hint tells the model the truth. The canUseTool guard normalizes
    //     the file tools anyway, but this hint cuts how often the model emits
    //     wrong-form paths in the first place — including inside Bash commands
    //     (e.g. `cat > /mnt/d/...`), which the guard can't intercept.
    // (2) AskUserQuestion sentinel fallback when the native tool is missing.
    // Identity is always present, so the preset+append is always active —
    // the `claude_code` preset (full Claude Code tool guidance + safety rules)
    // becomes the base on every platform, with our fragments appended on top.
    const appends: string[] = [];
    appends.push(CLAUDE_IDENTITY_PROMPT);
    // The user's file architecture — where the 资料库 lives and how
    // to read them. Every turn, every mode (the "读取层"; the modes are the
    // 流程 layer on top of it). The 精读/写作/评审 flows all tell the model to
    // check the library before citing anything, and that instruction is empty
    // without this. Paths only (see fileArchitecturePrompt): the library changes
    // between turns, so the model reads the manifests / queries with the script
    // instead of being handed a list that would already be stale.
    appends.push(fileArchitecturePrompt(dataRoot(), scriptsDir()));
    if (process.platform === "win32") {
      appends.push(bashPathHintFor(detectBashEnv("claude")));
    }
    if (isUiPlanMode) {
      appends.push(CLAUDE_PLAN_MODE_NUDGE);
    }
    // Host 统一解析「记忆背景 → 角色身份 → 当前工作流」，三个 provider 消费同一组
    // sections；Claude 这里只负责放进原生 systemPrompt append。顺序也集中在一处，
    // 后续再加上下文层不会出现某个引擎漏接。
    appends.push(...turnContextSections(req));
    if (!this.capabilities.supportsAskUserQuestion) {
      appends.push(ASK_SYSTEM_PROMPT);
    }
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      // Blank-line section separation (shared with the Pi provider's injector)
      // — a bare space glues the Chinese identity section onto the English
      // path hint and the model reads them as one run-on paragraph.
      append: joinPromptSections(...appends),
    };

    // --- In-process MCP server: browser tools ---
    // Exposes `browser_*` tools (navigate/snapshot/click/screenshot/list) as an
    // MCP server running in this process (no subprocess). The SDK surfaces each
    // to canUseTool as `mcp__mcode-browser__<name>`; read-only tools are
    // auto-approved (see shouldAutoApprove). Claude can't register custom tools
    // directly (unlike Pi's pi.registerTool), so an in-process MCP server is the
    // supported mechanism for same-process tool handlers. See sdk.d.ts
    // `createSdkMcpServer`.
    //
    // The settings panel's MCP section gates this injection: when the built-in
    // server is disabled there, the turn runs without it. User-scope servers
    // (~/.mcode/.claude.json mcpServers) need no injection here — the binary
    // loads them via the "user" setting source; disabled ones are simply
    // absent from the file. Project .mcp.json servers are governed per-turn by
    // the explicit approval lists below, which replace the CLI's first-use
    // approval dialog (our onUserDialog bridge cancels unknown kinds, so an
    // unlisted server would never load anyway).
    // --- Per-turn host-side config reads (parallelized) ---
    // Everything below used to be awaited one after another, putting the sum
    // of five settings/file reads (+ the plugin tree scan) on the critical
    // path before query() can even spawn the CLI. They're mutually
    // independent, so they run as one Promise.all batch; the only ordering
    // that matters is where results land on `options` afterwards, which
    // mirrors the original sequential composition exactly (mcpServers ←
    // browser server, settings ← MCP lists → outputStyle → plugin hooks).
    // One scan feeds both plugin consumers: the plugins option below and the
    // plugin-MCP merge (which accepts a precomputed set to avoid a second
    // directory scan).
    //
    // **收窄在这里做,而且要在派发之前** —— 工作流节点可以只加载它选的那几个插件
    // (见 `NodeRunInput.pluginNames`)。筛在这一步而不是筛 `options.plugins`:插件的
    // MCP 服务器是**从同一份清单**里读出来的(下面 `getPluginMcpServers` 吃的就是这个
    // promise),两处各筛一次迟早分家 —— 而分家的表现是"这个插件没加载,它的工具却还在",
    // 正是这个参数想解决的那件事没解决。
    const enabledPluginsPromise = getEnabledPlugins().then((plugins) =>
      narrowByName(
        plugins.filter((plugin) => plugin.compatibleProviderIds.includes("claude-sdk")),
        req.pluginNames,
      ),
    );
    const [mcpState, browserServer, libraryServer, workflowServer, memoryServer, outputStyle, enabledPlugins, pluginMcp] =
      await Promise.all([
        getMcpManagement(),
        // Pure constructor after the (cached) SDK import — building it
        // unconditionally is free; only ATTACHING it below is gated on the
        // browserDisabled setting.
        buildBrowserMcpServer(req.cwd, ctx, req.sessionId, req.turnNumber),
        // 库操作工具(mcode-library)。同样是纯构造,无条件建,下面无条件挂 ——
        // 它是 AI 操作资料库的**唯一**通道(写操作必须回到主进程,理由见
        // mcp/libraryServer.ts 文件头),关掉它文献检索流程就断了。危险性由
        // shouldAutoApprove 兜着:只有只读的那几个自动放行,写操作一律要用户点头。
        // 传 sessionId 是为了「AI 挂一个库到这次对话」时,界面能把附件加到**正确的**
        // 会话上(见 library_attach_to_chat)。
        buildLibraryMcpServer({ sessionId: req.sessionId }),
        // 工作流那一摊(mcode-workflow)—— 让 AI 自己建/改工作流、节点类型、代理档案。
        // 与库工具同一个形状:读工具自动放行,写工具一律要用户点头(见
        // mcp/mcodeServer.ts 文件头,那里也写了为什么钩子/插件/MCP 安装**不在这里**)。
        buildWorkflowMcpServer({ sessionId: req.sessionId }),
        // 记忆那一摊(mcode-memory)—— 让 AI 自己**记**东西(`memory_write` 等)。
        // 存储与注入早就有了,缺的一直是这个写入口:没有它,记忆库永远是空的,
        // 注入的那段快照永远是空串(见 mcp/memoryServer.ts 文件头)。
        buildMemoryMcpServer({ sessionId: req.sessionId, context: ctx }),
        getOutputStyleSetting(),
        enabledPluginsPromise,
        enabledPluginsPromise.then((plugins) => getPluginMcpServers(plugins)),
      ]);

    // Per-engine visibility: which of the per-turn-injected servers (builtin
    // browser + plugin) claude may see. The two backbone servers
    // (mcode-library / mcode-workflow) are deliberately NOT filtered — they
    // are the app's own machinery, not user-assigned assets. User-scope
    // servers need no check here — they are read by the binary from
    // .claude.json, which materialization already narrowed to claude's
    // assignment.
    const mcpEngines = readMcpEnginesMap();
    const claudeMaySee = (name: string): boolean => mcpEngineEnabled(mcpEngines, name, "claude");

    if (!mcpState.browserDisabled && claudeMaySee(BROWSER_MCP_SERVER)) {
      options.mcpServers = { [BROWSER_MCP_SERVER]: browserServer };
    }
    // 库工具与浏览器开关**无关** —— 它是学术流程的骨干,不是可选装饰。记忆工具同理。
    options.mcpServers = {
      ...(options.mcpServers ?? {}),
      [LIBRARY_MCP_SERVER]: libraryServer,
      [WORKFLOW_MCP_SERVER]: workflowServer,
      [MEMORY_MCP_SERVER]: memoryServer,
    };
    // mcode-app —— agent 控制 Mcode 本身(全部功能 + 界面操作,见 main/appControl/tools.ts)。
    // 节点收窄(strictMcpConfig)时不进候选表,与记忆工具一样只在普通对话里挂。
    options.mcpServers[APP_MCP_SERVER] = await buildAppMcpServer({ sessionId: req.sessionId, context: ctx });

    // Output style (settings panel): same Settings-not-Options trap as the
    // MCP lists above. The CLI reads the style once at session start and has
    // no runtime switch control request, so the selection only shapes NEW
    // turns — which is exactly the per-turn granularity Mcode wants (every
    // turn is a fresh query). Never-configured (null) keeps the CLI default
    // and injects nothing.
    if (outputStyle) {
      options.settings = {
        ...(typeof options.settings === "object" ? options.settings : {}),
        outputStyle,
      };
    }

    // --- Plugins (settings → Plugins; docs/plugin-feasibility.md v1) ---
    // Enabled plugins ride the SDK's native loader: skills/commands/agents
    // are assembled by the CLI engine per turn (zero host-side copying). Two
    // host-side rails:
    //  1. skipMcpDiscovery — Mcode owns plugin MCP connections and injects
    //     them into options.mcpServers below under "<plugin>__<server>"
    //     (session-level granularity; the MCP panel lists/toggles them).
    //  2. disableAllHooks — v1 runs NO plugin hooks. Hooks would otherwise
    //     be executed natively by the CLI engine; they are parsed + shown in
    //     the panel, never run (per-hook review is the v1.5 plan).
    if (enabledPlugins.length > 0) {
      options.plugins = enabledPlugins.map((p) => ({
        type: "local" as const,
        path: p.rootDir,
        skipMcpDiscovery: true,
      }));
      if (enabledPlugins.some((p) => p.hasHooks)) {
        options.settings = {
          ...(typeof options.settings === "object" ? options.settings : {}),
          disableAllHooks: true,
        };
      }
      if (pluginMcp.length > 0) {
        const servers = options.mcpServers ?? {};
        for (const [name, config] of pluginMcp) {
          // Per-engine visibility: a server the user took away from claude is
          // not injected at all (the panel's switch writes the same matrix the
          // codex view filters by).
          if (!claudeMaySee(name)) continue;
          // Contracts McpServerConfig is transport-shape-compatible with the
          // SDK's McpServerConfig union (stdio/http/sse); the cast is for the
          // passthrough extras the SDK type doesn't model.
          servers[name] = config as unknown as NonNullable<Options["mcpServers"]>[string];
        }
        options.mcpServers = servers;
      }
    }

    // --- 收窄:这一轮只挂哪几个 MCP 服务器(工作流节点填的 `mcp` 参数)---
    //
    // 空/缺席 = 不限制,这一段整个跳过 —— **普通对话与没填过这个参数的节点走的还是
    // 上面那条老路,行为逐字不变**。只有节点明确列了几个名字时才切到下面的写法。
    //
    // 为什么非得这么麻烦:平时这几路服务器**不经过 `options.mcpServers`** ——
    //   · 用户自己那几个在 ~/.mcode/.claude.json 里,二进制按 "user" 设置源自己读。
    // 所以"少放几个进 options.mcpServers"挡不住任何东西,被排除的会从原路自己回来。
    // 真正管用的是 `strictMcpConfig`(SDK 选项:只认 `mcpServers` 里显式给的,别的
    // 一概不看)—— 但它的代价是**上面那两条路一起断掉**,于是被选中的那几个必须由
    // 我们显式搬进来。两件事缺一不可,少做一件的表现都是"选了等于没选"。
    const wantMcp = req.mcpServerNames ?? [];
    if (wantMcp.length > 0) {
      const allow = new Set(wantMcp);
      const current = options.mcpServers ?? {};
      const kept: NonNullable<Options["mcpServers"]> = {};
      /** 收一份配置进来(够格的才收,认不出来的原样丢掉)。**先到的赢** —— 同名在
       *  不同来源下是允许的(设置面板就分着列),而一个名字只能挂一份配置。先后顺序
       *  写死在下面,免得"哪一份生效"取决于对象键的遍历顺序。 */
      const take = (name: string, config: unknown): void => {
        if (kept[name] !== undefined) return;
        // Per-node narrowing may only subtract from global management; a stale
        // workflow value must not revive a server disabled for Claude.
        if (!claudeMaySee(name)) return;
        const parsed = parseMcpConfig(config);
        if (parsed) kept[name] = parsed as unknown as NonNullable<Options["mcpServers"]>[string];
      };

      // ① 骨干两个:**永远在**,也不进节点的候选表(它们不是用户装的东西,列出来只会
      //    让人以为自己关得掉,见 `NodeRunInput.mcpServerNames`)。它们的值是我们自己
      //    构造的服务器对象,不是配置形状,所以走不了 `take` 的 schema 那一关。
      for (const name of [LIBRARY_MCP_SERVER, WORKFLOW_MCP_SERVER]) {
        const cfg = current[name];
        if (cfg !== undefined) kept[name] = cfg;
      }
      // ② 内置浏览器服务器:设置面板的开关决定它建不建,这里再叠一层"这一步要不要"。
      const browser = current[BROWSER_MCP_SERVER];
      if (!mcpState.browserDisabled && browser !== undefined && allow.has(BROWSER_MCP_SERVER)) {
        kept[BROWSER_MCP_SERVER] = browser;
      }
      // ③④ 剩下两路都**按名字选**,而且越靠用户本人配置的越优先(与设置面板里列的
      //       先后一致:用户 → 插件)。
      //       ③ 用户 config 文件里那几个 —— 平时二进制自己读,收窄后必须显式注入。
      for (const [name, raw] of Object.entries(mcpServersOf(await readUserClaudeJson()))) {
        if (allow.has(name)) take(name, raw);
      }
      //       ④ 插件带来的那几个(`<插件>__<服务器>`)。它们**和别的服务器一样按名字
      //          选**,不搞"选了插件就自动带上它的服务器"的特例 —— 那样一来「这一步能用
      //          哪几个 MCP 服务器」这句话就有两个意思了,而两个意思的规则没人记得住。
      for (const [name, config] of pluginMcp) {
        if (allow.has(name)) take(name, config);
      }

      options.mcpServers = kept;
      options.strictMcpConfig = true;
      ctx.log.info(
        `claude turn narrowed: session=${req.sessionId} mcp=[${Object.keys(kept).join(",")}] ` +
          `plugins=[${enabledPlugins.map((p) => p.name).join(",")}]`,
      );
    }

    const gate = makeSettleGate();
    // Fallback cap for the stdin hold: if the settle signal never arrives
    // (CLI stops emitting task edges, unexpected states), release anyway so
    // the turn can't hang — degrades to the pre-fix early-exit behavior
    // instead of deadlocking. Long enough for real background agents.
    const settleTimers: NodeJS.Timeout[] = [];
    settleTimers.push(setTimeout(() => gate.release(), PROMPT_SETTLE_FALLBACK_MS));
    let retryGate: ReturnType<typeof makeSettleGate> | null = null;
    ctx.log.info(
      `claude turn start: session=${req.sessionId} uiMode=${req.permissionMode} sdkMode=${(typeof options.permissionMode === "string" ? options.permissionMode : "default")} settleGate=on`,
    );
    // 这一轮的输入通道。**`let` 而不是 `const`**:传输层重试会重建 query,那时也换一条
    // 新的通道(见下面那一处),而 handle 上那个 `inject` 读的始终是当前这一条。
    // 降级路径把 schema 指令直接拼在用户 prompt 末尾 —— makePromptChannel 只读
    // req.prompt/images,扩展 req 是唯一无侵入的注入口。
    const turnReq: StartTurnRequest = structuredFallback
      ? { ...req, prompt: req.prompt + buildStructuredOutputPrompt(structuredFallback) }
      : req;
    let channel = makePromptChannel(turnReq, gate, ac.signal);
    const q = (await loadQuery())({ prompt: channel.stream, options });

    // Resolve the user-declared context-window tag from the selected model's
    // `supports1m` flag. `resolveActiveModel` appends a `[1m]` suffix exactly
    // when the selected model declares 1M, so its presence signals a 1M
    // window. For a custom endpoint this is authoritative (a non-1M config →
    // "200k" overrides the model-name heuristic, so a gateway model
    // coincidentally named "*opus*" without supports1m resolves to 200k as
    // the user intended). `undefined` (official Anthropic endpoint) lets the
    // heuristic decide.
    const configured: ClaudeContextWindowTag | undefined = req.apiConfig
      ? resolveActiveModel(req.apiConfig)?.toLowerCase().endsWith("[1m]")
        ? "1m"
        : "200k"
      : undefined;

    const adapter = new SdkMessageAdapter(
      ctx,
      req.sessionId,
      this.capabilities.supportsAskUserQuestion,
      req.cwd,
      snapshot,
      ac.signal,
      q,
      req.initialTodos ?? [],
      configured,
      !req.apiConfig,
    );
    // Wire the settle gate: the adapter releases the prompt iterable's hold
    // once the turn is settled (result + no running subagents / background
    // tasks), letting the CLI process exit with complete session state.
    adapter.setSettleGate(gate.release);

    let finished = false;
    const done = (async () => {
      // Transport-level retry loop. The SDK already retries API-level
      // transient errors (429 / overloaded / 5xx) internally — surfaced via
      // `api_retry` system messages the adapter now logs — and those close
      // the iterator cleanly with a `result{subtype:"error"}` (handled by
      // handleResult, not this catch). This wrapper catches only the THROWN-
      // exception case the SDK doesn't cover: stdio breaks, binary crashes,
      // network timeouts. When such a failure happens BEFORE any assistant
      // content streamed to the renderer (checked via
      // activeAdapter.hasEmittedContent()), we recreate the query + adapter
      // and retry with exponential backoff. The no-content gate is critical
      // — once text/thinking/tool_use has been emitted, recreating would
      // orphan the partial output in the message stream.
      let activeQuery = q;
      let activeAdapter = adapter;
      let attempt = 0;
      try {
        while (true) {
          try {
            for await (const m of activeQuery) {
              await activeAdapter.dispatch(m);
            }
            // 结构化输出降级路径（自定义网关）的轮末校验。原生路径
            // （outputFormat）由 SDK 端到端保证，不经过这里；降级路径只校验
            // 不重试 —— 到这一步轮已收尾，重试得再起一轮 resume query，复杂度
            // 配不上"降级路径"的定位，校验失败按错误收尾并出 notice 卡片。
            // 用户已停止时回复本来就不完整,不报「校验失败」。
            if (structuredFallback && !ac.signal.aborted) {
              const parsed = parseStructuredOutput(activeAdapter.getFinalAssistantText(), structuredFallback);
              if (!parsed.ok) {
                ctx.log.warn(`claude: structured output invalid: ${parsed.error.slice(0, 300)}`);
                ctx.emit({
                  type: "turn.notice",
                  sessionId: req.sessionId,
                  kind: "structured_invalid",
                  message: `结构化输出（${structuredFallback.name}）校验失败，本轮按错误结束：${parsed.error}`,
                });
                await activeAdapter.flushFinal("error");
                return;
              }
            }
            await activeAdapter.flushFinal();
            return;
          } catch (err) {
            // A user stop (ac.abort()) makes the iterator throw AbortError.
            // That's not an error — finalize (marks running subagents killed
            // reflecting the user's stop intent) and exit with interrupted.
            if (ac.signal.aborted) {
              await activeAdapter.flushFinal();
              return;
            }
            // Retryable transport error before any content streamed → retry.
            if (
              !activeAdapter.hasEmittedContent() &&
              attempt < CLAUDE_MAX_TRANSPORT_RETRIES &&
              isRetryableTransportError(err)
            ) {
              attempt += 1;
              const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
              ctx.log.warn(
                `claude: transport error, retry ${attempt}/${CLAUDE_MAX_TRANSPORT_RETRIES} in ${delayMs}ms: ${(err as Error).message}`,
              );
              // Abortable backoff: a user stop during the sleep must NOT
              // turn into another retry attempt.
              try {
                await abortableSleep(delayMs, ac.signal);
              } catch {
                // Aborted during backoff — treat as a user interrupt.
                await activeAdapter.flushFinal();
                return;
              }
              // Fresh query + adapter for the retry. options.abortController
              // (ac) is shared, so a user stop still cancels the retried
              // attempt. options.resume re-attaches to the same SDK session
              // so the conversation context carries over. The retry gets a
              // FRESH settle gate (the abandoned attempt's iterable/gate died
              // with its query).
              retryGate = makeSettleGate();
              settleTimers.push(
                setTimeout(() => retryGate?.release(), PROMPT_SETTLE_FALLBACK_MS),
              );
              // 重试也要换一条**新的输入通道** —— 旧的那条跟着它那条死掉的 query 一起
              // 作废了。不过重试是**从头再跑这一轮**,所以只带上最初那条用户消息:重试
              // 之前插进来的那几句进不了这次重试(它们已经进了那一轮被丢弃的上下文)。
              // 这是重试本来就有的取舍,不是插话这条新路带来的。
              channel = makePromptChannel(turnReq, retryGate, ac.signal);
              activeQuery = (await loadQuery())({ prompt: channel.stream, options });
              activeAdapter = new SdkMessageAdapter(
                ctx,
                req.sessionId,
                this.capabilities.supportsAskUserQuestion,
                req.cwd,
                snapshot,
                ac.signal,
                activeQuery,
                req.initialTodos ?? [],
                configured,
                !req.apiConfig,
              );
              activeAdapter.setSettleGate(retryGate.release);
              continue;
            }
            // Non-retryable, content already started, or retries exhausted.
            ctx.log.error(`claude SDK error: ${(err as Error).message}`);
            ctx.emit({
              type: "error",
              sessionId: req.sessionId,
              message: (err as Error).message,
              code: "SDK_ERROR",
            });
            // Finalize through flushFinal (NOT a bare turn.done emit): the
            // turn may have already written files before the stream broke,
            // and the user still needs the "本轮修改" card to see (and
            // rewind) what landed on disk. flushFinal also runs the plan
            // collapse + subagent cleanup safety nets, and emits the closing
            // turn.done{reason:"error"} exactly once via its own guard.
            await activeAdapter.flushFinal("error");
            return;
          }
        }
      } finally {
        finished = true;
        // Defensive release: if the CLI process already exited (error path,
        // clean close) while the prompt iterable was still holding, unblock
        // the SDK's streamInput so it can finish its own teardown.
        gate.release();
        retryGate?.release();
        for (const t of settleTimers) clearTimeout(t);
      }
    })();

    return {
      done,
      interrupt: () => ac.abort(),
      isRunning: () => !finished && !ac.signal.aborted,
      // 生成过程中插一句话 —— 见 `makePromptChannel`。这一轮已经收尾(或用户按了停止)
      // 时返回 false,让调用方**兜回普通的发送**,而不是让这句话石沉大海。
      inject: (text) => (!finished && !ac.signal.aborted ? channel.push(text) : false),
    };
  }

  /**
   * 引擎自己的斜杠命令清单（见 `@contracts/provider` 里那个方法的说明）。
   *
   * 走 SDK 的 `supportedCommands()`。**它不需要跑任何一轮就会答** —— 这是这个方法
   * 存在的全部理由：`system/init` 那条事件路只在开跑一轮时才发，而用户想打开 `/`
   * 菜单看命令，恰恰是在还没发消息的时候（第一版挂事件上，界面永远 0 条）。
   *
   * `cwd` 要传：技能是**按目录**发现的（项目技能排全局之前），所以同一个引擎在不同
   * 项目下清单不同。不传就落 CLI 自己的默认根。
   *
   * launch 参数按最小集给 —— 这个方法**只为了问清单**，不该顺带把整个会话的
   * options（MCP、插件、预算、批准通道）都拉起来。给的这几项是 CLI 起得来所必需的。
   */
  async listCommands(opts: { cwd?: string }): Promise<{ supported: boolean; commands: EngineCommandEntry[] }> {
    const binaryPath = resolveSdkBinaryPath();
    const q = (await loadQuery())({
      // 空 prompt + maxTurns 0：不跑任何一轮，只把控制通道建起来。
      prompt: "",
      options: {
        maxTurns: 0,
        includePartialMessages: false,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });
    try {
      const cmds = await q.supportedCommands();
      return {
        supported: true,
        commands: cmds.map((c) => ({
          name: c.name,
          description: c.description ?? "",
          argumentHint: c.argumentHint ?? "",
          aliases: Array.isArray(c.aliases) ? c.aliases : [],
        })),
      };
    } finally {
      // 这个 query 只为了问一句，别让它挂着 —— 不关的话每问一次就多一个 CLI 进程。
      try {
        await q.return(undefined);
      } catch {
        /* 关闭失败无所谓：进程退出时会带走 */
      }
    }
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      // A quick probe: spawn a minimal query and capture the system/init message
      // to verify the SDK binary is functional.
      const binaryPath = resolveSdkBinaryPath();
      const q = (await loadQuery())({
        prompt: "",
        options: {
          maxTurns: 0,
          includePartialMessages: false,
          ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
        },
      });
      // We just need the first system/init message to confirm the binary works.
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          return { ok: true, version: (m as { claude_code_version?: string }).claude_code_version };
        }
      }
      return { ok: false, error: "No system/init message received" };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
