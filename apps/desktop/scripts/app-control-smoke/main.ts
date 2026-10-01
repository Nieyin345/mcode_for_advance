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
];
for (const [m, l] of pin) check(`权限 ${m} = ${l}`, policyFor(m).level === l, policyFor(m));
// 凡是名字里带 getToken / getApiKey 的都不能是可读档
for (const e of API_CATALOG) {
  if (/getToken|getApiKey/i.test(e.method)) check(`${e.method} 不开放`, policyFor(e.method).level === "blocked");
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
const rpcKeys = (src("../../packages/contracts/src/ipc/rpcMap.ts").match(/^\s+"[a-zA-Z]+\.[a-zA-Z.]+":/gm) ?? []).length;
if (Math.abs(rpcKeys - API_CATALOG.length) > 3) {
  console.warn(`⚠️ 功能清单可能过期:RpcMap ${rpcKeys} 项、清单 ${API_CATALOG.length} 项 —— 跑一次 node scripts/gen-app-api-catalog.mjs`);
}

console.log(`\n${passed}/${passed + failures.length} 通过`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
