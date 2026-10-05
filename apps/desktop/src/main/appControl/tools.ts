/**
 * **mcode-app 工具表** —— 本地 agent 完全控制 Mcode 的那组工具(Claude / Codex / Pi 共用)。
 *
 * ## 组成
 *
 *   - 通用通道(覆盖**全部**功能):`app_api_list` → `app_api_describe` → `app_api_call`。
 *     背后是 `ipc/index.ts` 登记的同一批 RPC handler —— 与界面按按钮走同一段代码。
 *   - 常用功能单独做成好用的工具:`app_ui_state` / `app_ui`(切对话、开文件/设置/面板、弹提示、
 *     改界面偏好)、`app_session_new` / `app_session_send`(像用户一样开对话、发消息)、
 *     `app_workflow_run`(立即运行自动化,或在对话里跑某个工作流)。
 *
 * ## 审批(见 `policy.ts`)
 *
 * 审批在**这里**做(与记忆工具同一个形状:各引擎的 canUseTool / 守卫对 `app_*` 直接放行,
 * 由 handler 自己 fail-closed 地问)。原因:同一个 `app_api_call` 里,读设置和删项目是两回事,
 * 只能看参数才分得清,引擎那一层按工具名放行做不到。
 *   - 「始终允许」按**具体方法**记(审批卡的 toolName 是 `mcode-app:<方法>`);
 *   - 高风险的卡 toolName 带 `APP_DANGER_APPROVAL_PREFIX`,不给「始终允许」、也不认。
 *
 * ## 不在这里的
 *
 * 只给本地三个引擎;浏览器扩展 / 公网 MCP 那条路(`webToolHost`)**不挂** —— 公网那条是
 * 免审批的,挂上去等于把整个软件交给拿到链接的人(用户 2026-10-02 明确选的)。
 */
import { CUSTOM_UI_SETTING_KEY, CustomUiConfigSchema } from "@contracts/customUi";
import { zodToJsonSchema } from "zod-to-json-schema";
import { notifyAppSettingWrite } from "@main/customUi/settingSync.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderContext } from "@contracts/provider";
import { APP_DANGER_APPROVAL_PREFIX, type AppUiCommand, type AppUiReply } from "@contracts/appControl";
import { fail, text, type McpToolSpec, type ToolResult } from "@main/mcp/sdk.js";
import { API_CATALOG, type ApiCatalogEntry } from "./apiCatalog.generated.js";
import { DOMAIN_LABELS, policyFor, type AppPolicy, type AppPolicyLevel } from "./policy.js";
import { registeredRpcChannels, rpcHandlerFor } from "./registry.js";
import { redactValue, renderResult } from "./redact.js";
import { runUiCommand } from "./uiBridge.js";

export const APP_APPROVAL_PREFIX = "mcode-app:";

const LEVEL_LABEL: Record<AppPolicyLevel, string> = {
  read: "只读·自动",
  ui: "界面·自动",
  write: "需批准",
  danger: "高风险·每次批准",
  blocked: "不开放",
};

/* ───────────────────────── 目录 ───────────────────────── */

interface ApiEntry extends ApiCatalogEntry {
  policy: AppPolicy;
  registered: boolean;
}

function domainOf(method: string): string {
  const i = method.indexOf(".");
  return i < 0 ? method : method.slice(0, i);
}

/** 生成清单 ∪ 实际注册了 handler 的通道(清单没跟上的新通道也能调,只是没有说明)。 */
export function apiEntries(): ApiEntry[] {
  const registered = new Set(registeredRpcChannels());
  const known = new Set<string>();
  const out: ApiEntry[] = API_CATALOG.map((e) => {
    known.add(e.channel);
    const settingDoc = e.method === "setting.get" || e.method === "setting.set"
      ? ` 自定义 UI / custom UI: ${CUSTOM_UI_SETTING_KEY} 是旧版全局 UI JSON 配置。先 setting.get 读取并保留其他项; app_api_describe({method:"setting.set", setting_key:"${CUSTOM_UI_SETTING_KEY}"}) 获取 JSON schema。写入必须审批,不可直接修改运行中的 mcode.db。` : "";
    return { ...e, doc: e.doc + settingDoc, policy: policyFor(e.method), registered: registered.has(e.channel) };
  });
  for (const ch of registered) {
    if (known.has(ch)) continue;
    // 通道名形如 `domain:verb` —— 方法名就按 `domain.verb` 起。
    const method = ch.replace(/:/g, ".");
    out.push({ method, channel: ch, doc: "", input: "(清单里没有说明,按报错提示传参)", output: "unknown", policy: policyFor(method), registered: true });
  }
  return out;
}

function findEntry(method: string): ApiEntry | undefined {
  const m = method.trim();
  return apiEntries().find((e) => e.method === m || e.channel === m);
}

function clipLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/* ───────────────────────── 审批 ───────────────────────── */

const BYPASS_MODES = new Set(["bypassPermissions", "full-access"]);
const READONLY_MODES = new Set(["plan", "read-only"]);

/**
 * 按档位决定放不放行。返回 `null` = 放行;字符串 = 拒绝原因(原样给模型)。
 * 没有审批通道(无界面的环境)一律拒绝 —— fail-closed。
 */
export async function gateAppAction(
  ctx: ProviderContext,
  level: AppPolicyLevel,
  approvalKey: string,
  input: unknown,
  description: string,
  blockedReason?: string,
): Promise<string | null> {
  if (level === "read" || level === "ui") return null;
  if (level === "blocked") return `这个功能不开放给 agent:${blockedReason ?? "安全原因"}`;
  const mode = ctx.getPermissionMode?.() ?? undefined;
  if (mode && READONLY_MODES.has(mode)) {
    return "当前是只读/计划模式,不执行有副作用的操作。先把方案告诉用户,等他切换模式。";
  }
  const toolName = level === "danger" ? `${APP_DANGER_APPROVAL_PREFIX}${approvalKey}` : `${APP_APPROVAL_PREFIX}${approvalKey}`;
  if (level === "write") {
    if (mode && BYPASS_MODES.has(mode)) return null;
    if (ctx.isToolAlwaysAllowed?.(toolName)) return null;
  }
  if (mode === "dontAsk") return "当前权限模式不弹审批,这个操作没有被预先允许,未执行。";
  if (!ctx.requestApproval) return "当前环境没有可用的审批通道,为安全起见未执行。";
  const decision = await ctx.requestApproval({
    requestId: randomUUID(),
    toolName,
    input: redactValue(input),
    description: level === "danger" ? `⚠️ 高风险操作(每次都需要你本人批准):${description}` : description,
  });
  if (!decision.allow) return decision.reason ? `用户拒绝了:${decision.reason}` : "用户拒绝了这次操作,未执行。";
  return null;
}

/* ───────────────────────── 调用 RPC ───────────────────────── */

/** 直接调 handler(不过审批 —— 调用方先 gate)。 */
export async function callRpc(entry: { channel: string }, input: unknown): Promise<unknown> {
  const handler = rpcHandlerFor(entry.channel);
  if (!handler) throw new Error(`这个功能在当前版本里没有注册(${entry.channel})`);
  return handler({}, input);
}

function errText(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `参数不对:${err.issues.map((i) => `${i.path.join(".") || "(根)"} ${i.message}`).join(";")}。先用 app_api_describe 看参数格式。`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function ui(cmd: AppUiCommand): Promise<AppUiReply> {
  try {
    return await runUiCommand(cmd);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

function uiResult(reply: AppUiReply, okText: string): ToolResult {
  if (!reply.ok) return fail(reply.error ?? "界面操作失败");
  return text(reply.data === undefined ? okText : `${okText}\n${renderResult(reply.data)}`);
}

/* ───────────────────────── 工具表 ───────────────────────── */

const UI_ACTIONS = [
  "open_session",
  "select_project",
  "open_file",
  "open_settings",
  "close_settings",
  "panel",
  "open_url",
  "notify",
  "set_pref",
  "interrupt_session",
] as const;

/** 只读 / 界面类工具名(引擎侧若要按名字预放行可以用;真正的闸门在 handler 里)。 */
export const APP_READONLY_TOOLS: ReadonlySet<string> = new Set(["app_api_list", "app_api_describe", "app_ui_state"]);

export function appMcpTools(): McpToolSpec[] {
  return [
    {
      name: "app_api_list",
      description:
        "列出 Mcode 的全部功能(主进程接口)。不带参数 = 按功能域列目录;带 domain = 列该域全部方法;" +
        "带 query = 按关键词搜方法名和说明。每个方法标了权限档:只读·自动 / 需批准 / 高风险·每次批准 / 不开放。" +
        "想做界面上能做的任何事(建项目、改设置、管理技能/插件/MCP、Git、终端、资料库、工作流……)先用它找到方法。",
      inputSchema: {
        domain: z.string().optional().describe("功能域,如 project / session / library / git / skills / mcp / setting"),
        query: z.string().optional().describe("关键词(方法名或说明里的字)"),
      },
      handler: async (args: { domain?: string; query?: string }) => {
        const all = apiEntries();
        if (!args.domain && !args.query) {
          const counts = new Map<string, number>();
          for (const e of all) counts.set(domainOf(e.method), (counts.get(domainOf(e.method)) ?? 0) + 1);
          const lines = [...counts.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([d, n]) => `- ${d}(${n}):${DOMAIN_LABELS[d] ?? ""}`);
          return text(
            `Mcode 共 ${all.length} 个功能,按域:\n${lines.join("\n")}\n\n` +
              "下一步:app_api_list({domain}) 看某个域的方法 → app_api_describe({method}) 看参数 → app_api_call 调用。\n" +
              "切对话/开文件/开面板/像用户一样发消息用 app_ui / app_session_new / app_session_send,运行工作流用 app_workflow_run。",
          );
        }
        const q = args.query?.trim().toLowerCase();
        const picked = all.filter(
          (e) =>
            (!args.domain || domainOf(e.method) === args.domain.trim()) &&
            (!q || e.method.toLowerCase().includes(q) || e.doc.toLowerCase().includes(q)),
        );
        if (picked.length === 0) return text("没有匹配的方法。不带参数调用一次看全部功能域。");
        const lines = picked.map(
          (e) => `- ${e.method} [${LEVEL_LABEL[e.policy.level]}]${e.registered ? "" : "(未注册)"}${e.doc ? ` — ${clipLine(e.doc, 120)}` : ""}`,
        );
        return text(`${picked.length} 个方法:\n${lines.join("\n")}`);
      },
    },
    {
      name: "app_api_describe",
      description: "看某个 Mcode 方法的完整说明、参数格式、返回格式和权限档。调用 app_api_call 之前先看一眼。",
      inputSchema: {
        method: z.string().describe("方法名,如 session.rename(来自 app_api_list)"),
        setting_key: z.string().optional().describe("查看已知 JSON 设置的结构,例如 customUi.config.v1"),
      },
      handler: async (args: { method: string; setting_key?: string }) => {
        const e = findEntry(args.method);
        if (!e) return fail(`没有这个方法:${args.method}。用 app_api_list 查。`);
        return text(
          [
            `方法:${e.method}`,
            `权限:${LEVEL_LABEL[e.policy.level]}${e.policy.reason ? `(${e.policy.reason})` : ""}`,
            e.registered ? null : "⚠️ 当前版本没有注册这个方法的处理函数",
            e.doc ? `说明:${e.doc}` : null,
            `参数:${e.input}`,
            `返回:${e.output}`,
            args.setting_key === CUSTOM_UI_SETTING_KEY && ["setting.get", "setting.set"].includes(e.method)
              ? `value 是 JSON 字符串;其解码后的结构为:\n${JSON.stringify(zodToJsonSchema(CustomUiConfigSchema, { target: "jsonSchema7", $refStrategy: "none" }))}\n条目 id 必须唯一,动作必须适用于相应插槽。保留未修改的条目与布局;先读再写。` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    },
    {
      name: "app_api_call",
      description:
        "调用一个 Mcode 方法(与界面上点按钮执行的是同一段代码)。只读的直接执行;有副作用的会弹审批卡;" +
        "高风险的每次都要用户本人批准;不开放的会直接拒绝。返回值里的密钥/令牌一律打码。",
      inputSchema: {
        method: z.string().describe("方法名(来自 app_api_list)"),
        input: z.unknown().optional().describe("参数对象,格式见 app_api_describe;无参方法省略"),
      },
      handler: async () => fail("内部错误:app_api_call 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_ui_state",
      description:
        "读 Mcode 界面当前状态:当前项目/对话、打开的标签页、哪些对话在运行、各面板开关、设置页、" +
        "输入框的权限模式和工作流、语言主题等。做界面操作前先看一眼。",
      inputSchema: {},
      handler: async () => uiResult(await ui({ op: "state" }), "界面状态:"),
    },
    {
      name: "app_ui",
      description:
        "操作 Mcode 界面。action:\n" +
        "- open_session {session_id}:切到某个对话\n" +
        "- select_project {project_id}:切到某个项目\n" +
        "- open_file {path, line?}:在编辑器里打开文件(当前项目内)\n" +
        "- open_settings {section?} / close_settings:打开/关闭设置页\n" +
        "- panel {panel: left|right|terminal|browser, open, tab?}:开关面板;右栏 tab 可选 files|git|browser|turns|preview|flow|tasks\n" +
        "- open_url {url}:在内置浏览器里打开网址\n" +
        "- notify {title, body?, kind?}:在界面右下角弹一条提示\n" +
        "- set_pref {key, value}:改界面偏好 —— locale(zh/en)、themeStyle(classic/sketch)、displayMode、chatFontSize、" +
        "chatDensity、workflowId(输入框的工作流)、permissionMode(输入框的权限模式,高风险)\n" +
        "- interrupt_session {session_id}:停止某个正在运行的对话(需批准)\n" +
        "界面类操作自动执行;set_pref 需批准,改 permissionMode 每次都要批准。",
      inputSchema: {
        action: z.enum(UI_ACTIONS),
        session_id: z.string().optional(),
        project_id: z.string().optional(),
        path: z.string().optional(),
        line: z.number().int().positive().optional(),
        section: z.string().optional(),
        panel: z.enum(["left", "right", "terminal", "browser"]).optional(),
        open: z.boolean().optional(),
        tab: z.enum(["files", "git", "browser", "turns", "preview", "flow", "tasks"]).optional(),
        url: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        kind: z.enum(["info", "warning", "error"]).optional(),
        key: z.enum(["locale", "themeStyle", "displayMode", "chatFontSize", "chatDensity", "workflowId", "permissionMode"]).optional(),
        value: z.union([z.string(), z.number()]).optional(),
      },
      handler: async () => fail("内部错误:app_ui 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_session_new",
      description:
        "像用户点「新对话」一样开一个对话,可选直接发出第一条消息。不传 project_id 用当前项目;" +
        "provider_id / model 不传就用输入框当前的选择;workflow_id 让这条消息按某个工作流跑。" +
        "background=true 时建完切回原来的对话,不把用户的视线带走。需批准。",
      inputSchema: {
        project_id: z.string().optional(),
        prompt: z.string().optional().describe("第一条消息;省略则只建对话"),
        provider_id: z.string().optional().describe("引擎:claude-sdk / codex-sdk / pi-sdk 等(provider.list 可查)"),
        model: z.string().optional(),
        workflow_id: z.string().optional(),
        background: z.boolean().optional(),
      },
      handler: async () => fail("内部错误:app_session_new 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_session_send",
      description:
        "像用户在输入框里打字一样,给某个对话发一条消息(对方正在运行时会插进那一轮)。" +
        "消息会出现在那个对话里,由那个对话的 agent 来回答。不能发给你自己所在的对话。需批准。",
      inputSchema: {
        session_id: z.string(),
        prompt: z.string(),
        workflow_id: z.string().optional().describe("让这条消息按某个工作流跑"),
        background: z.boolean().optional().describe("true = 发完切回原来的对话"),
      },
      handler: async () => fail("内部错误:app_session_send 必须经 invokeAppTool 调用"),
    },
    {
      name: "app_workflow_run",
      description:
        "运行一个工作流。带触发器的自动化:立即跑一次(trigger_node_id 不传且只有一个触发器时自动选)。" +
        "普通工作流(没有触发器):在对话里按它跑 —— 需要 prompt;给 session_id 发到那个对话,不给就新开一个。需批准。",
      inputSchema: {
        workflow_id: z.string(),
        trigger_node_id: z.string().optional(),
        prompt: z.string().optional(),
        session_id: z.string().optional(),
        project_id: z.string().optional(),
      },
      handler: async () => fail("内部错误:app_workflow_run 必须经 invokeAppTool 调用"),
    },
  ];
}

/* ───────────────────────── 调度 ───────────────────────── */

type UiArgs = {
  action: (typeof UI_ACTIONS)[number];
  session_id?: string;
  project_id?: string;
  path?: string;
  line?: number;
  section?: string;
  panel?: "left" | "right" | "terminal" | "browser";
  open?: boolean;
  tab?: "files" | "git" | "browser" | "turns" | "preview" | "flow" | "tasks";
  url?: string;
  title?: string;
  body?: string;
  kind?: "info" | "warning" | "error";
  key?: "locale" | "themeStyle" | "displayMode" | "chatFontSize" | "chatDensity" | "workflowId" | "permissionMode";
  value?: string | number;
};

function need<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === null || v === "") throw new Error(`缺少参数 ${name}`);
  return v;
}

async function runUiAction(a: UiArgs, ctx: ProviderContext): Promise<ToolResult> {
  switch (a.action) {
    case "open_session":
      return uiResult(await ui({ op: "open_session", sessionId: need(a.session_id, "session_id") }), "已切到该对话。");
    case "select_project":
      return uiResult(await ui({ op: "select_project", projectId: need(a.project_id, "project_id") }), "已切到该项目。");
    case "open_file":
      return uiResult(await ui({ op: "open_file", path: need(a.path, "path"), line: a.line }), "已在编辑器里打开。");
    case "open_settings":
      return uiResult(await ui({ op: "open_settings", section: a.section }), "已打开设置页。");
    case "close_settings":
      return uiResult(await ui({ op: "close_settings" }), "已关闭设置页。");
    case "panel":
      return uiResult(await ui({ op: "panel", panel: need(a.panel, "panel"), open: a.open ?? true, tab: a.tab }), "面板已更新。");
    case "open_url": {
      const url = need(a.url, "url");
      if (!/^https?:\/\//i.test(url)) return fail("只支持 http(s) 网址");
      return uiResult(await ui({ op: "open_url", url }), "已在内置浏览器里打开。");
    }
    case "notify":
      return uiResult(await ui({ op: "notify", title: need(a.title, "title"), body: a.body, kind: a.kind }), "已弹出提示。");
    case "set_pref": {
      const key = need(a.key, "key");
      const value = need(a.value, "value");
      const level: AppPolicyLevel = key === "permissionMode" ? "danger" : "write";
      const denied = await gateAppAction(ctx, level, `ui.set_pref.${key}`, { key, value }, `把界面偏好 ${key} 改成 ${String(value)}`);
      if (denied) return fail(denied);
      return uiResult(await ui({ op: "set_pref", key, value }), `已把 ${key} 改成 ${String(value)}。`);
    }
    case "interrupt_session": {
      const sessionId = need(a.session_id, "session_id");
      const denied = await gateAppAction(ctx, "write", "ui.interrupt_session", { sessionId }, `停止对话 ${sessionId} 正在运行的那一轮`);
      if (denied) return fail(denied);
      return uiResult(await ui({ op: "interrupt", sessionId }), "已停止。");
    }
  }
}

async function runWorkflow(
  args: { workflow_id: string; trigger_node_id?: string; prompt?: string; session_id?: string; project_id?: string },
  sessionId: string,
  ctx: ProviderContext,
): Promise<ToolResult> {
  const statusEntry = findEntry("automation.statusAll");
  let triggers: Array<{ nodeId: string; title: string; workflowId: string }> = [];
  if (statusEntry?.registered) {
    const all = (await callRpc(statusEntry, undefined)) as Array<{ nodeId: string; title: string; workflowId: string }>;
    triggers = Array.isArray(all) ? all.filter((t) => t.workflowId === args.workflow_id) : [];
  }
  if (triggers.length > 0) {
    let nodeId = args.trigger_node_id;
    if (!nodeId) {
      if (triggers.length > 1) {
        return fail(`这条自动化有 ${triggers.length} 个触发器,请用 trigger_node_id 指定:\n${triggers.map((t) => `- ${t.nodeId}(${t.title})`).join("\n")}`);
      }
      nodeId = triggers[0]!.nodeId;
    }
    const denied = await gateAppAction(ctx, "write", "workflow_run", args, `立即运行自动化 ${args.workflow_id}(触发器 ${nodeId})`);
    if (denied) return fail(denied);
    const runEntry = findEntry("automation.run");
    if (!runEntry) return fail("当前版本没有 automation.run");
    const r = (await callRpc(runEntry, { workflowId: args.workflow_id, triggerNodeId: nodeId })) as { ok: boolean; error?: string };
    return r.ok ? text(`已开始运行自动化 ${args.workflow_id}。运行记录用 app_api_call automation.runs 查。`) : fail(r.error ?? "启动失败");
  }
  // 普通工作流:在对话里按它跑。
  const prompt = args.prompt?.trim();
  if (!prompt) return fail("这个工作流没有触发器,要在对话里跑:请给 prompt(以及可选的 session_id / project_id)。");
  if (args.session_id === sessionId) return fail("不能让你自己所在的对话去跑,换一个对话或不传 session_id 新开一个。");
  const denied = await gateAppAction(
    ctx,
    "write",
    "workflow_run",
    args,
    args.session_id ? `在对话 ${args.session_id} 里按工作流 ${args.workflow_id} 发送:${clipLine(prompt, 200)}` : `新开对话,按工作流 ${args.workflow_id} 发送:${clipLine(prompt, 200)}`,
  );
  if (denied) return fail(denied);
  const reply = args.session_id
    ? await ui({ op: "send", sessionId: args.session_id, prompt, workflowId: args.workflow_id, background: true })
    : await ui({ op: "new_session", projectId: args.project_id, prompt, workflowId: args.workflow_id, background: true });
  return uiResult(reply, "已按工作流发出。");
}

/**
 * 唯一入口。引擎侧(Claude 进程内 MCP / Codex 动态工具 / Pi 扩展)都调它。
 */
export async function invokeAppTool(name: string, rawArgs: unknown, sessionId: string, ctx: ProviderContext): Promise<ToolResult> {
  const spec = appMcpTools().find((t) => t.name === name);
  if (!spec) return fail(`未知的 Mcode 控制工具:${name}`);
  try {
    const args = z.object(spec.inputSchema).parse(rawArgs ?? {}) as Record<string, unknown>;
    switch (name) {
      case "app_api_call": {
        const method = String(args.method ?? "");
        const entry = findEntry(method);
        if (!entry) return fail(`没有这个方法:${method}。用 app_api_list 查。`);
        const denied = await gateAppAction(
          ctx,
          entry.policy.level,
          entry.method,
          args.input,
          `${entry.method}${entry.policy.reason ? `:${entry.policy.reason}` : entry.doc ? `:${clipLine(entry.doc, 160)}` : ""}`,
          entry.policy.reason,
        );
        if (denied) return fail(denied);
        try {
          const result = await callRpc(entry, args.input);
          try {
            notifyAppSettingWrite(entry.method, args.input);
          } catch (error) {
            return fail(`操作已完成,但桌面刷新通知失败:${errText(error)}`);
          }
          return text(renderResult(result));
        } catch (err) {
          return fail(errText(err));
        }
      }
      case "app_ui":
        return await runUiAction(args as UiArgs, ctx);
      case "app_session_new": {
        const a = args as { project_id?: string; prompt?: string; provider_id?: string; model?: string; workflow_id?: string; background?: boolean };
        const what = a.prompt ? `新开对话并发送:${clipLine(a.prompt, 200)}` : "新开一个对话";
        const denied = await gateAppAction(ctx, "write", "session_new", a, what);
        if (denied) return fail(denied);
        return uiResult(
          await ui({ op: "new_session", projectId: a.project_id, providerId: a.provider_id, model: a.model, prompt: a.prompt, workflowId: a.workflow_id, background: a.background }),
          "已新建对话。",
        );
      }
      case "app_session_send": {
        const a = args as { session_id: string; prompt: string; workflow_id?: string; background?: boolean };
        if (a.session_id === sessionId) return fail("不能给你自己所在的对话发消息。");
        const denied = await gateAppAction(ctx, "write", "session_send", a, `给对话 ${a.session_id} 发送:${clipLine(a.prompt, 200)}`);
        if (denied) return fail(denied);
        return uiResult(await ui({ op: "send", sessionId: a.session_id, prompt: a.prompt, workflowId: a.workflow_id, background: a.background }), "已发送。");
      }
      case "app_workflow_run":
        return await runWorkflow(args as { workflow_id: string }, sessionId, ctx);
      default:
        return await spec.handler(args, { sessionId });
    }
  } catch (err) {
    return fail(errText(err));
  }
}
