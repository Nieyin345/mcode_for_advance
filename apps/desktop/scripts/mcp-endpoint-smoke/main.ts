/**
 * Headless smoke for the **MCP endpoint** —— 网页版模型调 mcode 工具的那条通路。
 *
 * ## 两半,各自独立地诚实
 *
 * **上半:协议。** 走**真的 HTTP**(真的起桥、真的 127.0.0.1、真的 Bearer 令牌),
 * 工具宿主是假的 —— 这一半要验的是"扩展照 MCP 说话,mcode 答得对不对":
 * initialize 的版本协商、notification 该 202 就 202、未知方法 / 未知工具各自的错误码、
 * 工具抛异常要变成 isError 的结果(而不是把连接搞坏)、`x-mcode-session` 有没有被认出来。
 *
 * **下半:闸门。** 真的 `createWebToolHost`,直接调 —— 这一半要验的是**决定**:
 * 没有会话一律拒、参数不合法一律拒、只读工具不弹卡、写工具弹卡、用户拒了**不许执行**。
 * 这四条是这个功能的信任边界,而它们全都藏在"点完按钮之后"那几行里,只有直接调才看得见。
 *
 * ## 没覆盖的(写清楚,免得被当已验)
 *
 *  - **文献库那十几个真 handler**:库存真相在 sql.js 里,无头给不出来。它们由各自那条
 *    路覆盖(真机用一次)。这里用的是形状相同的替身表(见 stubs/libraryServer.ts);
 *  - **审批卡在界面上真的弹出来**:那要一次真人操作。这里验到"闸门问了,而且按回答办事";
 *  - **扩展那侧**:它是个标准 MCP 客户端,由它自己的测试管。
 *
 * Run: scripts/mcp-endpoint-smoke/run.sh
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bridgeStatus,
  configureExtensionBridgeTokenStore,
  ensureStarted,
  stopExtensionBridge,
} from "@main/providers/bridge/extensionBridge.js";
import {
  configureMcpToolHost,
  MCODE_SESSION_HEADER,
  MCP_ENDPOINT_PATH,
  type McpToolCallResult,
  type McpToolInfo,
} from "@main/providers/bridge/mcpEndpoint.js";
import { createWebToolHost, type WebToolGate } from "@main/mcp/webToolHost.js";
import { WORKFLOW_READONLY_TOOLS, workflowMcpTools } from "@main/mcp/mcodeServer.js";
import type { PermissionMode } from "@contracts/runtime";
import type { ApprovalRequest } from "@contracts/provider";
import { __handlerCalls } from "./stubs/libraryServer.js";

let checks = 0;
let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    passed++;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), {
    expected,
    got: actual,
  });
}

/* ══════════════════════ 上半:协议(真 HTTP + 假宿主)══════════════════════ */

/** 假宿主 —— 只干两件事:把收到的 ctx 原样回出去;某个名字就抛异常。 */
interface FakeCall {
  name: string;
  args: unknown;
  sessionId: string | null;
}
const fakeCalls: FakeCall[] = [];

const FAKE_TOOLS: McpToolInfo[] = [
  { name: "t_echo", description: "回显", inputSchema: { type: "object" } },
  { name: "t_boom", description: "抛异常", inputSchema: { type: "object" } },
];

configureMcpToolHost({
  listTools: () => FAKE_TOOLS,
  async callTool(name, args, ctx): Promise<McpToolCallResult> {
    fakeCalls.push({ name, args, sessionId: ctx.sessionId });
    if (name === "t_boom") throw new Error("工具内部炸了");
    return { text: `echo:${JSON.stringify(args)}` };
  },
});

/* 令牌先换成一个固定的 —— 这一半要的不是"令牌从哪来",而是"令牌对不对"。 */
const TOKEN = randomUUID().replace(/-/g, "");
configureExtensionBridgeTokenStore({ get: () => TOKEN, set: () => {} });
await ensureStarted();
const base = bridgeStatus().url;
const endpoint = `${base}${MCP_ENDPOINT_PATH}`;
check("扩展桥起来了", /^http:\/\/127\.0\.0\.1:\d+$/.test(base), base);

interface RpcReply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

async function rpc(
  body: unknown,
  opts: { token?: string | null; sessionId?: string | null; method?: string; raw?: string } = {},
): Promise<RpcReply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.sessionId) headers[MCODE_SESSION_HEADER] = opts.sessionId;
  const method = opts.method ?? "POST";
  // GET/HEAD 带 body 会被 undici 直接拒掉(还没到服务端),而"GET 这个方法本身"
  // 就是这一条要验的东西 —— 所以按方法决定带不带体。
  const withBody = method !== "GET" && method !== "HEAD";
  const res = await fetch(endpoint, {
    method,
    headers,
    body: withBody ? opts.raw ?? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { __raw: text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

function resultOf(reply: RpcReply): Record<string, unknown> {
  return (reply.body.result ?? {}) as Record<string, unknown>;
}
function errorOf(reply: RpcReply): { code?: number; message?: string } {
  return (reply.body.error ?? {}) as { code?: number; message?: string };
}
/** tools/call 的第一段文本 —— 断言读它。 */
function textOf(reply: RpcReply): string {
  const content = (resultOf(reply).content ?? []) as Array<{ text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

/* ── 令牌是同一把(共用服务的意义就在这)── */
eq("没带令牌 → 401", (await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: null })).status, 401);
eq("令牌不对 → 401", (await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "nope" })).status, 401);

/* ─ 形状:只收 POST ── */
const getReply = await rpc(null, { method: "GET" });
eq("GET /mcp → 405", getReply.status, 405);

/* ── 坏请求体 ── */
eq("非 JSON → 400", (await rpc(null, { raw: "{oops" })).status, 400);
eq("JSON 数组 → 400", (await rpc([1, 2, 3])).status, 400);
eq("缺 method → -32600", errorOf(await rpc({ jsonrpc: "2.0", id: 7 })).code, -32600);

/* ── initialize ── */
const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
});
eq("initialize 回 200", init.status, 200);
eq("认得的版本按客户端报的走", resultOf(init).protocolVersion, "2025-03-26");
eq("capabilities 里只有 tools", Object.keys(resultOf(init).capabilities as object), ["tools"]);
eq(
  "tools.listChanged = false(工具表是代码决定的)",
  (resultOf(init).capabilities as { tools?: { listChanged?: boolean } }).tools?.listChanged,
  false,
);
const initUnknown = await rpc({
  jsonrpc: "2.0",
  id: 2,
  method: "initialize",
  params: { protocolVersion: "1999-01-01" },
});
eq("不认的版本回我们自己最新的", resultOf(initUnknown).protocolVersion, "2025-06-18");
const instructions = String((resultOf(init) as { instructions?: string }).instructions ?? "");
check("instructions 说明写操作要等用户确认", instructions.includes("用户"), instructions);
check("instructions 说了被拒不算出错", instructions.includes("拒绝"), instructions);

/* ── notification / ping ── */
const notified = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
eq("initialized 是 notification → 202", notified.status, 202);
eq("202 不带 body", notified.body, {});
eq("ping → 空结果", resultOf(await rpc({ jsonrpc: "2.0", id: 3, method: "ping" })), {});

/* ─ tools/list ── */
const list = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" });
eq("tools/list 报出宿主的表", (resultOf(list).tools as McpToolInfo[]).map((t) => t.name), ["t_echo", "t_boom"]);

/* ─ tools/call ─ */
const callNoHeader = await rpc({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: { name: "t_echo", arguments: { a: 1 } },
});
eq("没带会话头 → 宿主拿到 null", fakeCalls.at(-1)?.sessionId, null);
eq("调用的参数原样交给宿主", fakeCalls.at(-1)?.args, { a: 1 });
eq("结果按 MCP 的 content 形状回", resultOf(callNoHeader).content, [
  { type: "text", text: 'echo:{"a":1}' },
]);
eq("成功的调用不带 isError", "isError" in resultOf(callNoHeader), false);

const callWithHeader = await rpc(
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "t_echo", arguments: {} } },
  { sessionId: "sess-123" },
);
check("x-mcode-session 被认出来了", fakeCalls.at(-1)?.sessionId === "sess-123", fakeCalls.at(-1));
eq("带头的那次照样有结果", resultOf(callWithHeader).content, [{ type: "text", text: "echo:{}" }]);

const unknown = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } });
eq("表里没有的工具 → -32602(协议错,不是执行失败)", errorOf(unknown).code, -32602);
const noName = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} });
eq("没给名字 → -32602", errorOf(noName).code, -32602);

const boom = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "t_boom" } });
eq("工具抛异常也是 200 的结果", boom.status, 200);
eq("…而且 isError=true", resultOf(boom).isError, true);
check("…消息里带着原因", textOf(boom).includes("工具内部炸了"), textOf(boom));

/* ── 未知方法 ── */
eq("未知方法(带 id) → -32601", errorOf(await rpc({ jsonrpc: "2.0", id: 10, method: "x/y" })).code, -32601);
eq(
  "未知 notification(没 id) → 202(不该把客户端搞炸)",
  (await rpc({ jsonrpc: "2.0", method: "x/y" })).status,
  202,
);

/* ── 宿主没装配时不能假装有工具表 ── */
configureMcpToolHost(null);
eq(
  "宿主缺席 → tools/list 报 -32603",
  errorOf(await rpc({ jsonrpc: "2.0", id: 11, method: "tools/list" })).code,
  -32603,
);
eq(
  "宿主缺席 → tools/call 也报 -32603",
  errorOf(await rpc({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "t_echo" } })).code,
  -32603,
);

stopExtensionBridge();

/* ══════════════════════ 下半:真宿主 + 闸门 ═════════════════════ */

const approvalCalls: ApprovalRequest[] = [];
let mode: PermissionMode | undefined = "default";
let allowed = new Set<string>();
let allowDecision = true;
let gateKnown = true;

function makeGate(): WebToolGate {
  return {
    permissionMode: () => mode,
    isAlwaysAllowed: (toolName) => allowed.has(toolName),
    async requestApproval(req) {
      approvalCalls.push(req);
      return allowDecision ? { allow: true } : { allow: false, reason: "我现在不想动库里东西" };
    },
  };
}

/** agent 工具的工作目录 —— 临时目录,可切到 null 验"没有 cwd"的分支。 */
const CWD = mkdtempSync(path.join(tmpdir(), "mcode-agent-smoke-"));
let cwdValue: string | null = CWD;

const host = createWebToolHost({
  gateFor: () => (gateKnown ? makeGate() : null),
  // agent_* 工具的 cwd:指到一个临时目录,读/写/搜索的真跑都在里面发生,
  // 不碰用户机器上的任何真项目。
  cwdFor: () => cwdValue,
});

/* ── 报出去的表 ── */
const tools = host.listTools();
const names = tools.map((t) => t.name);
check("表里有替身库的工具", names.includes("library_probe"), names);
check("表里也有真工作流的工具(同一份表)", names.includes("workflow_list"), names);
check("agent 工具进表了(读/写/改/列/glob/grep/bash/技能)", [
  "agent_read_file",
  "agent_write_file",
  "agent_edit_file",
  "agent_list_dir",
  "agent_glob",
  "agent_grep",
  "agent_bash",
  "agent_skill_list",
  "agent_skill_read",
].every((n) => names.includes(n)), names);
check("工具数量 = 替身 3 + 真工作流 9 + agent 9", names.length === 21, names.length);
check(
  "同名工具只报一次",
  new Set(names).size === names.length,
  names.filter((n, i) => names.indexOf(n) !== i),
);

/** 表里每个工具的 inputSchema 都得是模型读得懂的那种。 */
for (const tool of tools) {
  const schema = JSON.stringify(tool.inputSchema);
  check(`[${tool.name}] 没有 $ref(展开过的)`, !schema.includes("$ref"), schema.slice(0, 200));
  check(`[${tool.name}] 没有 $defs`, !schema.includes("$defs"), schema.slice(0, 200));
  check(`[${tool.name}] 不带 $schema 噪声`, !schema.includes("$schema"), schema.slice(0, 200));
  check(`[${tool.name}] 是 object`, (tool.inputSchema as { type?: string }).type === "object");
  check(`[${tool.name}] 有 description`, tool.description.length > 0);
}

function schemaOf(name: string): Record<string, unknown> {
  return host.listTools().find((t) => t.name === name)?.inputSchema as Record<string, unknown>;
}

const nested = schemaOf("library_nested");
check(
  "嵌套数组的 item 就地展开",
  JSON.stringify(nested).includes('"name"') && JSON.stringify(nested).includes('"string"'),
  JSON.stringify(nested),
);
const probe = schemaOf("library_probe");
eq("必填字段进 required", probe.required, ["query"]);
const writeSchema = schemaOf("library_write");
eq("可选字段不进 required", writeSchema.required, ["id"]);
const realSchema = schemaOf("workflow_get");
eq("真工具(workflow_get)的必填也对", realSchema.required, ["id"]);

/* ─ 调用前的三道关:会话 / 名字 / 参数 ── */
const noSession = await host.callTool("library_probe", { query: "x" }, { sessionId: null });
eq("没有会话 → 拒", noSession.isError, true);
check("…并且说清楚是会话标识的问题", noSession.text.includes("会话标识"), noSession.text);
eq("…而且没弹审批卡", approvalCalls.length, 0);
eq("…而且没执行", __handlerCalls.length, 0);

gateKnown = false;
const noGate = await host.callTool("library_probe", { query: "x" }, { sessionId: "gone" });
eq("会话已不存在(闸门给 null)→ 拒", noGate.isError, true);
eq("…同样没执行", __handlerCalls.length, 0);
gateKnown = true;

eq(
  "表里没有的名字 → 拒",
  (await host.callTool("library_nope", {}, { sessionId: "s1" })).isError,
  true,
);
eq(
  "参数不合法 → 拒",
  (await host.callTool("library_write", { note: "没给 id" }, { sessionId: "s1" })).isError,
  true,
);
const badArgs = await host.callTool("library_write", {}, { sessionId: "s1" });
check("…失败消息点名了缺哪个字段", badArgs.text.includes("id"), badArgs.text);
eq("…校验不过就不弹卡", approvalCalls.length, 0);
eq("…校验不过就不执行", __handlerCalls.length, 0);

/* ── 只读工具:不问人 ── */
const readOk = await host.callTool("library_probe", { query: "对齐" }, { sessionId: "s1" });
eq("只读工具在 default 模式下直接跑", readOk.text, "probe:对齐");
eq("…没有弹卡", approvalCalls.length, 0);
eq("…handler 真的被调了", __handlerCalls, ["library_probe:对齐"]);

const realReadOnly = await host.callTool("workflow_list", {}, { sessionId: "s1" });
eq("真工作流的只读工具也不弹卡", approvalCalls.length, 0);
// 库是空的,但**内置工作流**还在(七份),所以这里的"跑出了结果"是指那份清单的
// 形状对,而不是"一条都没有"。这一条要证的是"放行了并且真的走到了真 handler",
// 内容本身由 mcode-admin-smoke 管。
check(
  "…并且真的跑出了结果(内置那几份的清单)",
  realReadOnly.text.includes("份:") && realReadOnly.text.includes("内置"),
  realReadOnly.text,
);
check(
  "闸门认识的只读清单里没有写工具",
  !WORKFLOW_READONLY_TOOLS.has("workflow_remove") && WORKFLOW_READONLY_TOOLS.has("workflow_list"),
);

/* ── 写工具:弹卡,按用户的回答办事 ── */
__handlerCalls.length = 0;
const writeOk = await host.callTool("library_write", { id: "p1" }, { sessionId: "s1" });
eq("写工具弹了卡", approvalCalls.length, 1);
eq("…卡上的工具名是裸名", approvalCalls[0].toolName, "library_write");
eq("…卡上带着(校验过的)入参", approvalCalls[0].input, { id: "p1" });
check("…卡上说明这是网页端发起的", (approvalCalls[0].description ?? "").includes("网页版"), approvalCalls[0].description);
eq("允许之后真的执行了", writeOk.text, "written:p1");
eq("…handler 跑了", __handlerCalls, ["library_write:p1"]);

approvalCalls.length = 0;
allowDecision = false;
const denied = await host.callTool("library_write", { id: "p2" }, { sessionId: "s1" });
eq("拒绝 → isError", denied.isError, true);
check("…消息带着用户的理由", denied.text.includes("我现在不想动库里东西"), denied.text);
check("…并且明说别换个说法重试", denied.text.includes("重试"), denied.text);
eq("…拒绝之后 handler 一次都没跑", __handlerCalls, ["library_write:p1"]);
allowDecision = true;

/* ── 「始终允许」与权限模式 ── */
approvalCalls.length = 0;
allowed = new Set(["library_write"]);
await host.callTool("library_write", { id: "p3" }, { sessionId: "s1" });
eq("「始终允许」之后不再弹卡", approvalCalls.length, 0);
eq("…但照旧执行", __handlerCalls, ["library_write:p1", "library_write:p3"]);
allowed = new Set();

approvalCalls.length = 0;
mode = "bypassPermissions";
await host.callTool("library_write", { id: "p4" }, { sessionId: "s1" });
eq("bypass 模式下写工具也不弹卡", approvalCalls.length, 0);
mode = "acceptEdits";
approvalCalls.length = 0;
await host.callTool("library_write", { id: "p5" }, { sessionId: "s1" });
eq(
  "acceptEdits 只放行 agent 改文件工具;库的写工具不在那一档,照样要问",
  approvalCalls.length,
  1,
);
mode = "default";

/* ── 真工作流的写工具同样要问,而且拒了就不执行 ── */
approvalCalls.length = 0;
allowDecision = false;
const wfDenied = await host.callTool("workflow_remove", { id: "w1" }, { sessionId: "s1" });
eq("真工作流的写工具要弹卡", approvalCalls.length, 1);
eq("…卡上的名字是裸名", approvalCalls[0].toolName, "workflow_remove");
eq("…拒了就是 isError", wfDenied.isError, true);
allowDecision = true;

/* ══════════ agent 工具真跑:临时目录里读/写/改/搜/执行 ══════════
 * 这一组要验的不是形状(schema 检查上面已覆盖),而是**它们真的动得了文件** ——
 * 网页模型唯一的"手"就是这几个工具,假放行或假执行都会变成"模型说要读,然后什么都没发生"。
 * cwd 全用相对路径,顺带验相对路径按 cwdFor 的目录解析。 */
mode = "acceptEdits"; // 写/改在这一档免卡,正好把"写免卡、bash 弹卡"的分界也验了
approvalCalls.length = 0; // 上一段 workflow_remove 的卡还挂在计数里,清零

const wrote = await host.callTool(
  "agent_write_file",
  { path: "note.md", content: "第一行:桥冒烟\n第二行:替换前\n" },
  { sessionId: "s1" },
);
eq("acceptEdits 档 agent_write_file 不弹卡", approvalCalls.length, 0);
check("…并且真的写进了 cwd(临时目录)", wrote.text.includes(path.join(CWD, "note.md")), wrote.text);

const readBack = await host.callTool("agent_read_file", { path: "note.md" }, { sessionId: "s1" });
check(
  "…agent_read_file 按行号读回来",
  readBack.text.includes("1\t第一行:桥冒烟") && readBack.text.includes("2\t第二行:替换前"),
  readBack.text,
);

const edited = await host.callTool(
  "agent_edit_file",
  { path: "note.md", old_string: "替换前", new_string: "替换后" },
  { sessionId: "s1" },
);
eq("agent_edit_file 免卡执行(同档)", approvalCalls.length, 0);
check("…报告了修改", edited.text.includes("已修改"), edited.text);
const readAfter = await host.callTool("agent_read_file", { path: "note.md" }, { sessionId: "s1" });
check("…文件内容真的变了", readAfter.text.includes("2\t第二行:替换后"), readAfter.text);

const listed = await host.callTool("agent_list_dir", {}, { sessionId: "s1" });
check("agent_list_dir 列出了刚写的文件", listed.text.includes("note.md"), listed.text);

const globbed = await host.callTool("agent_glob", { pattern: "**/*.md" }, { sessionId: "s1" });
check("agent_glob 按模式找到了它", globbed.text.includes("note.md"), globbed.text);

const grepped = await host.callTool("agent_grep", { pattern: "桥冒烟" }, { sessionId: "s1" });
check("agent_grep 按内容找到了行", grepped.text.includes("note.md:1:"), grepped.text);

/* bash:acceptEdits 不放行(分界),弹卡;允许后真的跑出输出。 */
approvalCalls.length = 0;
const bashed = await host.callTool(
  "agent_bash",
  { command: "echo bridge-smoke-9876" },
  { sessionId: "s1" },
);
eq("agent_bash 弹了卡(acceptEdits 不覆盖 bash)", approvalCalls.length, 1);
eq("…卡上是裸名", approvalCalls[0].toolName, "agent_bash");
check("…命令真的跑了,输出带回来了", bashed.text.includes("bridge-smoke-9876"), bashed.text);
check("…退出码也报了", bashed.text.includes("exit: 0"), bashed.text);

allowDecision = false;
const bashDenied = await host.callTool(
  "agent_bash",
  { command: "echo 不该跑" },
  { sessionId: "s1" },
);
eq("拒绝 bash → isError", bashDenied.isError, true);
check("…拒绝消息带着用户的理由", bashDenied.text.includes("我现在不想动库里东西"), bashDenied.text);
allowDecision = true;

/* cwd 缺席:相对路径被明确拒绝,提示用绝对路径。 */
cwdValue = null;
const noCwd = await host.callTool("agent_read_file", { path: "note.md" }, { sessionId: "s1" });
check("没有 cwd → 相对路径被拒并提示绝对路径", noCwd.text.includes("绝对路径"), noCwd.text);
cwdValue = CWD;

/* 技能:真跑(读的是机器上真实的 ~/.mcode/skills,只验形状不验内容 ——
 * 用户装了什么技能不该进断言)。 */
const skillList = await host.callTool("agent_skill_list", {}, { sessionId: "s1" });
check(
  "agent_skill_list 正常返回(空库也有话可说)",
  !skillList.isError && skillList.text.length > 0,
  skillList.text,
);
const skillMissing = await host.callTool("agent_skill_read", { name: "no-such-skill" }, { sessionId: "s1" });
check(
  "agent_skill_read 没有的技能给出指引",
  skillMissing.text.includes("agent_skill_list"),
  skillMissing.text,
);
const skillBad = await host.callTool("agent_skill_read", { name: "../escape" }, { sessionId: "s1" });
check("带路径分隔的名字被拒", skillBad.text.includes("不合法"), skillBad.text);

mode = "default";
rmSync(CWD, { recursive: true, force: true });

/* ── 报告 ── */
configureMcpToolHost(null);

console.log(`\n${passed}/${checks} 通过`);
if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}