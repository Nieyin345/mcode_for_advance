/**
 * Headless smoke for **mcode-app**(本地 agent 完全控制 Mcode 的那组工具)。
 *
 * 覆盖:
 *   1. 权限表:清单里每个方法都能归档;关键几条钉死(自己批自己 = 不开放、装插件 = 高风险……)。
 *   2. 打码:按字段名、按值的样子、二进制、截断。
 *   3. 审批闸门:读自动、写要批、拒绝不执行、「始终允许」按方法生效、完全访问只放写不放高风险、
 *      计划模式全拒、不开放的直接拒、没有审批通道 fail-closed、参数错误说人话。
 *   4. ApprovalBridge:高风险卡就算传了 always 也不记。
 *   5. 界面通道:executeJavaScript 一来一回;不能给自己发消息;发消息先过审批。
 *   6. 接线:三个引擎都挂上、ipc/index.ts 登记了 handler、审批卡认前缀(源码断言)。
 *
 * Run: scripts/app-control-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderContext, ApprovalRequest, ProviderApprovalDecision } from "@contracts/provider";
import { APP_DANGER_APPROVAL_PREFIX, APP_CONTROL_RENDERER_GLOBAL } from "@contracts/appControl";
import { API_CATALOG } from "@main/appControl/apiCatalog.generated.js";
import { policyFor } from "@main/appControl/policy.js";
import { redactValue, renderResult, REDACTED } from "@main/appControl/redact.js";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import { invokeAppTool, appMcpTools } from "@main/appControl/tools.js";
import { appToolDescriptors, isAppToolName } from "@main/appControl/engineTools.js";
import { setRendererPortForTest } from "@main/appControl/uiBridge.js";
import { ApprovalBridge } from "@main/claude/ApprovalBridge.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failures.push(`${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");

/* ── 1. 权限表 ── */
check("清单不为空", API_CATALOG.length > 300, API_CATALOG.length);
check("清单每条都有 domain:verb 通道", API_CATALOG.every((e) => /^[A-Za-z]+[:.]/.test(e.channel)), API_CATALOG.find((e) => !/^[A-Za-z]+[:.]/.test(e.channel)));
check("清单里没有构建机绝对路径", !API_CATALOG.some((e) => /[A-Z]:\/|\/home\//.test(e.input + e.output)));
const levels = new Map<string, number>();
for (const e of API_CATALOG) levels.set(policyFor(e.method).level, (levels.get(policyFor(e.method).level) ?? 0) + 1);
check("五档都有人", ["read", "write", "danger", "blocked", "ui"].every((l) => (levels.get(l) ?? 0) > 0), [...levels]);
const pin: Array<[string, string]> = [
  ["claude.approve", "blocked"],
  ["claude.respondQuestion", "blocked"],
  ["workflow.approve", "blocked"],
  ["customModel.getToken", "blocked"],
  ["session.saveMessages", "blocked"],
  ["plugins.installGit", "danger"],
  ["mcp.save", "danger"],
  ["hooks.save", "danger"],
  ["project.delete", "danger"],
  ["setting.set", "danger"],
  ["publicMcp.setEnabled", "danger"],
  ["publicMcp.addProjectLink", "danger"],
  ["app.moveDataRoot", "danger"],
  ["session.rename", "write"],
  ["project.create", "write"],
  ["library.createCollection", "write"],
  ["project.list", "read"],
  ["session.messages", "read"],
  ["git.status", "read"],
  ["setting.get", "read"],
  ["notification.focusSession", "ui"],
  ["totally.newThing", "write"],
  // ★ **动词前缀的陷阱(C4/权限,2026-10-08)**:`READ_VERB` 是**前缀**匹配
  // (`^history`、`^check`、`^task` 都算"只读"),而 `browser.historyClear` 只是**以
  // `history` 开头**——它其实清空浏览历史。`git.checkout` 同理:以 `check` 开头,实际会
  // **切换分支、改工作区文件**。这类"名字像只读、实际会写"的必须钉在显式表里,否则
  // agent 能不经审批跑它们。
  ["browser.historyClear", "write"],
  ["browser.historyRemove", "write"],
  ["git.checkout", "write"],
];
for (const [m, l] of pin) check(`权限 ${m} = ${l}`, policyFor(m).level === l, policyFor(m));
// 凡是名字里带 getToken / getApiKey 的都不能是可读档
for (const e of API_CATALOG) {
  if (/getToken|getApiKey/i.test(e.method)) check(`${e.method} 不开放`, policyFor(e.method).level === "blocked");
}
// ★ **系统性兜底:不许"名字像只读、后缀却是破坏性动作"的方法自动放行。**
// `READ_VERB` 是前缀匹配,`browser.historyClear`(`history` 开头)与 `git.checkout`
// (`check` 开头)会误落只读档 —— 这两个是已发现的实例,但**将来新增的同类**也要被拦。
// 判据:方法名的动作部分以只读词开头、**紧接着的剩余部分恰好是一个破坏性动词**
// (clear/remove/delete/reset/drop/kill/truncate/wipe/checkout) → 不得是 read/ui。
// 用"恰好等于"而不是"包含",是为了不误伤 `showCommit`(rest=`Commit`,只读)、
// `checkForUpdates`(rest=`ForUpdates`,只读)这类"只读词 + 宾语名词"。
{
  const DESTRUCTIVE = new Set(["clear", "remove", "delete", "reset", "drop", "kill", "truncate", "wipe", "checkout"]);
  const READ_PREFIX = /^(list|get|read|status|search|info|stats|overview|catalog|history|runs|sessions|tasks|task|has|show|preview|check|describe|count)/;
  const misread = API_CATALOG.filter((e) => {
    const verb = e.method.slice(e.method.lastIndexOf(".") + 1);
    const rest = verb.replace(READ_PREFIX, "");
    if (verb === rest) return false; // 压根不是只读词开头
    // 破坏性动作可能整段就是(`git.checkout` → 前缀吃掉 `check` 剩 `out`,所以要看整词),
    // 也可能是剩余部分(`historyClear` → `Clear`)。两者任一命中即算。
    const isDestructive = DESTRUCTIVE.has(verb.toLowerCase()) || DESTRUCTIVE.has(rest.toLowerCase());
    if (!isDestructive) return false;
    const lvl = policyFor(e.method).level;
    return lvl === "read" || lvl === "ui";
  });
  check(
    "★ 没有「名字像只读、实际会写」的方法被放行",
    misread.length === 0,
    misread.map((e) => `${e.method}=${policyFor(e.method).level}`),
  );
}

/* ── 2. 打码 ── */
const red = redactValue({
  apiKey: "abc",
  nested: { authToken: "zzz", ok: "fine", list: [{ password: "p" }] },
  url: "https://x.trycloudflare.com/mcp/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  note: "key sk-ant-1234567890abcdefXYZ here",
  bin: new Uint8Array(10),
  enabled: true,
  tokenCount: 0,
  usage: { inputTokens: 1200 },
  credentials: { user: "me", nested: { v: "pw" }, n: 3 },
}) as Record<string, unknown>;
check("字段名打码", red.apiKey === REDACTED && (red.nested as Record<string, unknown>).authToken === REDACTED, red);
check("数组里也打码", JSON.stringify(red).includes(`"password":"${REDACTED}"`), red);
check("普通字段不动", (red.nested as Record<string, unknown>).ok === "fine");
check("公网 MCP 路径密钥打码", !String(red.url).includes("AbCdEf"), red.url);
check("sk- 形态打码", !String(red.note).includes("sk-ant-1234"), red.note);
check("二进制只报长度", red.bin === "[二进制 10 字节]", red.bin);
check("布尔/数字不被当密钥", red.enabled === true && red.tokenCount === 0 && (red.usage as { inputTokens: number }).inputTokens === 1200, red);
check("凭据字段之下的字符串全隐藏", JSON.stringify(red.credentials) === JSON.stringify({ user: REDACTED, nested: { v: REDACTED }, n: 3 }), red.credentials);
check("超长截断并说明", renderResult("x".repeat(50), 10).includes("已截断"));

/* ── 3. 审批闸门 ── */
const calls: Record<string, unknown[]> = {};
function fake(channel: string, ret: unknown = { ok: true }): void {
  calls[channel] = [];
  recordRpcHandler(channel, async (_e, raw) => {
    calls[channel]!.push(raw);
    return typeof ret === "function" ? (ret as (r: unknown) => unknown)(raw) : ret;
  });
}
clearRpcHandlers();
fake("project:list", { projects: [{ id: "p1", name: "demo", path: "/x" }] });
fake("session:rename", { session: { id: "s9", title: "new" } });
fake("plugins:installGit", { ok: true });
fake("claude:approve");
fake("setting:get", { value: "secret-ish", apiKey: "k" });
const zodHandler = async (_e: unknown, raw: unknown) => {
  const { z } = await import("zod");
  return z.object({ id: z.string() }).parse(raw);
};
recordRpcHandler("session:archive", zodHandler);

interface Asked { req: ApprovalRequest }
function ctxWith(opts: { mode?: string; allow?: boolean; always?: Set<string>; noApproval?: boolean } = {}): { ctx: ProviderContext; asked: Asked[] } {
  const asked: Asked[] = [];
  const ctx = {
    getPermissionMode: () => opts.mode,
    isToolAlwaysAllowed: (name: string) => opts.always?.has(name) ?? false,
    ...(opts.noApproval
      ? {}
      : {
          requestApproval: async (req: ApprovalRequest): Promise<ProviderApprovalDecision> => {
            asked.push({ req });
            return { allow: opts.allow ?? true };
          },
        }),
  } as unknown as ProviderContext;
  return { ctx, asked };
}
const call = (method: string, input: unknown, ctx: ProviderContext) => invokeAppTool("app_api_call", { method, input }, "me", ctx);

{
  const { ctx, asked } = ctxWith();
  const r = await call("project.list", undefined, ctx);
  check("只读:不问、直接返回", !r.isError && asked.length === 0 && textOf(r).includes("demo"), textOf(r));
}
{
  const { ctx, asked } = ctxWith({ allow: false });
  const r = await call("session.rename", { id: "s9", title: "new" }, ctx);
  check("写:被拒 → 不执行", r.isError === true && calls["session:rename"]!.length === 0, textOf(r));
  check("写:审批卡 toolName 按方法", asked[0]?.req.toolName === "mcode-app:session.rename", asked[0]?.req.toolName);
}
{
  const { ctx, asked } = ctxWith({ allow: true });
  const r = await call("session.rename", { id: "s9", title: "new" }, ctx);
  check("写:批准 → 执行且传参原样", !r.isError && asked.length === 1 && (calls["session:rename"]!.at(-1) as { title: string }).title === "new", textOf(r));
}
{
  const { ctx, asked } = ctxWith({ always: new Set(["mcode-app:session.rename"]) });
  await call("session.rename", { id: "s9", title: "a" }, ctx);
  check("始终允许按方法生效", asked.length === 0);
}
{
  const { ctx, asked } = ctxWith({ mode: "bypassPermissions" });
  await call("session.rename", { id: "s9", title: "b" }, ctx);
  check("完全访问:写不问", asked.length === 0);
  const before = calls["plugins:installGit"]!.length;
  await call("plugins.installGit", { url: "https://x/y.git" }, ctx);
  check("完全访问:高风险照问", asked.length === 1 && asked[0]!.req.toolName === `${APP_DANGER_APPROVAL_PREFIX}plugins.installGit`, asked.map((a) => a.req.toolName));
  check("高风险批准后才执行", calls["plugins:installGit"]!.length === before + 1);
}
{
  const { ctx, asked } = ctxWith({ always: new Set([`${APP_DANGER_APPROVAL_PREFIX}plugins.installGit`, "mcode-app:plugins.installGit"]) });
  await call("plugins.installGit", { url: "u" }, ctx);
  check("高风险:始终允许不认", asked.length === 1);
}
{
  const { ctx, asked } = ctxWith({ mode: "plan" });
  const before = calls["session:rename"]!.length;
  const r = await call("session.rename", { id: "s9", title: "c" }, ctx);
  check("计划模式:写被拒、不问、不执行", r.isError === true && asked.length === 0 && calls["session:rename"]!.length === before, textOf(r));
}
{
  const { ctx, asked } = ctxWith({ mode: "bypassPermissions" });
  const r = await call("claude.approve", { requestId: "x", allow: true }, ctx);
  check("不开放:直接拒、不问、不执行", r.isError === true && asked.length === 0 && calls["claude:approve"]!.length === 0, textOf(r));
}
{
  const { ctx } = ctxWith({ noApproval: true });
  const before = calls["session:rename"]!.length;
  const r = await call("session.rename", { id: "s9", title: "d" }, ctx);
  check("没有审批通道:fail-closed", r.isError === true && calls["session:rename"]!.length === before, textOf(r));
}
{
  const { ctx } = ctxWith();
  const r = await call("setting.get", { key: "x" }, ctx);
  check("返回值打码", !textOf(r).includes('"k"') && textOf(r).includes(REDACTED), textOf(r));
}

/* ── 2b. 密钥设置键:setting.get 直读那条旁路 ── */
// `customModel.getToken` / `piModels.getApiKey` / `codexModels.getApiKey` 都显式
// 钉在 blocked 档(「API Key / 令牌不给模型」)。但设置表里那几份**密钥本体**是普通
// 设置键,而 `setting.get` 是 `read` 档、**自动放行** —— 于是同一个东西换条路就拿到了:
// `app_api_call { method: "setting.get", input: { key: "customModelKeys" } }`。而
// renderResult 的打码只认字段名与值的形态,`customModelKeys` 的**值**是一张
// `id → base64(密文)` 的表,id 是随机串、密文不含 `sk-` 之类,两道都绕过了。
{
  const calls2: Record<string, unknown[]> = {};
  // 不 clearRpcHandlers():本文件后面的断言还要用先前那批 handler。只覆盖这两条。
  recordRpcHandler("setting:get", async (_e, raw) => {
    const k = (raw as { key?: string }).key;
    // 真实 handler 直读设置表,这里照抄那份"密钥本体在表里"的事实。
    return { value: k === "customModelKeys" ? JSON.stringify({ c1: "RU5DSVBIRVJFRF9BUFBfS0VZ" }) : "ok" };
  });
  recordRpcHandler("setting:getMany", async (_e, raw) => {
    const keys = (raw as { keys?: string[] }).keys ?? [];
    return Object.fromEntries(keys.map((k) => [k, k === "customModelKeys" ? JSON.stringify({ c1: "RU5DSVBIRVJFRF9BUFBfS0VZ" }) : "ok"]));
  });
  void calls2;
  const { ctx } = ctxWith();
  const single = await call("setting.get", { key: "customModelKeys" }, ctx);
  check(
    "★ setting.get 不许直读密钥设置键(customModelKeys)",
    single.isError === true && !textOf(single).includes("RU5DSVBIRVJFRF9BUFBfS0VZ"),
    textOf(single),
  );
  const many = await call("setting.getMany", { keys: ["ui.locale", "customModelKeys"] }, ctx);
  check(
    "★ setting.getMany 也不许夹带密钥设置键",
    many.isError === true || !textOf(many).includes("RU5DSVBIRVJFRF9BUFBfS0VZ"),
    textOf(many),
  );
  // 同一形状的另两个密钥本体(piProviderKeys / codexProviderKeys),以及它们的结构性
  // 名字 —— 逐个往名单里加是追着漏,判据要落在**键名的形状**上。
  for (const key of ["piProviderKeys", "codexProviderKeys"]) {
    const r = await call("setting.get", { key }, ctx);
    check(`★ setting.get 不许直读 ${key}`, r.isError === true, textOf(r));
  }
}
{
  const { ctx } = ctxWith({ mode: "bypassPermissions" });
  const r = await call("session.archive", { nope: 1 }, ctx);
  check("参数错误说人话", r.isError === true && textOf(r).includes("参数不对") && textOf(r).includes("app_api_describe"), textOf(r));
}
{
  const { ctx } = ctxWith();
  const r = await call("no.such", {}, ctx);
  check("未知方法", r.isError === true && textOf(r).includes("app_api_list"), textOf(r));
  const listed = await invokeAppTool("app_api_list", {}, "me", ctx);
  check("app_api_list 目录", textOf(listed).includes("project(") && textOf(listed).includes("app_api_describe"), textOf(listed).slice(0, 200));
  const dom = await invokeAppTool("app_api_list", { domain: "plugins" }, "me", ctx);
  check("app_api_list 按域、带权限档", textOf(dom).includes("plugins.installGit [高风险·每次批准]"), textOf(dom).slice(0, 300));
  const desc = await invokeAppTool("app_api_describe", { method: "session.rename" }, "me", ctx);
  check("app_api_describe 有参数格式", textOf(desc).includes("参数:") && textOf(desc).includes("title"), textOf(desc));
}

/* ── 4. ApprovalBridge ── */
{
  const bridge = new ApprovalBridge();
  const emitted: unknown[] = [];
  const ask = bridge.makeApprovalHandler("s1", (e) => emitted.push(e));
  const p1 = ask({ requestId: "r1", toolName: `${APP_DANGER_APPROVAL_PREFIX}project.delete`, input: {} });
  bridge.resolveApproval("r1", { allow: true }, true);
  const d1 = await p1;
  check("ApprovalBridge:高风险不带 persist", d1.allow === true && d1.persist !== true, d1);
  check("ApprovalBridge:高风险不记始终允许", !bridge.isAlwaysAllowed("s1", `${APP_DANGER_APPROVAL_PREFIX}project.delete`));
  const p2 = ask({ requestId: "r2", toolName: "mcode-app:session.rename", input: {} });
  bridge.resolveApproval("r2", { allow: true }, true);
  await p2;
  check("ApprovalBridge:普通写照常记", bridge.isAlwaysAllowed("s1", "mcode-app:session.rename"));
}

/* ── 5. 界面通道 ── */
{
  const seen: unknown[] = [];
  const win: Record<string, unknown> = {
    [APP_CONTROL_RENDERER_GLOBAL]: async (raw: string) => {
      const cmd = JSON.parse(raw);
      seen.push(cmd);
      return JSON.stringify(cmd.op === "state" ? { ok: true, data: { activeSession: { id: "s1" } } } : { ok: true, data: { sessionId: "s2" } });
    },
  };
  (globalThis as Record<string, unknown>).window = win;
  setRendererPortForTest({ executeJavaScript: async (code) => (0, eval)(code) });
  const { ctx, asked } = ctxWith();
  const st = await invokeAppTool("app_ui_state", {}, "me", ctx);
  check("界面状态一来一回", !st.isError && textOf(st).includes("s1") && asked.length === 0, textOf(st));
  const self = await invokeAppTool("app_session_send", { session_id: "me", prompt: "hi" }, "me", ctx);
  check("不能给自己发消息", self.isError === true && asked.length === 0, textOf(self));
  const sent = await invokeAppTool("app_session_send", { session_id: "other", prompt: "hi" }, "me", ctx);
  check("发消息先过审批再下指令", !sent.isError && asked.length === 1 && asked[0]!.req.toolName === "mcode-app:session_send" && (seen.at(-1) as { op: string }).op === "send", textOf(sent));
  const nav = await invokeAppTool("app_ui", { action: "open_session", session_id: "x" }, "me", ctx);
  check("纯界面操作不问", !nav.isError && asked.length === 1, textOf(nav));
  const pm = await invokeAppTool("app_ui", { action: "set_pref", key: "permissionMode", value: "bypassPermissions" }, "me", ctx);
  check("改权限模式 = 高风险", !pm.isError && asked.at(-1)!.req.toolName.startsWith(APP_DANGER_APPROVAL_PREFIX), asked.at(-1)?.req.toolName);
  const badUrl = await invokeAppTool("app_ui", { action: "open_url", url: "file:///etc/passwd" }, "me", ctx);
  check("open_url 只收 http(s)", badUrl.isError === true, textOf(badUrl));
  (globalThis as Record<string, unknown>).window = {};
  const notReady = await invokeAppTool("app_ui_state", {}, "me", ctx);
  check("界面没准备好时说清楚", notReady.isError === true && textOf(notReady).includes("界面还没准备好"), textOf(notReady));
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
}

/* ── 6. 接线(源码) ── */
const src = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");
const claude = src("src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts");
check("Claude 挂上 mcode-app", claude.includes("options.mcpServers[APP_MCP_SERVER] = await buildAppMcpServer("));
check("Claude canUseTool 对 app_ 放行(handler 自己审)", claude.includes("mcp__${APP_MCP_SERVER}__app_"));
const codex = src("src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");
check("Codex 动态工具挂上", codex.includes("...appToolDescriptors(),") && codex.includes("invokeAppEngineTool(name, args, req.sessionId, ctx)"));
const pi = src("src/main/providers/pi-sdk/mcodeExtension.ts");
check("Pi 注册并在守卫放行", pi.includes("for (const tool of appToolDescriptors())") && pi.includes('toolName.startsWith("app_")) return;'));
check("ipc/index.ts 登记 handler", src("src/main/ipc/index.ts").includes("recordRpcHandler(channel, guarded"));
check("审批卡认高风险前缀", src("src/renderer/components/chat/ApprovalPrompt.tsx").includes("APP_DANGER_APPROVAL_PREFIX"));
check("公网/扩展那条路不挂 mcode-app", !src("src/main/mcp/webToolHost.ts").includes("appMcpTools"));
check("描述符与工具表一致", appToolDescriptors().length === appMcpTools().length && appMcpTools().every((t) => isAppToolName(t.name)));
// ★ **功能清单必须与 RpcMap 逐条对齐,不是「数量差不多」。**
//
// 从前这里写的是 `Math.abs(rpcKeys - API_CATALOG.length) > 3` 才 `console.warn` —— 两层
// 都漏:`> 3` 的容差让 **1~3 条**的漂移静默通过(实测 `engineTools.get` / `engineTools.set`
// 就不在清单里,差 2 条,一直没报);而且它只是 `warn`,不是断言,套件照样绿。
//
// 后果是**可发现性**:`apiEntries()` 把「清单」与「实际注册过的通道」并起来(`findEntry`
// 走的是它),所以缺的那两条**调得到**——但只能通过注册那条兜底路径,拿到的说明是空的
// (`"(清单里没有说明,按报错提示传参)"`),`app_api_list` 按域列时也数不到它们。agent 也就
// 看不见「按引擎禁用内置工具」这个能力(设置 → 引擎工具),自然想不起来用。
// ⚠️ 别把它说成"调不到"——那是错的,兜底路径一直在。
//
// 判据用**集合**而不是计数:数目相等而成员不同的情形,恰恰是计数容差最容易放过的那种。
{
  const catalogMethods = new Set(API_CATALOG.map((e) => e.method));
  const rpcMethods = new Set(
    (src("../../packages/contracts/src/ipc/rpcMap.ts").match(/^\s+"([a-zA-Z]+\.[a-zA-Z.]+)":/gm) ?? [])
      .map((m) => m.trim().replace(/^"|":$/g, "")),
  );
  // 防"空过":正则改一行、或 rpcMap 的写法变了,两个集合双双变空 —— 上面那条对齐断言
  // 就成了"0 个缺、0 个多"的假绿。先钉住解析确实取到了东西。
  check("RpcMap 解析得到方法名（防断言空过）", rpcMethods.size > 300, rpcMethods.size);
  const missing = [...rpcMethods].filter((m) => !catalogMethods.has(m)).sort();
  const extra = [...catalogMethods].filter((m) => !rpcMethods.has(m)).sort();
  check(
    "★ 功能清单与 RpcMap 逐条对齐（差一条 agent 就看不见它的说明）",
    missing.length === 0 && extra.length === 0,
    { missing, extra, hint: "跑一次 node scripts/gen-app-api-catalog.mjs" },
  );
  // 钉住那两条曾漂移的:光对齐还不够,它们必须**真的在**清单里(免得将来又被别的手法漏掉)。
  check(
    "engineTools.get / engineTools.set 在清单里",
    catalogMethods.has("engineTools.get") && catalogMethods.has("engineTools.set"),
  );
}

console.log(`\n${passed}/${passed + failures.length} 通过`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
