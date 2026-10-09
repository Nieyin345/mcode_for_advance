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

/**
 * **密钥本体的设置键** —— `setting.get` / `setting.getMany` 一律不许把它们读给模型。
 *
 * ## 为什么需要这一条(它在补哪个洞)
 *
 * 密钥存在于设置表里(见 `main/lib/secretStore.ts`)。通向它们的那几条**专门**的路都被
 * 显式钉在 blocked 档 —— `customModel.getToken`、`piModels.getApiKey`、
 * `codexModels.getApiKey`,理由都写着「API Key / 令牌不给模型」。但 `setting.get` 是
 * `read` 档、**自动放行**,而它读的是**任意**键 —— 于是同一份密钥换条路就拿到了:
 * `app_api_call { method: "setting.get", input: { key: "customModelKeys" } }`。
 *
 * ## 为什么打码拦不住
 *
 * `renderResult` 的打码分两道:字段名像不像密钥、值的形态像不像密钥。而
 * `customModelKeys` 的**值**是一张 `id → base64(密文)` 的表 —— 键是随机串,值在
 * `safeStorage` 不可用的机器上也只是普通 base64(base64 字母表里没有 `-`/`_`,
 * 也不匹配 `sk-` 那类前缀),两道都绕过去了。所以这里必须按**键名**拦在调用之前,
 * 而不是指望结果打码。
 *
 * 将来再有"密钥存在设置表里"的键,加进这个集合(或让它匹配下面那条正则)。
 */
const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  "customModelKeys",
  "customModels",
  // ⚠️ **下面这几条是同一种洞的另几个实例(2026-10-09)。** 它们同样把凭据存成**一整块
  //    JSON 字符串**、键名又**不含** `key`/`token`/`secret`/`password` 那几个词 ——
  //   于是 `SECRET_SETTING_KEY_RE` 和 `SECRET_SETTING_STORE_RE` 两道**都绕过去**,
  //   而它们的**值**里嵌着 `password` / `jwtSecret` / `secret` 这些字段。`setting.get`
  //   把整块 JSON 当**一个字符串**返回,`redactString` 只按值的**形态**认密钥
  //   (`sk-…`/`ghp_…`/40+ 位十六进制…),认不出 `"password":"S3cr3t-vps-pw!"` 这种 ——
  //   于是整段凭据原样交给模型。这与 #105/#106 是同一类"密钥换条路就漏",改法也一样:
  //   按键名拦在调用之前。判据来自同仓另两处**已经把这几条当密钥**的地方 ——
  //   `settings/transfer.ts` 的 `EXCLUDED_KEYS`(导出即分享,绝不带密钥)与
  //   `mobile/MobileHttpServer.ts` 的 `LAN_UNREADABLE_SETTING_KEYS`(局域网可读的手机端
  //   都不给)。照抄它们的名单,别让同一个事实在三处各写一遍还写岔。
  /** SSH 主机 + 用户 + **password**(见 `contracts/relay.ts` 的 `RelayVpsConfig`)。 */
  "relay.vpsConfig",
  /** 服务地址 + **JWT 签名密钥**(`jwtSecret`,能签发/伪造 OnlyOffice 令牌)。 */
  "onlyoffice.config",
  /** 每条项目链接的 `/mcp/<secret>` 明文密钥(见 `publicMcpSession.ts`)。 */
  "publicMcp.projectLinks",
  /** 已配对手机的 `{ deviceToken }`(bearer 令牌)。值是 64 位十六进制,现在**恰好**
   *  被"值的形态"那道拦住,但那条判据依赖令牌恰好是十六进制 —— 换一种编码就漏。按
   *  键名钉死(手机侧 `LAN_UNREADABLE_SETTING_KEYS` 也是这么钉的)。 */
  "mobile.pairedDevices",
  /** MCP 服务器的配置(每个 server 的 `env` / `headers`)。stdio server 的 `env` 里常放
   *  **API key**(如 `GITHUB_TOKEN`),http/sse server 的 `headers` 里常放 `Authorization`
   *  —— `contracts/ipc/mcp.ts` 明说 headers 原样保存。键名 `mcp.management` 两道正则
   *  (`SECRET_SETTING_KEY_RE` / `SECRET_SETTING_STORE_RE`)都不命中,而 `setting.get`
   *  是 read/自动批准、把整块 JSON 当一个字符串返回 → 凭据原样交给模型。与 #133 那四条
   *  同一种洞,改法一样:按键名拦在调用之前。 */
  "mcp.management",
]);
/** 兜底:名字里带密钥词的设置键也不给。宁可多拦一个键,也不漏一个。 */
const SECRET_SETTING_KEY_RE =
  /(api[-_.]?keys?|apikeys?|tokens?|secrets?|passw(or)?ds?|credentials?|cookies?|authorization|private[-_.]?keys?|cookieVault)/i;
/** 密钥本体的**结构性**名字(见 `settingsTransfer.ts` 里 `SECRET_STORE_KEY_RE` 那段:
 *  加密凭据 map 全仓都是 `<东西>+Keys/Tokens/Secrets` 收尾)。逐个往集合里加是追着漏,
 *  这里按键名的形状一次挡住 —— `customModelKeys` / `piProviderKeys` / `codexProviderKeys`
 *  都在内。
 *  ⚠️ 末尾的 `/i` **不能省**:`settingsTransfer.ts` 里那条同名规则带 `/i`(导出时按它剔),
 *  这里不带就会**判据漂开** —— 一个 `providerkeys` 这样的全小写键能在导出时被剔掉、
 *  却仍能经 `setting.get` 交给模型。两条判据必须逐字同形。 */
const SECRET_SETTING_STORE_RE = /(Keys|Tokens|Secrets|Credentials|Passwords)$/i;

/** 这个设置键是不是"密钥本体",不能经 `setting.get*` 交给模型。 */
export function isSecretSettingKey(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  return (
    SECRET_SETTING_KEYS.has(key) ||
    SECRET_SETTING_KEY_RE.test(key) ||
    SECRET_SETTING_STORE_RE.test(key)
  );
}

/** `setting.get` / `setting.getMany` 的入参里,有没有踩到密钥键。 */
function secretSettingRefusal(method: string, input: unknown): string | null {
  if (method !== "setting.get" && method !== "setting.getMany") return null;
  const o = (input ?? {}) as { key?: unknown; keys?: unknown };
  const keys: unknown[] = Array.isArray(o.keys) ? [...o.keys] : [o.key];
  const hit = keys.find((k) => isSecretSettingKey(k));
  return hit === undefined
    ? null
    : `设置键「${String(hit)}」是密钥本体,不读给模型(与 customModel.getToken / piModels.getApiKey 同一条规矩)。要改密钥请让用户在 设置 里操作。`;
}

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

/**
 * 直接调 handler(不过审批 —— 调用方先 gate)。
 *
 * ⚠️ **`input === undefined` 要补成 `{}`。** `app_api_call` 的说明明写着「无参方法省略
 * `input`」,于是模型对 `project.list` / `session.listAll` / `runtimes.list` 这类方法会
 * **整个不传** —— 到了这里就是 `undefined`。而无参 handler 有的根本不接 `raw`(如
 * `workflow.list`,没问题),有的却照常 `schema.parse(raw)`;其中**入参全可选的 schema**
 * (`session.listAll` 的 limit/offset/projectIds/worktreeKey)`z.object({}).parse(undefined)`
 * 会报根级 `Required`——这个功能对 agent 就**永远调不通**,而报错里没有一个字提示"它其实
 * 不需要参数"。补一个空对象:全可选/空 schema 照常过,真缺必填参数的方法则拿到更准的
 * `字段 Required`(而不是根级一句 `(根) Required`)。与各 handler 里 `parse(raw ?? {})`
 * 同一条约定(见 `ipc/context.ts` / `ipc/mcp.ts`),只是收在这一层做,新加的无参方法
 * 不必各自记得补。
 */
export async function callRpc(entry: { channel: string }, input: unknown): Promise<unknown> {
  const handler = rpcHandlerFor(entry.channel);
  if (!handler) throw new Error(`这个功能在当前版本里没有注册(${entry.channel})`);
  return handler({}, input ?? {});
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
        // 密钥设置键:在**调用之前**拦(见 isSecretSettingKey —— 结果打码拦不住它)。
        const secretRefusal = secretSettingRefusal(entry.method, args.input);
        if (secretRefusal) return fail(secretRefusal);
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
