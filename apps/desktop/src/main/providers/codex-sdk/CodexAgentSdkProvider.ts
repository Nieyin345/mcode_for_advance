import { memoryToolDescriptors, invokeMemoryTool } from "@main/memory/engineTools.js";
import { appToolDescriptors, invokeAppEngineTool, isAppToolName } from "@main/appControl/engineTools.js";
import { libraryToolDescriptors, invokeLibraryToolGated, isLibraryToolName } from "@main/library/engineTools.js";
import { workflowEngineBridge } from "@main/mcp/workflowEngineTools.js";
import { buildDynamicTools } from "./CodexDynamicTools.js";
export { buildDynamicTools } from "./CodexDynamicTools.js";
import { agentToolDescriptors, invokeAgentToolGated, isAgentToolName, registerAgentEngineSession } from "@main/mcp/agentEngineBridge.js";
import { textBlocksOf } from "@main/mcp/sdk.js";
/**
 * Codex agent provider — drives the OpenAI Codex harness via the
 * `codex app-server` JSON-RPC protocol (stdio JSONL) and implements the
 * AgentProvider interface from @contracts/provider.
 *
 * ## Route decision (vs the official @openai/codex-sdk)
 * The published TS SDK wraps `codex exec --experimental-json`: one process
 * per turn, NO approval callbacks, NO interrupt API, NO diff/usage events.
 * Mcode's core interactions (tool approval, plan approval, per-turn file
 * card + rewind) need the app-server protocol — the same one the VS Code
 * extension speaks. We spawn the vendored binary directly; the only thing
 * we take from the npm package is the platform binary itself.
 *
 * ## How Codex differs from Claude / Pi
 *   - Permissions: sandbox × approvalPolicy, codex-native modes
 *     (readonly/workspace/full/bypass) — NOT Claude's 4 modes. The OS
 *     sandbox (Seatbelt/Landlock) is the primary containment; approvals are
 *     server-initiated requests when an action wants to escape it.
 *   - No canUseTool: approvals arrive as server→client REQUESTS
 *     (commandExecution / fileChange requestApproval) bridged to the host's
 *     IPC approval card. Host-side "always allow" still gives the server only
 *     a one-shot accept, so permission-mode changes cannot inherit a server
 *     grant. There is NO edit-then-approve.
 *   - File tracking: no pre-write hook for sandboxed writes. The turn's
 *     cumulative unified diff (turn/diff/updated) is reverse-applied at
 *     freeze time to reconstruct pre-turn content (CodexFileSnapshot);
 *     approval-gated writes recordPre before we answer accept.
 *   - Custom tools: no registerTool / in-process MCP. AskUserQuestion,
 *     plan tools and browser tools ride thread/start's experimental
 *     `dynamicTools` (functions the server calls back over JSON-RPC).
 *   - Model/auth: third-party Responses-API endpoints from
 *     CodexModelsStore — config.toml [model_providers] materialized into the
 *     isolated CODEX_HOME (~/.mcode/codex); keys ride the process env
 *     (MCODE_CODEX_KEY_<ID>), never disk. Model ids look like
 *     "providerId/modelId" (same shape as Pi).
 *   - Process model: one app-server per TURN (like Claude's one CLI per
 *     turn), thread identity persisted via ctx.onProviderSessionId and
 *     restored with thread/resume on subsequent turns.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import type {
  AgentProvider,
  StartTurnRequest,
  ProviderContext,
  TurnHandle,
  ProviderCapabilities,
  ApprovalRequest,
  EngineCommandEntry,
  ProviderHealthCheckContext,
} from "@contracts/provider";
import type { ServerRequestFrame } from "./CodexAppServerClient.js";
import { CodexAppServerClient } from "./CodexAppServerClient.js";
import { CodexMessageAdapter } from "./CodexMessageAdapter.js";
import { codexApprovalReply } from "./codexApprovalReply.js";
import { CodexFileSnapshot } from "./CodexFileSnapshot.js";
import { resolveCodexBinaryPath } from "./codexBinaryResolve.js";
import type { TurnDoneReason } from "@contracts/runtime";
import {
  CODEX_EFFORT_VALUES,
  isCodexEffortValue,
  type ThinkingLevelKey,
  type ThinkingLevelMap,
} from "@contracts/thinkingMap";
import {
  buildStructuredOutputPrompt,
  buildCorrectivePrompt,
  parseStructuredOutput,
  type StructuredOutputSpec,
} from "@main/lib/structuredOutput.js";
import {
  CodexModelsStore,
  codexHomePath,
  codexKeyEnvVar,
} from "@main/lib/codexModelsStore.js";
import { getOrSetFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { getMcpManagement } from "@main/lib/mcpConfig.js";
import { mcpEngineEnabled, readMcpEnginesMap } from "@main/lib/mcpEngines.js";
import { codexDynamicToolsForProfile, resolveEngineToolSelection } from "@main/orchestration/toolSelection.js";
import { BROWSER_MCP_SERVER, BROWSER_READONLY_SUFFIXES } from "@main/mcp/toolRules.js";
import { CODEX_IDENTITY_PROMPT, joinPromptSections, fileArchitecturePrompt } from "@main/lib/systemPrompt.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { readInstructionsSource, instructionsSourcePath } from "@main/lib/appContext.js";
import { defaultSkillsRoot, engineEnabled, projectSkillRootsFor, readEnginesMap, skillNamesInRoot, skillRootsIn } from "@main/lib/skillEngines.js";
import { scriptsDir } from "@main/workflows/seed.js";
import { ASK_NATIVE_TOOL_PROMPT } from "@main/lib/askQuestion.js";
import { turnContextSections } from "@main/providers/contextPrompt.js";
import { codexProjectScopeArgs } from "./codexProjectScope.js";
import { codexMcpDisableArgs, codexTurnAllowsMcpServer } from "./codexTurnScope.js";
import {
  parseQuestions,
  formatAnswersForModel,
} from "@main/lib/askQuestion.js";
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
  browserToolsUsagePrompt,
} from "@main/browser/agentBrowserTools.js";

/* ── Codex-native capability descriptors ── */

/** Codex's own permission presets — the official Permission Profiles surface
 *  (labels and semantics lifted verbatim from the codex binary's profile
 *  definitions; NOT Mcode-invented combinations):
 *    :read-only          "Read Only"    — read workspace files; approval
 *                                        required to edit or access internet
 *    :workspace          "Default"      — read+edit workspace files, run
 *                                        commands; approval required for
 *                                        internet or out-of-workspace edits
 *                                        (identical to Agent mode)
 *    :danger-full-access "Full Access"  — edit anywhere + internet, no
 *                                        approval. Exercise caution.
 *  Values are the profile names without the leading colon ("default" lands on
 *  the same neutral slot Claude/Pi use, so new codex sessions start in the
 *  official Default profile out of the box). */
export const CODEX_PERMISSION_MODES = [
  {
    value: "read-only",
    label: "Read Only",
    icon: "shield",
    hint: "仅可读取当前工作区文件;编辑文件或访问互联网需要审批",
  },
  {
    value: "default",
    label: "Default",
    icon: "shieldCheck",
    hint: "可读写当前工作区文件并执行命令;访问互联网或修改工作区外文件需要审批",
  },
  {
    value: "full-access",
    label: "Full Access",
    icon: "shieldLock",
    color: "text-danger",
    hint: "可修改工作区外文件并访问互联网,无需审批;请谨慎使用",
  },
] as const;

type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number]["value"];

/** Legacy values from the first implementation (pre-official-presets). A
 *  session row persisted with one still resolves to its nearest official
 *  profile instead of silently falling back to Default. */
const LEGACY_MODE_MAP: Record<string, CodexPermissionMode> = {
  "codex-readonly": "read-only",
  "codex-workspace": "default",
  "codex-full": "full-access",
  "codex-bypass": "full-access",
};

/** Normalize a persisted/UI permission-mode value to an official codex
 *  profile value. Unknown/absent → "default" (codex's own default). */
function normalizeCodexMode(mode: string | undefined | null): CodexPermissionMode {
  if (!mode) return "default";
  if (mode === "read-only" || mode === "default" || mode === "full-access") return mode;
  return LEGACY_MODE_MAP[mode] ?? "default";
}

/**
 * Does a browser dynamic-tool call need the user's approval before it runs?
 *
 * Codex's dynamic tools have no `canUseTool` / `tool_call` guard of their own
 * (unlike Claude and Pi), so the decision lives here. Read-only browser tools
 * (list/snapshot/screenshot/find/scroll/wait/switch_tab/save_pdf/downloads)
 * never need approval — same set Claude and Pi use, imported rather than
 * re-listed. Everything else (navigate/click/type/keys/select/upload_file/
 * history/close_tab) is a page side effect: it runs only under full-access or
 * when the user already said "always allow" for this tool.
 */
export function codexBrowserToolNeedsApproval(
  name: string,
  mode: CodexPermissionMode,
  planModeActive: boolean,
  alwaysAllowed: boolean,
): boolean {
  if (BROWSER_READONLY_SUFFIXES.has(name)) return false;
  if (mode === "full-access" && !planModeActive) return false;
  return !alwaysAllowed;
}

/** camelCase SandboxPolicy `type` for turn/start's sandboxPolicy object form
 *  (thread/start takes the kebab SandboxMode string; turn overrides use the
 *  tagged object — see SandboxPolicy in the protocol schema). */
function sandboxPolicyType(mode: CodexPermissionMode): string {
  switch (mode) {
    case "read-only": return "readOnly";
    case "full-access": return "dangerFullAccess";
    case "default":
    default: return "workspaceWrite";
  }
}

/** The (sandbox, approvalPolicy) pair each official profile maps to. Values
 *  are the app-server's wire spellings: SandboxMode is kebab-case
 *  ("read-only"|"workspace-write"|"danger-full-access"), approvalPolicy is
 *  "on-request"|"never" ("untrusted" exists but is being retired upstream). */
function codexModeToPolicy(mode: CodexPermissionMode): {
  sandbox: string;
  approvalPolicy: string;
} {
  switch (mode) {
    case "read-only":
      return { sandbox: "read-only", approvalPolicy: "on-request" };
    case "full-access":
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
    case "default":
    default:
      return { sandbox: "workspace-write", approvalPolicy: "on-request" };
  }
}

/**
 * 会话思考档位 → `turn/start` 的 `effort`（**翻译层**，2026-10-17 加）。
 *
 * 返回要发的字符串；`undefined` = **不传 effort**（用模型默认档位）。
 *
 * ## 为什么不能原样发
 *
 * codex 的 effort 是**二进制的封闭枚举**（`@contracts/thinkingMap` 的
 * `CODEX_EFFORT_VALUES`，`minimal … persistent`，从 codex.exe 抠出来的）—— 这正是
 * 三引擎功能对齐里给 Codex 单列一个 `ThinkingCapability`（`"enum"`）的原因。用户在
 * 设置页给某档配了枚举外的值（如 `{kind:"string", value:"reasoning_high"}`）时，
 * **不能静默发**：发过去不生效（甚至可能被服务端拒），而用户以为自己配上了。所以统一
 * 走 `isCodexEffortValue` 校验 —— 不在枚举内 → `log.warn`(带模型 id、用户填的值、
 * 以及 codex 只认哪些) + **不传 effort**。
 *
 * ## 各 binding kind 的落点
 *
 * | binding | 落点 |
 * |---|---|
 * | `passthrough` / 该档没配 | 会话档位名原样发（若在枚举内；不在则同上警告 + 不传） |
 * | `off` | 不传（引擎/模型默认） |
 * | `string` | 校验后发该值（枚举外 → 警告 + 不传） |
 * | `number` / `budget` | **codex 上没有落点**（UI 不会给这两项；防御性处理：）等同 `passthrough`，记一条 info 说明原因 |
 *
 * `effort` 缺席或 `"default"` → 不传（与改动前一致）。
 */
export function resolveCodexEffort(
  effort: string | undefined,
  map: ThinkingLevelMap | undefined,
  opts?: { modelLabel?: string; log?: Pick<ProviderContext["log"], "info" | "warn"> },
): string | undefined {
  if (!effort || effort === "default") return undefined;
  const level: string = effort;
  const allowed = CODEX_EFFORT_VALUES.join("/");
  const where = opts?.modelLabel ? `模型「${opts.modelLabel}」` : "当前模型";
  /** 档位名原样发的共同出口:在枚举内就发,否则警告 + 不传。 */
  const passthrough = (): string | undefined => {
    if (isCodexEffortValue(level)) return level;
    opts?.log?.warn(
      `codex: ${where}的会话档位「${level}」不在 codex 的 effort 枚举内（codex 只认 ${allowed}），` +
        `本轮不传 effort、改用模型默认档位。`,
    );
    return undefined;
  };
  const binding = map?.[level as ThinkingLevelKey];
  if (binding) {
    switch (binding.kind) {
      case "off":
        // 这一档不支持 —— 不传,用引擎/模型默认（等价旧 Pi 形状里的 null）。
        return undefined;
      case "string": {
        const v = binding.value.trim();
        if (!v) return undefined; // 空白值 = 没配（与 Claude 侧同一处理）
        if (isCodexEffortValue(v)) return v;
        opts?.log?.warn(
          `codex: ${where}的档位「${level}」映射值「${v}」不在 codex 的 effort 枚举内` +
            `（codex 只认 ${allowed}），本轮不传 effort、改用模型默认档位。`,
        );
        return undefined;
      }
      case "number":
      case "budget":
        // codex 没有整数 effort、也没有 token 预算两条路 —— 落不到就等同
        // passthrough（UI 不会给这两项,这里是防御性处理）,留一条日志说明原因。
        opts?.log?.info(
          `codex: ${where}的档位「${level}」映射 kind="${binding.kind}" 在 codex 上没有落点` +
            `（它只认枚举内的 effort），按 passthrough 处理、原样发档位名。`,
        );
        return passthrough();
      case "passthrough":
      default:
        break;
    }
  }
  return passthrough();
}

/* ── static baseline for the model picker ── */
// No builtinModels: codex's own catalog entries (gpt-5.x via ChatGPT auth)
// are unreachable inside Mcode's isolated CODEX_HOME (no auth.json is ever
// written there), and the picker drives off the user-configured
// `codexAvailableModels` projection instead. Dynamic model/list discovery is
// a possible future enhancement, not wired today.

export class CodexAgentSdkProvider implements AgentProvider {
  readonly id = "codex-sdk";
  readonly displayName = "Codex";
  readonly capabilities: ProviderCapabilities = {
    // Approvals arrive as server→client requests bridged to the host's
    // approval card (see the requestApproval handler in startTurn).
    supportsApproval: true,
    supportsResume: true, // thread/resume via persisted threadId
    supportsStreaming: true, // item/agentMessage/delta
    supportsMcp: true, // config.toml [mcp_servers] materialization
    supportsAskUserQuestion: true, // dynamicTools ask_user_question
    // app-server's item/tool/requestUserInput is bridged by answerNativeUserInput.
    supportsElicitation: true,
    // Codex's own reasoning-effort surface, verbatim: values are the binary's
    // effort enum, labels its TUI display names, hints its model-catalog
    // preset descriptions (translated). "default" = omit effort → the model's
    // own default (e.g. GPT-5.6 defaults to medium). "persistent" exists in
    // the enum but is a Responses-API persistence mechanism, not a picker
    // option — intentionally not surfaced.
    thinkingLevels: [
      { value: "default", label: "Default", hint: "不显式指定 effort,由模型使用自身默认档位" },
      { value: "minimal", label: "Minimal", hint: "最少推理,速度优先" },
      { value: "low", label: "Low", hint: "更快的响应、较轻的推理;适合简单问答与短解释" },
      { value: "medium", label: "Medium", hint: "推理深度与时延平衡,适合日常任务" },
      { value: "high", label: "High", hint: "更深的推理,面向复杂问题" },
      { value: "xhigh", label: "XHigh", hint: "超高推理深度,面向复杂问题" },
      { value: "max", label: "Max", hint: "最大推理深度,面向最难的问题" },
      { value: "ultra", label: "Ultra", hint: "最大推理并自动任务委派(可能主动使用多个子代理)" },
    ],
    permissionModes: [...CODEX_PERMISSION_MODES],
    supportsCustomEndpoint: false, // Codex manages its own model-provider panel
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const ac = new AbortController();
    // 会话 cwd 登进 agent 桥(agent_read_document 等解析相对路径用)。见 mcp/agentEngineBridge.ts。
    registerAgentEngineSession(req.sessionId, req.cwd);

    /* ── 1. Binary + config bootstrap ── */
    const codexPath = resolveCodexBinaryPath();
    if (!codexPath) {
      return failTurn(ctx, req.sessionId, "CODEX_BINARY_MISSING", "未找到 Codex:请到 设置 → Agent 下载安装(Codex is missing — open Settings → Agent and install it).");
    }

    // Materialize config.toml (model_providers) + AGENTS.md into the isolated
    // CODEX_HOME. Cleartext keys never land here — they ride the env.
    const providers = await CodexModelsStore.listPublic();
    if (providers.length === 0) {
      return failTurn(ctx, req.sessionId, "CODEX_NO_MODEL", "Codex 未配置任何模型:请先在「设置 → 模型配置 → Codex」中添加模型端点后再发送。");
    }
    await CodexModelsStore.ensureConfigMaterialized();
    // ⚠️ **`browserToolsEnabled` 必须在拼 AGENTS.md 之前算出来。** AGENTS.md 里那段
    // 「浏览器工具用法」是一份**工具广告** —— 工具没注册就不能广告(Pi/Claude 都按这个
    // 闸门来:见 `mcodeExtension.ts` 的 `browserToolsEnabled ? [...usage] : []` 与 Claude
    // 只在启用时注入浏览器 MCP)。从前这里无条件拼进去,而工具定义在别处按开关砍掉 ——
    // 用户关掉内建浏览器后,Codex 仍从 AGENTS.md 读到 18 个 `browser_*` 工具与调用流程,
    // 于是去调一个根本没注册的工具,报错/空转;而 AGENTS.md 只在内容漂移时重写,拨开关
    // 不会重写它,那条陈旧广告会一直挂着。
    const mcpManagement = await getMcpManagement();
    const browserToolsEnabled =
      !mcpManagement.browserDisabled &&
      mcpEngineEnabled(readMcpEnginesMap(), BROWSER_MCP_SERVER, "codex") &&
      codexTurnAllowsMcpServer(BROWSER_MCP_SERVER, req.mcpServerNames);
    const hostIdentity = await ensureCodexHomeIdentity(browserToolsEnabled);
    // 【MC-100/101】按任务画像 + 预算算本轮的 dynamicTools 子集(共享选择层,唯一一份)。
    // `full`(默认)→ 全量(与改动前一致,但**显式**走画像分支);更小的画像 → 过滤 dynamicTools。
    // 放在这里(与 browserToolsEnabled 同源)保证「广告里的工具」与「注册的工具」按同一画像裁。
    const codexToolSelection = resolveEngineToolSelection("codex", {
      profile: req.toolProfile,
      budget: req.toolBudget,
      browserEnabled: browserToolsEnabled,
    });
    const mcpScopeArgs =
      req.mcpServerNames?.length || req.pluginNames?.length
        ? codexMcpDisableArgs(
            await CodexModelsStore.listMaterializedMcpServers(),
            req.mcpServerNames,
            req.pluginNames,
          )
        : [];
    if (mcpScopeArgs.length > 0) {
      ctx.log.info(`codex: disabled ${mcpScopeArgs.length / 2} MCP server(s) outside this turn's allowlists`);
    }
    // 项目级:项目插件开关 + 项目 .mcp.json(见 codexProjectScope.ts)。
    const projectScopeArgs = await codexProjectScopeArgs({
      cwd: req.cwd,
      inventory: await CodexModelsStore.listMaterializedMcpServers(),
      mcpServerNames: req.mcpServerNames,
      pluginNames: req.pluginNames,
    });

    /* ── 2. Model resolution ("providerId/modelId", Pi-style) ── */
    const configured = new Set(providers.map((p) => p.id));
    let providerId: string | null = null;
    let modelId: string | null = null;
    if (req.model && req.model !== "default") {
      const slash = req.model.indexOf("/");
      if (slash > 0 && slash < req.model.length - 1) {
        const p = req.model.slice(0, slash);
        const m = req.model.slice(slash + 1);
        if (configured.has(p)) {
          providerId = p;
          modelId = m;
        } else {
          ctx.log.warn(`codex: model "${req.model}" names unconfigured provider "${p}", falling back to the first configured provider`);
        }
      }
    }
    if (!providerId || !modelId) {
      const first = providers[0];
      providerId = first.id;
      modelId = first.models[0]?.id ?? null;
      if (modelId) ctx.log.info(`codex: falling back to first configured model "${providerId}/${modelId}"`);
    }
    if (!modelId) {
      return failTurn(ctx, req.sessionId, "CODEX_NO_MODEL", "Codex 所选模型端点没有可用模型:请在「设置 → 模型配置 → Codex」补全模型列表。");
    }

    /* ── 3. Permission mode → sandbox/approvalPolicy ── */
    const mode = normalizeCodexMode(req.permissionMode);
    const { sandbox, approvalPolicy } = codexModeToPolicy(mode);

    // Per-model context-window override (third-party models the codex catalog
    // doesn't know). Passed as a PROCESS-LOCAL `-c` CLI override — priority
    // over config.toml and scoped to this turn's app-server process, so
    // concurrent sessions with different windows never race on the shared
    // config file (verified: config/read reflects the flag value).
    const selectedModel = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
    const contextWindow = selectedModel?.contextWindow;

    /* ── 4. Spawn app-server (env carries CODEX_HOME + this turn's provider key) ── */
    // 【MC-079】只把**本轮选中端点**的凭据注入子进程 env(白名单见 codexCredentialProviders),
    // 而不是账号里所有端点的密钥;父环境里遗留的 MCODE_CODEX_KEY_* 也会被清掉。
    const env = await buildCodexEnv(ctx, codexCredentialProviders(providerId));
    // File snapshot: sandboxed writes reconstruct from the turn diff at
    // freeze (there is no pre-write hook; approval params carry only
    // grantRoot, so no recordPre path exists on this provider).
    const snapshot = getOrSetFileSnapshot(req.sessionId, () => new CodexFileSnapshot(req.cwd)) as CodexFileSnapshot;
    // "providerId/modelId"（与 composer 的 codexAvailableModels 同一形状）——
    // ContextSnapshot.model 读它就显示在上下文环 / 用量面板的按模型分桶里；
    // codex 的 tokenUsage 通知不带模型名，只能由这里递进去。
    const modelAnchor = providerId && modelId ? `${providerId}/${modelId}` : undefined;
    // User-configured per-model context window doubles as the occupancy
    // fallback when the server never reports modelContextWindow (third-party
    // endpoints often don't) — the adapter's hardcoded default would
    // understate usage for smaller windows.
    const adapter = new CodexMessageAdapter(ctx, req.sessionId, snapshot, contextWindow, async (threadId) => {
      // thread/read bootstrap for subagent transcripts (see adapter). The
      // client isn't constructed yet when the adapter is — resolve lazily.
      const client = clientRef;
      if (!client) return [];
      const res = (await client.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as { thread?: { turns?: Array<{ items?: unknown[] }> } } | undefined;
      const items: unknown[] = [];
      for (const turn of res?.thread?.turns ?? []) {
        for (const it of turn.items ?? []) items.push(it);
      }
      return items as import("./CodexMessageAdapter.js").ThreadItem[];
    }, modelAnchor);
    // 结构化输出（StartTurnRequest.structuredOutput）：Codex 没有原生
    // structured-output —— schema 指令拼进输入文本，轮末 parse 校验；失败附
    // 错误同 thread 追一轮纠错，再失败 turn.notice(structured_invalid) +
    // turn.done error。defer 模式让 adapter 的 turn.done 等校验结束后再发。
    const structuredSpec: StructuredOutputSpec | null = req.structuredOutput ?? null;
    if (structuredSpec) adapter.setDeferTurnDone();
    // Set once the onExit handler has surfaced an unexpected process death,
    // so the done() catch doesn't emit a second (duplicate) error card.
    let crashEmitted = false;
    // Late-bound client handle for the adapter's thread/read bootstrap (the
    // client is constructed below, after the adapter).
    let clientRef: CodexAppServerClient | null = null;
    const client = new CodexAppServerClient({
      codexPath,
      cwd: req.cwd,
      env,
      extraArgs: [
        // Collab spawnAgent threads are spawned by the server itself and do
        // NOT inherit the main thread's model/modelProvider (thread/start and
        // thread/resume overrides apply to the main thread only) — they fall
        // back to the process default, which without this pin is codex's
        // builtin model (gpt-5.6-sol); third-party gateways then reject the
        // unknown name (2026-09-06 实测 DeepSeek 网关 invalid_request_error)。
        // Explicit thread/turn params keep priority for the main thread, and
        // per-turn processes make the pin session-safe (no shared-file races).
        "-c",
        `model=${modelId}`,
        "-c",
        `model_provider=${providerId}`,
        ...(contextWindow ? ["-c", `model_context_window=${contextWindow}`] : []),
        "-c", "project_doc_max_bytes=0", // Host compiles bounded project instructions.
        ...mcpScopeArgs,
        ...projectScopeArgs,
      ],
      log: ctx.log,
      onExit: (code, signal) => {
        // Mid-turn process death: no client request is pending, so nothing
        // else rejects the waitTurnDone race — finalize here or the turn
        // hangs forever until the user hits stop.
        ctx.log.error(`codex app-server exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"})`);
        crashEmitted = true;
        ctx.emit({
          type: "error",
          sessionId: req.sessionId,
          message: "Codex app-server 进程意外退出,回合已终止。",
          code: "CODEX_APP_SERVER_EXITED",
        });
        if (!ac.signal.aborted && !adapter.hasTurnEnded) adapter.finalizeError();
      },
    });
    clientRef = client;
    if (contextWindow) {
      ctx.log.info(`codex: model "${providerId}/${modelId}" context window override: ${contextWindow}`);
    }

    // Plan-mode state — in-process boolean (synchronous; ctx.getPermissionMode
    // rides async IPC and races). ⚠️ ENFORCEMENT SCOPE: unlike Pi's extension
    // (whose tool_call handler gates EVERY tool), codex's native tools
    // (Bash/apply_patch) never round-trip through us, and the sandbox cannot
    // be downgraded mid-turn — so plan mode here is advisory for sandboxed
    // workspace writes (covered by the AGENTS.md prompt) and user-prompted
    // for sandbox-escaping actions (approvals still surface while active).
    // The boolean drives the plan card/composer chip lifecycle and is reset
    // in the turn finally-block if the turn ends mid-plan.
    const planMode = { active: false };
    // Turn-scoped state the request handlers close over.
    const activeTurn = { threadId: null as string | null, turnId: null as string | null };

    client.handleRequest((frame) =>
      handleServerRequest(frame, {
        ctx,
        req,
        snapshot,
        planMode,
        activeTurn,
        browserToolsEnabled,
      }),
    );
    const unsubscribe = client.onNotification((frame) => adapter.handleNotification(frame));

    // Temp files written for turn-input images (deleted in finally).
    const tempImagePaths: string[] = [];

    let finished = false;
    let turnStartPending = false;
    const done = (async () => {
      try {
        await client.start();

        // Thread identity: resume the persisted thread, or start a new one.
        // Codex app-server exposes developerInstructions on thread/start AND
        // thread/resume (not turn/start), so dynamic Mcode context rides there.
        const developerInstructions = joinPromptSections(hostIdentity, ...turnContextSections(req));
        const threadParams: Record<string, unknown> = {
          cwd: req.cwd,
          sandbox,
          approvalPolicy,
          model: modelId,
          modelProvider: providerId,
          developerInstructions,
          // Experimental (requires initialize capabilities.experimentalApi):
          // register Mcode's host-side tools (ask/plan/browser).
          dynamicTools: codexDynamicToolsForProfile(buildDynamicTools(browserToolsEnabled), codexToolSelection),
        };
        let threadId: string | null = null;
        // 【MC-057】这次是否**要求**恢复一个已有的 Codex 线程。要求了却恢复失败,必须明确
        // 失败 —— 从前 catch 掉之后直接 thread/start,于是界面还显示原历史、模型却在一个
        // 全新 thread 里从头开始,而且 onProviderSessionId 把这个隐式重建**持久化成新事实**,
        // 用户再也不知道上下文已经丢了。空串/null 表示"还没有线程可恢复",照常新建。
        const resumeRequested = Boolean(req.resumeProviderSessionId);
        if (resumeRequested) {
          try {
            // ⚠️ turn/start SILENTLY DROPS unknown fields on 0.153.4 — its
            // params have no modelProvider (verified live: an override to a
            // different provider still hit the thread's original endpoint).
            // Provider/model switches across turns MUST ride thread/resume,
            // whose params officially carry model/modelProvider/cwd/sandbox/
            // approvalPolicy as thread configuration overrides.
            const resumed = (await client.request("thread/resume", {
              threadId: req.resumeProviderSessionId,
              excludeTurns: true,
              dynamicTools: codexDynamicToolsForProfile(buildDynamicTools(browserToolsEnabled), codexToolSelection),
              cwd: req.cwd,
              sandbox,
              approvalPolicy,
              model: modelId,
              modelProvider: providerId,
              developerInstructions,
            })) as { thread?: { id?: string } } | undefined;
            threadId = resumed?.thread?.id ?? null;
            // 【ARC-008】如实报出:这一轮真的接上了原线程。
            if (threadId) ctx.onResumeOutcome?.({ kind: "RESUMED", providerSessionId: threadId });
          } catch (err) {
            // 【MC-057】恢复失败 → 明确失败,不再静默 thread/start 开新线程(见上方注释)。
            ctx.log.error(`codex: thread/resume failed for ${req.resumeProviderSessionId}: ${(err as Error).message}`);
            // 【ARC-008】结构化事实。
            ctx.onResumeOutcome?.({ kind: "FAILED", requestedId: req.resumeProviderSessionId!, error: (err as Error).message });
            throw new Error(
              `无法恢复这段对话的 Codex 底层线程(${req.resumeProviderSessionId}):${(err as Error).message}。` +
                `已拒绝发送 —— 静默开一个新线程会让模型丢掉之前的执行结果与约束。请重试,或新建一个会话。`,
            );
          }
        }
        if (!threadId) {
          // 【MC-057】要求恢复却没拿到 threadId(resume 返回空)→ 同样不许静默新建。
          if (resumeRequested) {
            // 【ARC-008】结构化事实:resume 返回空。
            ctx.onResumeOutcome?.({ kind: "FAILED", requestedId: req.resumeProviderSessionId!, error: "thread/resume 未返回可用的线程" });
            throw new Error(
              `无法恢复这段对话的 Codex 底层线程(${req.resumeProviderSessionId}):thread/resume 未返回可用的线程。` +
                `已拒绝发送 —— 静默开一个新线程会让模型丢掉之前的执行结果与约束。请重试,或新建一个会话。`,
            );
          }
          const started = (await client.request("thread/start", threadParams)) as { thread?: { id?: string } } | undefined;
          threadId = started?.thread?.id ?? null;
          // 【ARC-008】本就是全新线程,不是降级。
          if (threadId) ctx.onResumeOutcome?.({ kind: "FRESH_EXPLICIT" });
        }
        if (!threadId) throw new Error("thread/start 未返回 threadId");
        activeTurn.threadId = threadId;
        // Item notifications carry threadId — the adapter routes non-main
        // thread items to the subagent transcript viewer.
        adapter.setMainThreadId(threadId);
        ctx.onProviderSessionId?.(threadId);

        // Register Mcode's skill roots so the model can invoke user skills
        // ($name) — the universal library filtered by the per-engine matrix
        // (see skillRootsFor), the CURRENT PROJECT's skills (<cwd>/.claude/
        // skills — the same root the settings UI lists/copies, 【MC-094】), plus
        // the skills directories of ENABLED plugins, all filtered by the same
        // matrix (see pluginSkillRootsFor).
        // Best-effort: failure only means no skills.
        try {
          const { getEnabledPluginSkillRoots } = await import("@main/plugins/pluginManager.js");
          await client.request("skills/extraRoots/set", {
            extraRoots: [
              ...skillRootsFor(req.skills),
              ...projectSkillRootsFor(req.cwd, "codex", req.skills),
              ...(await pluginSkillRootsFor(req.pluginNames, req.skills, req.cwd)),
            ],
          });
        } catch (err) {
          ctx.log.warn(`codex: skills/extraRoots/set failed: ${(err as Error).message}`);
        }

        // Turn input: text + images (local files — codex takes paths, not
        // inline base64). 结构化输出时把 schema 指令拼在 prompt 末尾。
        const input: Array<Record<string, unknown>> = [
          { type: "text", text: structuredSpec ? req.prompt + buildStructuredOutputPrompt(structuredSpec) : req.prompt },
        ];
        if (req.images?.length) {
          for (const img of req.images) {
            const p = await writeTempImage(img.data, img.mimeType);
            tempImagePaths.push(p);
            input.push({ type: "localImage", path: p });
          }
        }

        // Per-turn overrides: model/effort/sandbox/approvalPolicy are official
        // turn/start params. modelProvider is deliberately NOT sent here —
        // turn/start has no such field and silently drops it (provider
        // switches ride thread/resume above). 结构化输出的纠错轮复用同一组
        // overrides，保证两轮跑在同一配置上。
        //
        // effort 经 `resolveCodexEffort`（2026-10-17 加）：按**当前模型**的
        // `thinkingLevelMap` 把会话档位翻成 codex 认识的值；枚举外的映射被拦下并
        // 记 warn、不传 effort（见该函数）。`"default"`/没配 → 不传。
        const mappedEffort = resolveCodexEffort(req.effort, selectedModel?.thinkingLevelMap, {
          modelLabel: `${providerId}/${modelId}`,
          log: ctx.log,
        });
        const turnOverrides: Record<string, unknown> = {
          model: modelId,
          approvalPolicy,
          sandboxPolicy: { type: sandboxPolicyType(mode) },
          ...(mappedEffort ? { effort: mappedEffort } : {}),
        };

        // 起一轮并等它终态：turn/start 立即返回，完成靠通知（waitTurnDone 在
        // turn/completed 时 resolve）。abort 竞速等待 —— 中断时请求
        // turn/interrupt，再给通知泵一小段宽限投递终态；仍未终态则按 abort
        // 收尾。主轮与结构化输出的纠错轮共用。
        const runTurnAndWait = async (
          input: Array<Record<string, unknown>>,
        ): Promise<TurnDoneReason> => {
          // 用户已经点了停止(例如卡在 thread/start 时):不要再把提示词发给模型。
          if (ac.signal.aborted) throw new Error("codex turn aborted before turn/start");
          // Keep transport alive long enough to learn the new turn ID and
          // interrupt it. Immediate disposal during this round trip loses the
          // only addressable cancellation path (including corrective turns).
          activeTurn.turnId = null;
          turnStartPending = true;
          let startAbortTimer: ReturnType<typeof setTimeout> | undefined;
          const abortPendingStart = (): void => {
            startAbortTimer = setTimeout(() => { void client.dispose().catch(() => undefined); }, 2000);
          };
          ac.signal.addEventListener("abort", abortPendingStart, { once: true });
          try {
            const startedTurn = (await client.request("turn/start", {
              threadId,
              input,
              ...turnOverrides,
            })) as { turn?: { id?: string } } | undefined;
            activeTurn.turnId = startedTurn?.turn?.id ?? null;
          } finally {
            turnStartPending = false;
            ac.signal.removeEventListener("abort", abortPendingStart);
            clearTimeout(startAbortTimer);
          }

          const abortedPromise = new Promise<"interrupted">((resolve) => {
            if (ac.signal.aborted) resolve("interrupted");
            else ac.signal.addEventListener("abort", () => resolve("interrupted"), { once: true });
          });
          const turnReason = await Promise.race([adapter.waitTurnDone(), abortedPromise]);

          if (turnReason === "interrupted" && activeTurn.turnId) {
            try {
              await client.request("turn/interrupt", { threadId, turnId: activeTurn.turnId });
            } catch {
              /* turn may have completed concurrently */
            }
          }

          // Give the notification pump a short grace to deliver the terminal
          // turn/completed (it may still be in flight right after interrupt).
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            adapter.waitTurnDone(),
            new Promise((r) => { graceTimer = setTimeout(r, 2000); }),
          ]);
          clearTimeout(graceTimer);
          if (!adapter.hasTurnEnded) {
            adapter.finalizeAborted();
          }
          return turnReason;
        };

        // 结构化输出守卫：轮末 parse 最终回复；失败附校验错误同 thread 追一轮
        // 纠错，再失败 → turn.notice(structured_invalid)，turn 以 error 收尾。
        const runStructuredGuard = async (): Promise<TurnDoneReason> => {
          let parsed = parseStructuredOutput(adapter.getFinalTurnText(), structuredSpec!);
          if (parsed.ok) return "end_turn";
          ctx.log.warn(
            `codex: structured output invalid, one corrective turn: ${parsed.error.slice(0, 200)}`,
          );
          adapter.beginCorrectiveTurn();
          const corrective = structuredSpec
            ? [{ type: "text", text: buildCorrectivePrompt(structuredSpec, parsed.error) }]
            : [];
          const retryReason = await runTurnAndWait(corrective);
          if (retryReason !== "end_turn") return retryReason;
          parsed = parseStructuredOutput(adapter.getFinalTurnText(), structuredSpec!);
          if (parsed.ok) return "end_turn";
          ctx.emit({
            type: "turn.notice",
            sessionId: req.sessionId,
            kind: "structured_invalid",
            message: `结构化输出（${structuredSpec!.name}）重试后仍不符合 schema，本轮按错误结束：${parsed.error}`,
          });
          return "error";
        };

        const reason = await runTurnAndWait(input);

        let finalReason = reason;
        if (structuredSpec && reason === "end_turn" && !ac.signal.aborted) {
          finalReason = await runStructuredGuard();
        }
        adapter.flushDeferredTurnDone(finalReason);
        await adapter.flushFinal();
      } catch (err) {
        if (ac.signal.aborted) {
          if (!adapter.hasTurnEnded) adapter.finalizeAborted();
          // defer 模式（结构化输出）下 finishTurn 没发 turn.done，这里补上；
          // 普通模式下是无害空操作。
          adapter.flushDeferredTurnDone("interrupted");
          await adapter.flushFinal();
        } else {
          ctx.log.error(`codex turn failed: ${(err as Error).message}`);
          // A crash already surfaced its own error card via onExit — don't
          // duplicate it with the transport-failure card here.
          if (!crashEmitted) {
            ctx.emit({
              type: "error",
              sessionId: req.sessionId,
              message: (err as Error).message,
              code: "CODEX_SDK_ERROR",
            });
          }
          if (!adapter.hasTurnEnded) adapter.finalizeError();
          adapter.flushDeferredTurnDone("error");
          await adapter.flushFinal();
        }
      } finally {
        unsubscribe();
        finished = true;
        // The turn ended with the model still in plan mode (interrupt, error,
        // or the model simply stopped without calling exit_plan_mode) — the
        // per-turn planMode closure dies here, so reset the renderer's plan
        // state to match or the composer chip stays stuck on plan.
        if (planMode.active) {
          planMode.active = false;
          ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "default", source: "model" });
          ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan: "", phase: "cleared" });
        }
        // Codex takes file paths for turn images — delete the temp copies.
        for (const p of tempImagePaths) {
          try {
            await fs.unlink(p);
          } catch {
            /* best-effort */
          }
        }
        try {
          await client.dispose();
        } catch {
          /* process already gone */
        }
      }
    })();

    return {
      done,
      interrupt: () => {
        ac.abort();
        adapter.markAborted();
        // 回合还没开始(进程冷启动 / initialize / thread/start 还在等):
        // turn/interrupt 无从发起,而这些请求最长要等 120 秒才超时,等它们回来后还会照常
        // 发出 turn/start。直接结束这个只属于本轮的 app-server 进程 —— 挂起的请求立刻
        // 失败,done 走「已中断」分支收尾。turn/start 窗口由上面的有界等待处理。
        if (!activeTurn.turnId && !turnStartPending) void client.dispose().catch(() => undefined);
      },
      isRunning: () => !finished && !ac.signal.aborted,
    };
  }

  /**
   * **Codex 那一批斜杠命令，在我们的路上跑不起来**（2026-09-21 实测）。
   *
   * ## 先纠正一个说法
   *
   * 上一版这里写的是"Codex 根本没有斜杠命令"—— **不对**。它有，而且不少：
   * `/compact` `/new` `/model` `/permissions` `/review` `/status` `/fork`
   * `/side` `/init` `/mcp` `/skills` `/rename` `/personality` `/config`
   * `/statusline`，还都带说明（从 `codex.exe` 里那段 TUI 帮助文本挖出来的）。
   *
   * ## 但它们是**客户端**的功能，不是 agent 的
   *
   * 实测：对 app-server 起一个 thread，把 `/status` 当文本发进 `turn/start` ——
   * 回来的 `item/started` 是 `{"type":"userMessage","content":[{"text":"/status"}]}`，
   * 也就是**原样当成用户消息**，然后直接送去模型。没有任何"识别为命令"的迹象。
   *
   * 换句话说：Codex 的斜杠命令在 **TUI 那一层**（本地解析、本地执行、不发给模型），
   * 而 app-server 协议里没有对应的方法，也没有"把这条文本当命令跑"的开关。
   * 列出来只会让用户点了之后看着那句话被发给模型 —— 比不列更糟。
   *
   * 所以 `supported: false` 的含义是**"这家提供的命令，我们这条路执行不了"**，
   * 不是"这家没有命令"。见 `@contracts/ipc` 的 `ProviderCommandsResult`。
   */
  async listCommands(): Promise<{ supported: boolean; commands: EngineCommandEntry[] }> {
    return { supported: false, commands: [] };
  }

  /** Version probe for the settings UI. */
  async healthCheck(probeCtx?: ProviderHealthCheckContext): Promise<{ ok: boolean; version?: string; error?: string }> {
    // 【MC-076】拿宿主的受信上下文:超时到点会 abort。这条探测已经有自己的 10s
    // execFile 超时(相对好),但仍要接宿主的预算:abort 时**终止并回收**版本命令的
    // 子进程,不让它继续挂着。
    const signal = probeCtx?.signal;
    try {
      const codexPath = resolveCodexBinaryPath();
      if (!codexPath) return { ok: false, error: "未找到 Codex(设置 → Agent 可安装)" };
      if (signal?.aborted) return { ok: false, error: "健康检查已取消（宿主超时）" };
      // Async on purpose: spawnSync froze the whole main process (every window)
      // for up to the 10s timeout, and also starved providerHealth's own
      // timeout race. Non-zero exit keeps spawnSync semantics: a status, not a
      // spawn error (some builds print the version and still exit non-zero).
      const r = await new Promise<{ error?: Error; status: number | null; stdout: string }>((resolve) => {
        // abort → 终止子进程(execFile 的 callback 会收到非零退出,自然 resolve)。
        const onAbort = (): void => {
          try {
            child.kill();
          } catch {
            /* 已退出,忽略 */
          }
        };
        const child = execFile(
          codexPath,
          ["--version"],
          { timeout: 10_000, encoding: "utf-8", windowsHide: true },
          (err, stdout) => {
            signal?.removeEventListener("abort", onAbort);
            const out = typeof stdout === "string" ? stdout : "";
            if (!err) resolve({ status: 0, stdout: out });
            else if (typeof err.code === "number") resolve({ status: err.code, stdout: out });
            else resolve({ error: err, status: null, stdout: out });
          },
        );
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      // abort 期间被终止:如实报取消,不把 kill 造成的非零退出说成"版本探测失败"。
      if (signal?.aborted) return { ok: false, error: "健康检查已取消（宿主超时）" };
      if (r.error) return { ok: false, error: r.error.message };
      const version = (r.stdout ?? "").trim().split("\n")[0] || undefined;
      return { ok: r.status === 0 || Boolean(version), version };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/* ── helpers ── */

/** Emit an error + error-reason turn.done and return a dead handle. */
function failTurn(
  ctx: ProviderContext,
  sessionId: string,
  code: string,
  message: string,
): TurnHandle {
  ctx.log.error(`codex: ${message}`);
  ctx.emit({ type: "error", sessionId, message, code });
  ctx.emit({ type: "turn.done", sessionId, reason: "error" });
  return { done: Promise.resolve(), interrupt: () => {}, isRunning: () => false };
}

/** 【MC-079】本轮 app-server 需要凭据的端点白名单 —— 只含本轮的 model_provider。
 *
 *  RuntimeManager 的模型回退是**另一个回合、另一个 providerId**(各起一个 app-server),
 *  每个进程只带自己那一轮的密钥,所以单轮内不需要放多个端点凭据。若将来真要支持官方
 *  SDK 的**进程内** fallback(同一 app-server 依次打多个端点),在这里显式列入必要的
 *  供应商 id —— **不要**退化成「把 listPublic() 里全部端点都注进去」。 */
function codexCredentialProviders(providerId: string): string[] {
  return [providerId];
}

/** Child env: isolated CODEX_HOME + ONLY this turn's selected provider key (the
 *  TOML env_key for the pinned `model_provider` picks it up) + inherited
 *  PATH/HOME for sandbox helpers. Keys are decrypted per turn and never persisted.
 *
 *  【MC-079】凭据最小化:每轮 app-server 只携带**本轮选中端点**的密钥,而不是账号里
 *  所有端点的密钥。从前这里遍历 listPublic() 把每个 provider 的 key 都注入,于是单个
 *  子进程承载了全部端点凭据 —— 一旦 Codex 把子进程 env 透给原生 Bash/工具、扩展或调试
 *  日志,损失面会跨模型供应商。另外显式删掉父 process.env 里遗留的所有
 *  `MCODE_CODEX_KEY_*`,防止宿主自己的环境变量(测试、外层脚本、旧进程)被意外继承,
 *  再按白名单重放本轮的密钥。 */
async function buildCodexEnv(
  ctx: ProviderContext,
  providerIds: readonly string[],
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CODEX_HOME: codexHomePath(),
  };
  // 先清空父环境可能带来的任何 MCODE_CODEX_KEY_*(只删我们注入的那一族,不误伤别的)。
  for (const name of Object.keys(env)) {
    if (/^MCODE_CODEX_KEY_/i.test(name)) delete env[name];
  }
  // 只解密并注入白名单端点的密钥。hasApiKey 却解不出来时报警(与旧行为一致)。
  const publicById = new Map((await CodexModelsStore.listPublic()).map((p) => [p.id, p]));
  for (const id of providerIds) {
    const key = CodexModelsStore.resolveApiKey(id);
    if (key) {
      env[codexKeyEnvVar(id)] = key;
    } else if (publicById.get(id)?.hasApiKey) {
      ctx.log.warn(`codex: failed to decrypt key for provider "${id}"`);
    }
  }
  return env;
}

/** Mcode universal-library skill roots made visible to codex: the universal
 *  library (~/.mcode/skills) filtered through the per-engine matrix. The
 *  project's .claude/skills used to live here too; it now rides
 *  {@link projectSkillRootsFor} (the project root is a separate channel — see
 *  the skills/extraRoots/set call).
 *
 *  Unrestricted → the whole root, codex's own scanner walks it (the
 *  historical behavior, zero risk). Restricted → the enabled skills' own
 *  directories, because `skills/extraRoots/set` has no name filter and each
 *  root is delivered wholesale. ⚠️ Whether codex treats a root that directly
 *  contains SKILL.md as one skill is UNVERIFIED (the 0.153.4 binary is
 *  closed-source; the npm package ships no scanner source) — confirm on a
 *  live session during acceptance.
 *
 *  Delegates to the shared {@link skillRootsIn} matcher so the global and
 *  project channels can't drift into two different per-engine filters. */
function skillRootsFor(allowNames?: readonly string[]): string[] {
  return skillRootsIn(defaultSkillsRoot(), "codex", allowNames);
}

/**
 * Plugin skill roots for codex, filtered by the same per-engine matrix the
 * universal library obeys: a root whose skills are all enabled is handed over
 * whole (the historical behavior); one with only some enabled contributes just
 * those skills' own directories (extraRoots has no name filter — each root is
 * delivered wholesale); a root whose every skill is disabled for codex
 * contributes nothing. Builtin skills stay out of the matrix and always pass.
 */
async function pluginSkillRootsFor(
  pluginNames?: readonly string[],
  allowNames?: readonly string[],
  projectPath?: string,
): Promise<string[]> {
  const { getEnabledPluginSkillRoots } = await import("@main/plugins/pluginManager.js");
  const enginesMap = readEnginesMap(defaultSkillsRoot());
  const allow = allowNames?.length ? new Set(allowNames) : null;
  const out: string[] = [];
  for (const root of await getEnabledPluginSkillRoots(pluginNames, "codex-sdk", projectPath)) {
    const byName = skillNamesInRoot(root);
    const enabled = [...byName.keys()].filter(
      (name) => (!allow || allow.has(name)) && engineEnabled(enginesMap, name, "codex"),
    );
    if (!allow && enabled.length === byName.size) out.push(root);
    else for (const n of enabled) out.push(byName.get(n)!);
  }
  return out;
}

/** Write CODEX_HOME/AGENTS.md — Codex's global instructions file, which we
 *  own inside the isolated home. Idempotent (writes only on drift).
 *
 *  组装链里并入「全局指令」(设置面板的事实源 <dataRoot>/context/instructions.md,
 *  见 lib/appContext.ts):claude 的同名内容物化到 ~/.mcode/CLAUDE.md,pi 会话启动
 *  时直读同一份 —— 三引擎共用一条指令配置。空内容时不加段(组装链语义)。 */
async function ensureCodexHomeIdentity(browserToolsEnabled: boolean): Promise<string> {
  const dir = codexHomePath();
  await fs.mkdir(dir, { recursive: true });
  const instructions = readInstructionsSource(instructionsSourcePath(dataRoot())).trim();
  const content = `${joinPromptSections(
    CODEX_IDENTITY_PROMPT,
    instructions,
    // The user's file architecture — see fileArchitecturePrompt. The drift check
    // below means a data-root change rewrites AGENTS.md on the next call, so the
    // paths here can't go stale silently.
    // 【MC-044】engine="codex":它没有与 Claude/Pi 同名的文件工具(读写走自己的
    // shell/exec),提示词因此**不点名**任何读工具,只写「用你当前可用的读取方式」。
    fileArchitecturePrompt(dataRoot(), scriptsDir(), "codex"),
    ASK_NATIVE_TOOL_PROMPT,
    PLAN_MODE_PROMPT,
    // ⚠️ **浏览器工具广告只在启用时才拼。** 工具定义按同一个开关砍(见
    // `buildDynamicTools`),广告不能比工具更宽 —— 否则关掉内建浏览器后模型照 AGENTS.md
    // 去调一个没注册的工具。`browserToolsEnabled` 进了 content,所以拨开关会让下面的
    // 漂移比较判不等、当场重写(不再是"拨了不生效")。
    browserToolsEnabled ? browserToolsUsagePrompt() : "",
    process.platform === "win32" ? WIN32_PATH_HINT : "",
  )}\n`;
  const file = path.join(dir, "AGENTS.md");
  try {
    const prev = await fs.readFile(file, "utf-8");
    if (prev === content) return content;
  } catch {
    /* first write */
  }
  await fs.writeFile(file, content, "utf-8");
  return content;
}

const WIN32_PATH_HINT = [
  `## Windows 路径`,
  `本机 Windows 下 bash 可能运行在 WSL 或 Git Bash 中。写文件时始终使用 Windows 原生路径(如 D:\\workspace\\file.ts);不要使用 /mnt/<drive>/... 形式的路径。`,
].join("\n");

const PLAN_MODE_PROMPT = [
  `## 计划模式工具`,
  `当任务复杂或涉及重要修改时,先制定计划再执行:`,
  `1. 调用 enter_plan_mode 进入计划模式`,
  `2. 使用只读方式充分调研;如需验证可写文件/执行命令,但每个修改操作都需用户审批`,
  `3. 调用 exit_plan_mode({plan: "你的详细计划"}) 提交计划给用户审批`,
  `4. 用户批准后退出计划模式开始执行;拒绝则留在计划模式修改计划`,
  `计划文本应为结构化的 Markdown,包含目标、步骤、影响范围。`,
  `仅当任务复杂、多步或涉及重要修改时才进入计划模式;简单、单步或目标明确的任务直接执行,不要走计划流程。`,
].join("\n");

/** Server→client request routing context. */
interface RequestDeps {
  ctx: ProviderContext;
  req: StartTurnRequest;
  snapshot: CodexFileSnapshot;
  planMode: { active: boolean };
  activeTurn: { threadId: string | null; turnId: string | null };
  /** MCP panel's built-in browser switch, read at turn start. Enforced at
   *  invocation (not just registration) because dynamicTools persist in the
   *  thread rollout and thread/resume cannot re-register them — a resumed
   *  thread keeps advertising browser_* even when disabled. */
  browserToolsEnabled: boolean;
}

/** Dispatch the server's request frames: approvals, user input, dynamic
 *  tool calls. */
async function handleServerRequest(
  frame: ServerRequestFrame,
  deps: RequestDeps,
): Promise<unknown> {
  const { method, params } = frame;
  const p = (params ?? {}) as Record<string, unknown>;

  // ── Approvals (v2 item/* + legacy aliases) ──
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    return decideApproval(deps, {
      toolName: "Bash",
      input: { command: p.command ?? "" },
      description: typeof p.reason === "string" ? p.reason : undefined,
      p,
    });
  }
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    // NOTE: the params carry only grantRoot (the directory being granted),
    // not per-file paths — pre-turn content reconstruction rides the turn
    // diff (CodexFileSnapshot), not the approval hook.
    return decideApproval(deps, {
      toolName: "file_change",
      input: {
        ...(typeof p.grantRoot === "string" ? { grantRoot: p.grantRoot } : {}),
      },
      description: typeof p.reason === "string" ? p.reason : undefined,
      p,
    });
  }

  // ── Codex-native user input (elicitation) ──
  if (method === "item/tool/requestUserInput") {
    return answerNativeUserInput(p, deps);
  }

  // ── Dynamic tool invocations (our registered host tools) ──
  if (method === "item/tool/call") {
    return invokeDynamicTool(p, deps);
  }

  // Unknown server request — respond with empty result so the server
  // unblocks (calibrate against the generated schema as new kinds appear).
  deps.ctx.log.warn(`codex: unhandled server request "${method}"`);
  return {};
}

/** Shared decision pipeline for both approval kinds. */
async function decideApproval(
  deps: RequestDeps,
  args: {
    toolName: string;
    input: unknown;
    description?: string;
    p: Record<string, unknown>;
  },
): Promise<unknown> {
  const { ctx, req } = deps;
  // Live mode read — a mid-turn mode flip applies to the next approval.
  const mode = normalizeCodexMode(ctx.getPermissionMode?.() ?? req.permissionMode);

  // Full Access maps to approvalPolicy "never" (official semantics: act
  // without asking). The server normally won't ask under that policy; this
  // covers an escalation prompt arriving anyway — auto-accept mirrors "never".
  if (mode === "full-access") {
    return { decision: "accept" };
  }

  const alwaysAllowed = ctx.isToolAlwaysAllowed?.(args.toolName) ?? false;
  if (alwaysAllowed) {
    return codexApprovalReply(null, true);
  }

  const requestApproval = ctx.requestApproval;
  if (!requestApproval) {
    // No bridge (shouldn't happen) — deny safe.
    return codexApprovalReply(null);
  }
  const approvalReq: ApprovalRequest = {
    requestId: randomUUID(),
    toolName: args.toolName,
    input: args.input,
    ...(args.description ? { description: args.description } : {}),
  };
  const decision = await requestApproval(approvalReq);

  // Keep the host-side remembered choice, but never issue a Codex server
  // session grant: it cannot be revoked when the user switches mode mid-turn.
  return codexApprovalReply(decision);
}

/** Codex's native user-input request ({questions: [{title, options?}]},
 *  answers keyed by question title). Bridges to the same renderer question
 *  card as our dynamic ask_user_question tool. */
async function answerNativeUserInput(p: Record<string, unknown>, deps: RequestDeps): Promise<unknown> {
  const { ctx } = deps;
  const requestUserInput = ctx.requestUserInput;
  const rawQuestions = Array.isArray(p.questions) ? p.questions : [];
  const questions = rawQuestions.map((q) => {
    const obj = (q ?? {}) as { title?: string; options?: string[] | null };
    const title = typeof obj.title === "string" ? obj.title : "问题";
    return {
      header: title.slice(0, 20),
      question: title,
      multiSelect: false,
      options: (obj.options ?? []).filter((o): o is string => typeof o === "string").map((label) => ({ label })),
    };
  });
  if (!requestUserInput || questions.length === 0) {
    return { answers: {} };
  }
  const decision = await requestUserInput({ requestId: randomUUID(), questions });
  if (decision.dismissed) {
    return { answers: {} };
  }
  // answers: {[questionTitle]: {answers: string[]}}
  const out: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    const v = decision.answers[q.question];
    if (v == null) continue;
    out[q.question] = { answers: Array.isArray(v) ? v : [String(v)] };
  }
  return { answers: out };
}

/* ── dynamic tools ── */


/** Execute a dynamic-tool invocation from the server against host bridges. */
async function invokeDynamicTool(p: Record<string, unknown>, deps: RequestDeps): Promise<unknown> {
  const name = typeof p.tool === "string" ? p.tool : typeof p.name === "string" ? p.name : "";
  // `let`: the browser-approval gate below may swap in a user-edited input.
  let args = (p.arguments ?? p.args ?? {}) as Record<string, unknown>;
  const { ctx, req, planMode } = deps;
  const text = (t: string): unknown => ({ success: true, contentItems: [{ type: "inputText", text: t }] });
  const fail = (t: string): unknown => ({ success: false, contentItems: [{ type: "inputText", text: t }] });

  if (isAppToolName(name)) {
    const result = await invokeAppEngineTool(name, args, req.sessionId, ctx);
    // 与 browser_* 同一份 `toContent`:app 工具里也可能带 **image 块**(如
    // `app_ui screenshot_panel` 截的面板 PNG)。从前这里把每个块一律拍成 `inputText`,
    // 于是 image 块被**静默丢掉** —— 截图工具在 Codex 上就白截了(报告 D10 的"静默失败")
    // 且与 browser_screenshot 待遇不一致。`toContent` 会把 image 块转成 Codex 的
    // `inputImage`(data URL)—— 两个工具因此走同一条出口。
    const converted = toContent(result) as { contentItems: unknown[] };
    return { success: !result.isError, contentItems: converted.contentItems };
  }

  if (name.startsWith("memory_")) {
    const result = await invokeMemoryTool(name, args, req.sessionId, ctx);
    return { success: !result.isError, contentItems: textBlocksOf(result).map((text) => ({ type: "inputText", text })) };
  }

  // 资料库工具:只读的直接跑,写操作先过审批(动态工具没有 codex 自己的审批钩子)。
  // 「完全访问」档照官方语义不问 —— 与 decideApproval 对 full-access 的处理一致;
  // 计划模式下一律问。
  if (isLibraryToolName(name)) {
    const mode = normalizeCodexMode(ctx.getPermissionMode?.() ?? req.permissionMode);
    const result = await invokeLibraryToolGated(name, args, req.sessionId, ctx, {
      autoApprove: mode === "full-access" && !planMode.active,
    });
    return { success: !result.isError, contentItems: textBlocksOf(result).map((text) => ({ type: "inputText", text })) };
  }

  // 工作流工具:与库工具同一套审批取向(只读直接跑,写操作按权限档问)。名字前缀混杂
  // (workflow_ / node_ / agent_ / session_),所以按工具表认名字而不是看前缀。
  if (workflowEngineBridge.has(name)) {
    const mode = normalizeCodexMode(ctx.getPermissionMode?.() ?? req.permissionMode);
    const result = await workflowEngineBridge.invokeGated(name, args, req.sessionId, ctx, {
      autoApprove: mode === "full-access" && !planMode.active,
    });
    return { success: !result.isError, contentItems: textBlocksOf(result).map((text) => ({ type: "inputText", text })) };
  }

  // Agent 只读工具(agent_read_document / agent_read_image / agent_context)。只读,
  // invokeGated 直接过;走 gated 是为了统一"没有审批通道就拒绝"的语义(它不会走到那步)。
  if (isAgentToolName(name)) {
    const result = await invokeAgentToolGated(name, args, req.sessionId, ctx, { autoApprove: true });
    return { success: !result.isError, contentItems: textBlocksOf(result).map((text) => ({ type: "inputText", text })) };
  }

  // MCP panel's built-in browser switch. Registration-time filtering can't
  // cover resumed threads (dynamicTools persist in the rollout), so rejected
  // calls are answered here — the tool stays visible to the model but every
  // invocation returns this error instead of touching the browser.
  if (name.startsWith("browser_") && !deps.browserToolsEnabled) {
    return fail("内置浏览器工具已停用(设置 → MCP)。请改用其他方式完成任务。");
  }

  // 浏览器工具:只读的(scroll/wait/find/snapshot/screenshot…)直接跑,有副作用的
  // (navigate/click/type/keys/select/upload_file/history/close_tab)按当前权限档审批。
  // Codex 的动态工具**没有** canUseTool / tool_call 那种守卫,不在这里问就等于**完全
  // 绕过审批** —— 只读档下也能导航、点击、上传本地文件、跑页面 JS。语义与 Claude 的
  // canUseTool、Pi 的 tool_call 守卫一致(见 toolRules.ts 的 BROWSER_READONLY_SUFFIXES,
  // 唯一的一份清单),别另写一份放行表。
  if (name.startsWith("browser_") && deps.browserToolsEnabled) {
    const mode = normalizeCodexMode(ctx.getPermissionMode?.() ?? req.permissionMode);
    const needsApproval = codexBrowserToolNeedsApproval(
      name,
      mode,
      planMode.active,
      ctx.isToolAlwaysAllowed?.(name) ?? false,
    );
    if (needsApproval) {
      if (!ctx.requestApproval) {
        return fail(`浏览器工具「${name}」需要用户批准,但审批通道不可用;没有执行。`);
      }
      const decision = await ctx.requestApproval({ requestId: randomUUID(), toolName: name, input: args });
      if (!decision.allow) {
        return fail(decision.reason ? `用户未批准浏览器操作:${decision.reason}` : "用户未批准浏览器操作。");
      }
      if (decision.updatedInput !== undefined) args = decision.updatedInput as Record<string, unknown>;
    }
  }

  try {
    switch (name) {
      case "ask_user_question": {
        const requestUserInput = ctx.requestUserInput;
        if (!requestUserInput) return text("提问不可用");
        const questions = parseQuestions(args);
        if (questions.length === 0) return text("参数格式错误:未解析出有效问题");
        const decision = await requestUserInput({
          requestId: randomUUID(),
          questions,
        });
        if (decision.dismissed) {
          return text("用户关闭了提问,未提供答案,请继续当前任务");
        }
        return text(formatAnswersForModel(decision.answers, questions));
      }
      case "enter_plan_mode": {
        planMode.active = true;
        ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "plan", source: "model" });
        ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan: "", phase: "drafting" });
        return text(
          "已进入计划模式。请只读调研(必要时经审批验证),完成后调用 exit_plan_mode 提交计划。",
        );
      }
      case "exit_plan_mode": {
        const plan = typeof args.plan === "string" ? args.plan : "";
        ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan, phase: "ready" });
        const requestPlanApproval = ctx.requestPlanApproval;
        if (!requestPlanApproval) {
          planMode.active = false;
          ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "default", source: "model" });
          return text("计划审批不可用,已自动退出计划模式。");
        }
        try {
          const decision = await requestPlanApproval({ requestId: randomUUID(), plan });
          if (decision.approved) {
            const finalPlan = decision.editedPlan ?? plan;
            planMode.active = false;
            ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "default", source: "model" });
            const feedback = decision.feedback?.trim();
            return text(`计划已批准,开始执行:\n\n${finalPlan}${feedback ? `\n\n用户调整意见:${feedback}` : ""}`);
          }
          const reason = decision.reason ?? "用户未提供理由";
          ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan, phase: "drafting" });
          return text(`计划被用户拒绝。原因:${reason}。你仍处于计划模式,请修改计划后重新调用 exit_plan_mode。`);
        } catch (err) {
          planMode.active = false;
          ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan: "", phase: "cleared" });
          ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "default", source: "model" });
          throw err;
        }
      }
      case "browser_list":
        return toContent(browserList(req.cwd));
      case "browser_navigate":
        return toContent(
          await browserNavigate(
            {
              url: String(args.url ?? ""),
              browserId: optStr(args.browserId),
              device: optDevice(args.device),
              newTab: args.newTab === true,
            },
            req.cwd,
          ),
        );
      case "browser_snapshot":
        return toContent(await browserSnapshot({ browserId: optStr(args.browserId), projectPath: req.cwd }));
      case "browser_click":
        return toContent(
          await browserClick({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: optStr(args.selector),
            coordinateX: typeof args.coordinateX === "number" ? args.coordinateX : undefined,
            coordinateY: typeof args.coordinateY === "number" ? args.coordinateY : undefined,
            browserId: optStr(args.browserId),
            projectPath: req.cwd,
          }),
        );
      case "browser_type":
        return toContent(
          await browserType({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: optStr(args.selector),
            text: typeof args.text === "string" ? args.text : "",
            clear: args.clear !== false,
            browserId: optStr(args.browserId),
            projectPath: req.cwd,
          }),
        );
      case "browser_keys":
        return toContent(
          await browserKeys({ keys: String(args.keys ?? ""), browserId: optStr(args.browserId), projectPath: req.cwd }),
        );
      case "browser_scroll":
        return toContent(
          await browserScroll({
            direction: args.direction === "up" ? "up" : "down",
            pages: typeof args.pages === "number" ? args.pages : undefined,
            selector: optStr(args.selector),
            browserId: optStr(args.browserId),
            projectPath: req.cwd,
          }),
        );
      case "browser_wait":
        return toContent(
          await browserWait({
            selector: optStr(args.selector),
            text: optStr(args.text),
            seconds: typeof args.seconds === "number" ? args.seconds : undefined,
            timeoutSeconds: typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined,
            browserId: optStr(args.browserId),
            projectPath: req.cwd,
          }),
        );
      case "browser_history":
        return toContent(
          await browserHistory({
            action: args.action as "back" | "forward" | "reload",
            browserId: optStr(args.browserId),
            projectPath: req.cwd,
          }),
        );
      case "browser_select":
        return toContent(
          await browserSelect({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: optStr(args.selector),
            value: String(args.value ?? ""),
            browserId: optStr(args.browserId),
            projectPath: req.cwd,
          }),
        );
      case "browser_find":
        return toContent(
          await browserFind({
            selector: optStr(args.selector),
            text: optStr(args.text),
            regex: args.regex === true,
            caseSensitive: args.caseSensitive === true,
            contextChars: typeof args.contextChars === "number" ? args.contextChars : undefined,
            maxResults: typeof args.maxResults === "number" ? args.maxResults : undefined,
            attributes: Array.isArray(args.attributes)
              ? (args.attributes as unknown[]).filter((a): a is string => typeof a === "string")
              : undefined,
            cssScope: optStr(args.cssScope),
            browserId: optStr(args.browserId),
            projectPath: req.cwd,
          }),
        );
      case "browser_switch_tab":
        return toContent(await browserSwitchTab({ browserId: String(args.browserId ?? ""), projectPath: req.cwd }));
      case "browser_close_tab":
        return toContent(await browserCloseTab({ browserId: String(args.browserId ?? ""), projectPath: req.cwd }));
      case "browser_upload_file":
        return toContent(
          await browserUploadFile(
            {
              index: typeof args.index === "number" ? args.index : undefined,
              selector: optStr(args.selector),
              paths: args.paths,
              browserId: optStr(args.browserId),
            },
            req.cwd,
          ),
        );
      case "browser_save_pdf":
        return toContent(
          await browserSavePdf(
            {
              fileName: optStr(args.fileName),
              paperFormat: optStr(args.paperFormat),
              landscape: args.landscape === true,
              printBackground: args.printBackground !== false,
              scale: typeof args.scale === "number" ? args.scale : undefined,
              headerFooter: args.headerFooter === true,
              browserId: optStr(args.browserId),
              projectPath: req.cwd,
            },
            {
              toolCallId: typeof p.callId === "string" ? p.callId : randomUUID(),
              sessionId: req.sessionId,
              turnNumber: req.turnNumber,
            },
          ),
        );
      case "browser_downloads":
        return toContent(browserDownloads());
      case "browser_evaluate":
        return toContent(
          await browserEvaluate({ script: String(args.script ?? ""), browserId: optStr(args.browserId), projectPath: req.cwd }),
        );
      case "browser_screenshot": {
        const r = await browserScreenshot(
          { browserId: optStr(args.browserId), fullPage: args.fullPage === true, projectPath: req.cwd },
          {
          toolCallId: typeof p.callId === "string" ? p.callId : randomUUID(),
          sessionId: req.sessionId,
          turnNumber: req.turnNumber,
          onImage: (info) => {
            ctx.emit({
              type: "browser.image",
              sessionId: req.sessionId,
              toolCallId: info.toolCallId,
              data: info.data,
              mimeType: info.mimeType,
            });
          },
        });
        return toContent(r);
      }
      default:
        return fail(`未知工具:${name}`);
    }
  } catch (err) {
    return fail(`工具执行失败:${(err as Error).message}`);
  }
}

/** Shared ToolResult (TextBlock|ImageBlock) → dynamic-tool response. */
function toContent(r: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown }): unknown {
  return {
    success: true,
    contentItems: r.content.map((b) =>
      b.type === "image"
        ? { type: "inputImage", imageUrl: `data:${b.mimeType ?? "image/png"};base64,${b.data ?? ""}` }
        : { type: "inputText", text: b.text ?? "" },
    ),
  };
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function optDevice(v: unknown): "desktop" | "iphone" | "android" | undefined {
  return v === "iphone" || v === "android" || v === "desktop" ? v : undefined;
}

/** Persist a base64 image to a temp file for turn input (codex takes file
 *  paths for local images, not inline base64). */
async function writeTempImage(base64: string, mimeType: string): Promise<string> {
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : mimeType.includes("gif") ? "gif" : "png";
  const file = path.join(tmpdir(), `mcode-codex-${randomUUID()}.${ext}`);
  await fs.writeFile(file, Buffer.from(base64, "base64"));
  return file;
}
