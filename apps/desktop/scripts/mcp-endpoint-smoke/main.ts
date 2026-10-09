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
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
// 固定端口那两条断言要自己占一个端口当"别的程序"。
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bridgeStatus,
  configureExtensionBridgeTokenStore,
  ensureStarted,
  stopExtensionBridge,
} from "@main/providers/bridge/extensionBridge.js";
import {
  configureMcpLongCallTiming,
  configureMcpToolHost,
  MCODE_SESSION_HEADER,
  MCP_ENDPOINT_PATH,
  type McpToolCallResult,
  type McpToolInfo,
} from "@main/providers/bridge/mcpEndpoint.js";
import {
  configurePublicMcpStore,
  publicMcpPort,
  startPublicMcp,
  stopPublicMcp,
} from "@main/providers/bridge/publicMcpServer.js";
import { createWebToolHost, type WebToolGate } from "@main/mcp/webToolHost.js";
import { ApprovalBridge } from "@main/claude/ApprovalBridge.js";
import { SESSION_LOG_TOOLS, WORKFLOW_READONLY_TOOLS, workflowMcpTools } from "@main/mcp/mcodeServer.js";
import type { PermissionMode } from "@contracts/runtime";
import type { ApprovalRequest } from "@contracts/provider";
import { __handlerCalls, libraryMcpTools } from "./stubs/libraryServer.js";
import { configureDelegateDeps, delegateMcpTools, __resetDelegateJobs } from "@main/mcp/delegateServer.js";
// 会话夹具的灌入口 —— 与 `run.sh` 里 `@main/store/repositories.js` 的 alias 指向
// **同一个文件**（`mcode-admin-smoke/stubs/repositories.ts`）。不能写成
// `./stubs/repositories.js`：那个文件不存在，而 esbuild 会按真实路径去找。
import { __seedSessionLogs, LibraryRepo } from "../mcode-admin-smoke/stubs/repositories.js";

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

async function runFixturePython(code: string, args: string[] = []): Promise<void> {
  const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  let last = "";
  for (const exe of candidates) {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(exe, ["-c", code, ...args], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.once("error", (err) => resolve({ code: -1, stderr: err.message }));
      child.once("close", (exitCode) => resolve({ code: exitCode, stderr }));
    });
    if (result.code === 0) return;
    last = `${exe}: ${result.stderr.trim() || `exit ${result.code}`}`;
  }
  throw new Error(`fixture Python 失败:${last}`);
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
  { name: "t_image", description: "图片块", inputSchema: { type: "object" } },
  { name: "t_boom", description: "抛异常", inputSchema: { type: "object" } },
];

configureMcpToolHost({
  listTools: () => FAKE_TOOLS,
  async callTool(name, args, ctx): Promise<McpToolCallResult> {
    fakeCalls.push({ name, args, sessionId: ctx.sessionId });
    if (name === "t_boom") throw new Error("工具内部炸了");
    if (name === "t_image") {
      return {
        text: "tiny image",
        content: [
          { type: "text", text: "tiny image" },
          { type: "image", data: "cG5n", mimeType: "image/png" },
        ],
      };
    }
    return { text: `echo:${JSON.stringify(args)}` };
  },
});

/* 令牌先换成一个固定的 —— 这一半要的不是"令牌从哪来",而是"令牌对不对"。 */
const TOKEN = randomUUID().replace(/-/g, "");
/** 公网端点那把路径密钥（同样只关心"对不对"，不关心从哪来）。 */
const PUBLIC_SECRET = randomUUID().replace(/-/g, "");
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
check("instructions 指引远程训练走 detached job", instructions.includes("agent_remote_job_start"), instructions);
check("instructions 强调远程训练重试复用 job_id", instructions.includes("job_id"), instructions);

/* ── notification / ping ── */
const notified = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
eq("initialized 是 notification → 202", notified.status, 202);
eq("202 不带 body", notified.body, {});
eq("ping → 空结果", resultOf(await rpc({ jsonrpc: "2.0", id: 3, method: "ping" })), {});

/* ─ tools/list ── */
const list = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" });
eq("tools/list 报出宿主的表", (resultOf(list).tools as McpToolInfo[]).map((t) => t.name), ["t_echo", "t_image", "t_boom"]);

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

const imageReply = await rpc({
  jsonrpc: "2.0",
  id: 61,
  method: "tools/call",
  params: { name: "t_image", arguments: {} },
});
eq("MCP endpoint 原样保留标准 image content block", resultOf(imageReply).content, [
  { type: "text", text: "tiny image" },
  { type: "image", data: "cG5n", mimeType: "image/png" },
]);

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

/* ══════════════════════ 中段:公网 MCP 端点 ═════════════════════ */

/**
 * `publicMcpServer` —— 给 ChatGPT 的 Connector 用的那条路。它和上面的扩展桥是
 * **两个独立监听器、两种鉴权**：那边用 Bearer + 只放行扩展来源；这边用**路径里的
 * 密钥** + 放行任意来源（ChatGPT 的 Connector 不收 Bearer，只能靠路径）。
 *
 * 这一段要验的正是这条路的信任边界：
 *  - 密钥不对/路径形状不对 → **404**（不是 401 —— 不透露"这里确实有个端点"）；
 *  - 密钥对了 → 协议照常工作（复用同一个 `handleMcpRequest`）；
 *  - **合成会话被注入** → 这是这条路唯一让闸门能放行的机制，撤掉它就全拒。
 */
const PUBLIC_SESSION = "sess_smoke_synthetic";
let publicStoreEnabled = true;
let observedPublicRequest: (() => void) | null = null;
// ★ 判据立在**用户看到的那句话**上:store 没配(null)时,报的必须是"store 没配",
//   不是"端点已关闭"。从前的写法 `if (!store?.getEnabled())` 会先抛「端点已关闭」,
//   把真正的原因报成另一件事 —— 而 `if (!store)` 那句永远走不到。
//   (这一段的 store 还没装配,正好是 null。)
{
  let nullStoreError: string | null = null;
  try {
    await startPublicMcp();
  } catch (err) {
    nullStoreError = (err as Error).message;
  }
  check("★ store 未装配时报的是'set store is not configured',不是'端点已关闭'", (nullStoreError ?? "").includes("store is not configured"), nullStoreError);
  check("★ store 未装配时不会谎称'端点已关闭'", !(nullStoreError ?? "").includes("端点已关闭"), nullStoreError);
}
// 上一段末尾把宿主卸了（验"宿主缺席"那两条）；这里重新装回同一份 —— 公网端点读的
// 是**共享的**那份工具表，正是要验"两条通路的工具表是同一份"。
configureMcpToolHost({
  listTools: () => FAKE_TOOLS,
  async callTool(name, args, ctx): Promise<McpToolCallResult> {
    fakeCalls.push({ name, args, sessionId: ctx.sessionId });
    return { text: `echo:${JSON.stringify(args)}` };
  },
});
configurePublicMcpStore({
  getEnabled: () => publicStoreEnabled,
  setEnabled: (on) => {
    publicStoreEnabled = on;
  },
  getSecret: () => { observedPublicRequest?.(); return PUBLIC_SECRET; },
  setSecret: () => {},
  getSessionId: () => PUBLIC_SESSION,
  setSessionId: () => {},
});
await startPublicMcp();
const publicPort = publicMcpPort();
check("公网 MCP 服务起来了", publicPort > 0, publicPort);

/** 打到公网端点。`path` 省略时用正确密钥。 */
async function publicRpc(
  body: unknown,
  opts: { path?: string; method?: string; sessionHeader?: string | null } = {},
): Promise<RpcReply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // 外部**不带**会话头 —— 会话必须由服务端注入。带一个假的来验"覆写"。
  if (opts.sessionHeader) headers[MCODE_SESSION_HEADER] = opts.sessionHeader;
  const method = opts.method ?? "POST";
  const path = opts.path ?? `${MCP_ENDPOINT_PATH}/${PUBLIC_SECRET}`;
  const res = await fetch(`http://127.0.0.1:${publicPort}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
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

/* ── 密钥不对：一律 404，不区分原因 ── */
eq("密钥错 → 404", (await publicRpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: `${MCP_ENDPOINT_PATH}/wrong` })).status, 404);
eq("路径缺密钥段 → 404", (await publicRpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: MCP_ENDPOINT_PATH })).status, 404);
eq("密钥段多一层 → 404", (await publicRpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: `${MCP_ENDPOINT_PATH}/${PUBLIC_SECRET}/extra` })).status, 404);
eq("根路径 → 404", (await publicRpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: "/" })).status, 404);

/* ── 密钥**等长但不同**：这是唯一能真正走到常量时间比较那条路的输入。
   上面那些 "wrong" 是短串，会被长度检查先挡掉 —— 变异验证发现只测它们的话，
   "把比较写成永远返回 true" 这种改动一条都不会红（见 mut-public-mcp.py M1）。 ── */
{
  const sameLength = PUBLIC_SECRET.slice(0, -1) + (PUBLIC_SECRET.endsWith("a") ? "b" : "a");
  eq("等长但不同的密钥 → 404（真的走常量时间比较）",
    (await publicRpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: `${MCP_ENDPOINT_PATH}/${sameLength}` })).status,
    404);
  // 大小写翻转同样等长 —— 覆盖"比较的是内容而不是长度"。
  const flipped = PUBLIC_SECRET.toUpperCase() === PUBLIC_SECRET
    ? PUBLIC_SECRET.toLowerCase()
    : PUBLIC_SECRET.toUpperCase();
  eq("等长、大小写不同的密钥 → 404",
    (await publicRpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: `${MCP_ENDPOINT_PATH}/${flipped}` })).status,
    404);
}

/* ── 路径形状：多一段**且那一段恰好等于真密钥**时必须仍拒。
   上面那条 `/mcp/<secret>/extra` 的密钥段是 `<secret>` 之后还有 `extra`，
   而 `secretFromPath` 切出来的 `rest` 是 `<secret>/extra`，长度就与真密钥不同 ——
   于是它同样没走到"形状"那一步。这条把真密钥放在**前面**，让 `rest` 长度对不上
   的问题暴露不出来，必须靠"不许出现 `/`"这条规则来拒（见 mut-public-mcp.py M4）。 ── */
eq("密钥后面还挂一段 → 404（形状必须精确）",
  (await publicRpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { path: `${MCP_ENDPOINT_PATH}/${PUBLIC_SECRET}/x` })).status,
  404);

/* ── 密钥对了：协议原样可用 ── */
const pubInit = await publicRpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {} },
});
eq("密钥对 → initialize 200", pubInit.status, 200);
eq("…serverInfo 是 mcode", (resultOf(pubInit).serverInfo as { name?: string }).name, "mcode");
{
  // 公网那条的说明必须跟它的工具表对得上:没有工作流、要先 agent_context、说清锁在项目里。
  const pubInstr = String((resultOf(pubInit) as { instructions?: string }).instructions ?? "");
  check("公网 instructions 不声称有工作流", !pubInstr.includes("资料库、工作流"), pubInstr);
  check("公网 instructions 指引先调 agent_context", pubInstr.includes("agent_context"), pubInstr);
  check("公网 instructions 说明只能写可写项目", pubInstr.includes("writable_project"), pubInstr);
  check("公网 instructions 提到技能工具", pubInstr.includes("agent_skill") && !pubInstr.includes("agent_skill_read") && !pubInstr.includes("agent_read_files"), pubInstr);
  check("本机 instructions 照旧(有工作流)", instructions.includes("工作流"), instructions);
}
const pubList = await publicRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
eq("密钥对 → tools/list 200", pubList.status, 200);
eq("…工具表就是共享的那份", ((resultOf(pubList).tools ?? []) as unknown[]).length, FAKE_TOOLS.length);

// The setting must block both new requests and requests whose body was still arriving.
publicStoreEnabled = false;
eq("disabled setting refuses requests even on an existing listener", (await publicRpc({ jsonrpc: "2.0", id: 22, method: "tools/list" })).status, 404);
let refusedDisabledStart = false;
try { await startPublicMcp(); } catch { refusedDisabledStart = true; }
check("disabled endpoint cannot be restarted directly", refusedDisabledStart);
publicStoreEnabled = true;
{
  const body = JSON.stringify({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "t_echo", arguments: {} } });
  const accepted = new Promise<void>(resolve => { observedPublicRequest = resolve; });
  let finishBody!: () => void;
  const response = new Promise<number>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: publicPort, path: `/mcp/${PUBLIC_SECRET}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.flushHeaders();
    finishBody = () => req.end(body);
  });
  await accepted;
  observedPublicRequest = null;
  publicStoreEnabled = false;
  const before = fakeCalls.length;
  finishBody();
  eq("disable while request body arrives refuses dispatch", await response, 404);
  eq("disabled buffered request does not execute a tool", fakeCalls.length, before);
  publicStoreEnabled = true;
}

/* ── 合成会话注入：外部不带会话头，宿主却应该收到那条合成会话 ── */
fakeCalls.length = 0;
const pubCall = await publicRpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "t_echo", arguments: { hi: 1 } },
});
eq("密钥对 → tools/call 200", pubCall.status, 200);
eq("…返回了回显", textOf(pubCall), `echo:{"hi":1}`);
eq("…宿主收到的会话是合成会话（外部没带）", fakeCalls[0]?.sessionId, PUBLIC_SESSION);

/* ── 外部塞的会话头被**覆写**，不能借它冒充别的会话 ── */
fakeCalls.length = 0;
await publicRpc(
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "t_echo", arguments: {} } },
  { sessionHeader: "sess_someone_else" },
);
eq("外部塞的会话头被覆写成合成会话", fakeCalls[0]?.sessionId, PUBLIC_SESSION);

/* ── CORS 预检：不碰密钥也该答（浏览器发正式请求前就要这个答复）── */
const preflight = await publicRpc(null, { method: "OPTIONS", path: MCP_ENDPOINT_PATH });
eq("OPTIONS 预检 → 204", preflight.status, 204);
eq("…放行任意来源（ChatGPT 的 Connector 不是扩展来源）", preflight.headers.get("access-control-allow-origin"), "*");

/* ── 多项目并行:每个项目一条链接,各落到各自的合成会话 ───────────────────
 * 用户要"几个项目同时提供"。默认链接照旧;另外几条链接各有密钥,命中哪条就把哪条
 * 的会话注入 —— 宿主据此给出各自的沙箱/工作目录。 */
{
  const LINK_A = "a".repeat(63) + "1";
  const LINK_B = "b".repeat(63) + "2";
  const linkSessions: Record<string, string | null> = { projA: "sess_link_a", projB: "sess_link_b", gone: null };
  configurePublicMcpStore({
    getEnabled: () => publicStoreEnabled,
    setEnabled: () => {},
    getSecret: () => { observedPublicRequest?.(); return PUBLIC_SECRET; },
    setSecret: () => {},
    getSessionId: () => PUBLIC_SESSION,
    setSessionId: () => {},
    listProjectLinks: () => [
      { projectId: "projA", secret: LINK_A },
      { projectId: "projB", secret: LINK_B },
      { projectId: "gone", secret: "c".repeat(64) },
    ],
    linkSessionId: (projectId) => linkSessions[projectId] ?? null,
  });
  const callVia = async (secret: string) => {
    fakeCalls.length = 0;
    const r = await publicRpc(
      { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "t_echo", arguments: {} } },
      { path: `${MCP_ENDPOINT_PATH}/${secret}`, sessionHeader: "sess_spoof" },
    );
    return { status: r.status, session: fakeCalls[0]?.sessionId ?? null };
  };
  const viaA = await callVia(LINK_A);
  eq("★ 项目链接 A → 落到 A 的合成会话", viaA.session, "sess_link_a");
  const viaB = await callVia(LINK_B);
  eq("★ 项目链接 B → 落到 B 的合成会话(与 A 互不串)", viaB.session, "sess_link_b");
  const viaMain = await callVia(PUBLIC_SECRET);
  eq("★ 默认链接照旧落到默认会话", viaMain.session, PUBLIC_SESSION);
  eq("★ 项目已删的链接 → 404", (await callVia("c".repeat(64))).status, 404);
  eq("★ 等长但不是任何一条链接 → 404", (await callVia("d".repeat(64))).status, 404);
  // 几条链接同时打进来:各回各的会话(服务端没有"当前项目"这种全局状态)
  const both = await Promise.all([
    publicRpc({ jsonrpc: "2.0", id: 41, method: "tools/list" }, { path: `${MCP_ENDPOINT_PATH}/${LINK_A}` }),
    publicRpc({ jsonrpc: "2.0", id: 42, method: "tools/list" }, { path: `${MCP_ENDPOINT_PATH}/${LINK_B}` }),
  ]);
  check("★ 两条链接并发都 200", both.every((r) => r.status === 200), both.map((r) => r.status));
}

/* ── 慢调用:Cloudflare 100 秒无字节就 524 —— 公网这条路把慢调用改成 SSE + 保活 ──
 * 快调用照旧一个 JSON;慢调用(超过切换阈值)先回 event-stream 头、发保活注释、
 * 最后一条 message 事件带上 JSON-RPC 结果。客户端没声明收 SSE 时一律老样子。 */
{
  configureMcpLongCallTiming({ switchAfterMs: 150, keepaliveMs: 60 });
  configureMcpToolHost({
    listTools: () => FAKE_TOOLS,
    async callTool(name, args, ctx): Promise<McpToolCallResult> {
      fakeCalls.push({ name, args, sessionId: ctx.sessionId });
      const delay = Number((args as { delayMs?: unknown } | undefined)?.delayMs ?? 0);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { text: `echo:${JSON.stringify(args)}` };
    },
  });
  const rawCall = async (delayMs: number, accept: string) => {
    const res = await fetch(`http://127.0.0.1:${publicPort}${MCP_ENDPOINT_PATH}/${PUBLIC_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: accept },
      body: JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "t_echo", arguments: { delayMs } } }),
    });
    return { type: res.headers.get("content-type") ?? "", text: await res.text() };
  };
  const BOTH = "application/json, text/event-stream";
  const fast = await rawCall(0, BOTH);
  check("★ 快调用照旧回 JSON", fast.type.includes("application/json"), fast.type);
  const slow = await rawCall(400, BOTH);
  check("★ 慢调用改回 SSE", slow.type.includes("text/event-stream"), slow.type);
  check("★ …中途有保活注释", slow.text.includes(": keepalive"), slow.text.slice(0, 200));
  const dataLine = slow.text.split("\n").find((l) => l.startsWith("data: ")) ?? "";
  let parsedSse: { id?: unknown; result?: { content?: { text?: string }[] } } = {};
  try {
    parsedSse = JSON.parse(dataLine.slice(6)) as typeof parsedSse;
  } catch {
    /* 下面那条断言会红 */
  }
  check("★ …最后一条 message 带着同 id 的结果", parsedSse.id === 77 && (parsedSse.result?.content?.[0]?.text ?? "").startsWith("echo:"), dataLine);
  check("★ …事件名是 message", slow.text.includes("event: message"), slow.text.slice(-200));
  const slowJsonOnly = await rawCall(300, "application/json");
  check("★ 客户端不收 SSE 时慢调用也回 JSON", slowJsonOnly.type.includes("application/json"), slowJsonOnly.type);
  configureMcpLongCallTiming({ switchAfterMs: 25_000, keepaliveMs: 20_000 });
  configureMcpToolHost({
    listTools: () => FAKE_TOOLS,
    async callTool(name, args, ctx): Promise<McpToolCallResult> {
      fakeCalls.push({ name, args, sessionId: ctx.sessionId });
      return { text: `echo:${JSON.stringify(args)}` };
    },
  });
}

/* ── 会话没备好时明确失败，而不是放一次没有闸门的调用 ── */
configurePublicMcpStore({
  getEnabled: () => publicStoreEnabled,
  setEnabled: () => {},
  getSecret: () => { observedPublicRequest?.(); return PUBLIC_SECRET; },
  setSecret: () => {},
  getSessionId: () => null,
  setSessionId: () => {},
});
eq(
  "没有合成会话 → 503（不放行没有闸门的调用）",
  (await publicRpc({ jsonrpc: "2.0", id: 5, method: "tools/list" })).status,
  503,
);

stopPublicMcp();
check("停掉之后不再监听", publicMcpPort() === 0, publicMcpPort());

// listen 是异步的：如果关闭只清全局 server，而没有作废 start 闭包里的 srv，
// bind 完成后会把公网端点重新挂回来。立即 stop 必须赢过在途 start。
const racingStart = startPublicMcp();
stopPublicMcp();
await racingStart;
check("★ 启动途中关闭不会在 bind 完成后复活公网端点", publicMcpPort() === 0, publicMcpPort());

/* ── 固定端口:要么就是那个端口,要么如实失败 ──────────────────────────
 *
 * 命名隧道的 ingress 在 Cloudflare 后台写死了 `127.0.0.1:<端口>`。所以这里**绝不能**
 * 在端口被占时悄悄换一个:换了的话,服务起来了、界面一切正常、`publicMcpStatus()` 也
 * 说 ready,而 Cloudflare 指着一个没人听的端口 —— 表现是"公网连不上但本机全好",
 * 是这摊里最难查的一种坏。这两条断言钉的就是这个取舍。
 */
let smokeFixedPort = 0;
configurePublicMcpStore({
  getEnabled: () => publicStoreEnabled,
  setEnabled: () => {},
  getSecret: () => { observedPublicRequest?.(); return PUBLIC_SECRET; },
  setSecret: () => {},
  getSessionId: () => PUBLIC_SESSION,
  setSessionId: () => {},
  getFixedPort: () => smokeFixedPort,
});

// 先占住一个端口 —— 占位的是**另一个**监听器,模拟"那个端口已经被别的程序用了"。
const squatter = createServer(() => {});
await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
const takenPort = (squatter.address() as AddressInfo).port;

smokeFixedPort = takenPort;
let fixedPortError: string | null = null;
try {
  await startPublicMcp();
} catch (err) {
  fixedPortError = (err as Error).message;
}
check("★ 固定端口被占用 → 如实抛错", fixedPortError !== null, fixedPortError);
check(
  "★ …而且不回落到随机端口(宁可没起来,也不能让 Cloudflare 指空)",
  publicMcpPort() === 0,
  publicMcpPort(),
);
check(
  "★ 错误里说得出是哪个端口(不然用户不知道该去关谁)",
  (fixedPortError ?? "").includes(String(takenPort)),
  fixedPortError,
);

// 端口让出来之后,同一个固定端口必须**正好**起在那上面(不是"随便找一个")。
await new Promise<void>((resolve) => squatter.close(() => resolve()));
await startPublicMcp();
eq("★ 固定端口可用时就听在那个端口上", publicMcpPort(), takenPort);
stopPublicMcp();
smokeFixedPort = 0;

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
/** 沙箱根。默认 null = 不限制(大多数断言要的是这个:它们读写 CWD 外面的临时文件)。
 *  专门那一段会临时设成 CWD,验越界被拒。 */
let sandboxValue: string | null = null;
/** 沙箱外只读门的替身(真那份要读库,见 `sandboxReadPolicy.ts`)。默认 = 都不归它管。 */
let readCheckImpl: (abs: string, kind: "read" | "list" | "search") => string | null | undefined = () => undefined;

const host = createWebToolHost({
  gateFor: () => (gateKnown ? makeGate() : null),
  // agent_* 工具的 cwd:指到一个临时目录,读/写/搜索的真跑都在里面发生,
  // 不碰用户机器上的任何真项目。
  cwdFor: () => cwdValue,
  sandboxRootFor: () => sandboxValue,
  sandboxReadCheck: (abs, kind) => readCheckImpl(abs, kind),
  // 替身工具表(见 stubs/libraryServer.ts):**网页端已经不挂真的库工具了**
  // (那 22 个从这张表撤掉了),但这一套要验的是**派发与闸门**,需要几件形状各异的
  // 替身把分支踩出来 —— 所以经这个注入点挂,而不是让生产硬挂一张它不要的表。
  extraTools: libraryMcpTools(),
});

/* ── 报出去的表 ── */
const tools = host.listTools();
const names = tools.map((t) => t.name);
check("表里有替身库的工具", names.includes("library_probe"), names);

/* ── 委派工具(mcode_agent_*):开关一拨立刻生效 ───────────────────────
   生产里 host 在启动时就建好了,委派的依赖是**之后**才装配的(initAgentDelegate)。
   以前那组工具进了静态表 → 永远报不出来;关掉之后也不会消失、照样能调。 */
{
  let delegateOn = false;
  configureDelegateDeps({
    enabled: () => delegateOn,
    ensureSession: async () => ({ sessionId: "s-delegate", cwd: CWD }),
    isBusy: () => false,
    runTurn: async () => ({ text: "ok" }),
    interrupt: () => {},
  });
  const hasDelegate = () => host.listTools().some((t) => t.name === "mcode_agent_start");
  check("委派:开关关着时不报", !hasDelegate());
  delegateOn = true;
  check("public MCP ignores legacy delegate setting in tools/list", !host.listTools("public").some(t => t.name.startsWith("mcode_agent_")));
  const deniedPublicDelegate = await host.callTool("mcode_agent_start", { prompt: "must not run" }, { sessionId: "s1", audience: "public" });
  check("public MCP rejects cached delegate tool calls", deniedPublicDelegate.isError === true, deniedPublicDelegate);
  approvalCalls.length = 0;
  check("委派:host 建好之后才装配、再打开,也报得出来", hasDelegate());
  delegateOn = false;
  check("委派:关掉之后立刻从表里消失", !hasDelegate());
  const offCall = await host.callTool("mcode_agent_start", { prompt: "x" }, { sessionId: "s1" });
  check("委派:关掉之后调不动", offCall.isError === true && offCall.text.includes("没有这个工具"), offCall.text);
  check("委派:静态那部分的表不受影响", host.listTools().length === tools.length, host.listTools().length);

  // ── 多项目并行:不同链接(调用方会话)各有一条委派会话,能同时跑;同一项目仍一次一轮,
  //    而且 A 链接看不见、打断不了 B 链接的任务。
  const running = new Set<string>();
  const releases: Array<() => void> = [];
  configureDelegateDeps({
    enabled: () => true,
    ensureSession: async (caller) => ({ sessionId: `deleg-${caller ?? "none"}`, cwd: CWD }),
    isBusy: (sid) => running.has(sid),
    runTurn: ({ sessionId }) => {
      running.add(sessionId);
      return new Promise((resolve) => {
        releases.push(() => {
          running.delete(sessionId);
          resolve({ text: `done ${sessionId}` });
        });
      });
    },
    interrupt: () => {},
  });
  const savedMode = mode;
  mode = "bypassPermissions";
  const jobOf = (text: string) => /任务号 (job_[0-9a-f]+)/.exec(text)?.[1] ?? "";
  const startA = await host.callTool("mcode_agent_start", { prompt: "a" }, { sessionId: "linkA" });
  const startB = await host.callTool("mcode_agent_start", { prompt: "b" }, { sessionId: "linkB" });
  check("★ 委派:两个项目的链接能同时各起一轮", !startA.isError && !startB.isError, [startA.text, startB.text]);
  const againA = await host.callTool("mcode_agent_start", { prompt: "a2" }, { sessionId: "linkA" });
  check("★ 委派:同一项目仍一次一轮(busy)", againA.isError === true && againA.text.startsWith("busy"), againA.text);
  const peek = await host.callTool("mcode_agent_result", { job_id: jobOf(startA.text), wait_seconds: 0 }, { sessionId: "linkB" });
  check("★ 委派:B 链接看不见 A 的任务", peek.isError === true, peek.text);
  const cancelPeek = await host.callTool("mcode_agent_cancel", { job_id: jobOf(startA.text) }, { sessionId: "linkB" });
  check("★ 委派:B 链接打断不了 A 的任务", cancelPeek.isError === true, cancelPeek.text);
  for (const r of releases.splice(0)) r();
  const own = await host.callTool("mcode_agent_result", { job_id: jobOf(startA.text), wait_seconds: 2 }, { sessionId: "linkA" });
  check("★ 委派:A 自己取得到结果", !own.isError && own.text.includes("done deleg-linkA"), own.text);

  // ★ **fail closed:空会话起的任务不能被任何链接看见。** 从前 `visibleJob` 只在
  //   两边都非空时才比较,于是 `callerSessionId === null` 的 job 对谁都可见 —— 别的
  //   项目能读到它的结果、也能打断它。这里直接驱 handler(绕过 webToolHost 那道会话
  //   闸)造出那个形状,证 isolation 是**两道**,不只靠 `callTool` 那一层。
  {
    __resetDelegateJobs();
    const runtime = new Set<string>();
    configureDelegateDeps({
      enabled: () => true,
      ensureSession: async (caller) => ({ sessionId: `deleg-${caller ?? "none"}`, cwd: CWD }),
      isBusy: (sid) => runtime.has(sid),
      runTurn: ({ sessionId }) => { runtime.add(sessionId); return new Promise(() => {}); },
      interrupt: () => {},
    });
    const startTool = delegateMcpTools().find((s) => s.name === "mcode_agent_start")!;
    const asNull = await startTool.handler({ prompt: "x" }, { sessionId: null } as never);
    const nullJobId = /任务号 (job_[0-9a-f]+)/.exec(
      (asNull as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n"),
    )?.[1] ?? "";
    check("★ 无会话(直接驱 handler)也能起任务,拿到 job 号", nullJobId.startsWith("job_"), nullJobId);
    const peekNull = await host.callTool("mcode_agent_result", { job_id: nullJobId, wait_seconds: 0 }, { sessionId: "linkA" });
    check("★ 空会话起的任务:链接 A 看不见(fail closed,不是 fail open)", peekNull.isError === true, peekNull.text);
    const cancelNull = await host.callTool("mcode_agent_cancel", { job_id: nullJobId }, { sessionId: "linkA" });
    check("★ 空会话起的任务:链接 A 也打断不了", cancelNull.isError === true, cancelNull.text);
    __resetDelegateJobs();
  }

  mode = savedMode;
  configureDelegateDeps(null);
}

/* ── tool annotations:ChatGPT 靠它决定要不要弹确认框 ──────────────────
   不标的只读工具会被当成写工具、每次都弹(社区里踩过的坑)。这里钉住两件事:
   ① 只读工具带 readOnlyHint: true;② 写工具带 false(destructiveHint: true)。 */
const annOf = (n: string) => (tools.find((t) => t.name === n)?.annotations ?? {}) as Record<string, unknown>;
eq("每个工具都报了 annotations", tools.every((t) => typeof t.annotations === "object"), true);
eq("只读工具 readOnlyHint=true", annOf("agent_read_file").readOnlyHint, true);
eq("…且 idempotentHint=true", annOf("agent_read_file").idempotentHint, true);
eq("写工具 readOnlyHint=false", annOf("agent_write_file").readOnlyHint, false);
eq("写工具 destructiveHint=true", annOf("agent_write_file").destructiveHint, true);
eq("…且不给 idempotentHint(没分析过重跑会怎样)", "idempotentHint" in annOf("agent_write_file"), false);
eq("bash 也是写工具", annOf("agent_bash").readOnlyHint, false);
eq("触网工具 openWorldHint=true(agent_read_url)", annOf("agent_read_url").openWorldHint, true);
eq("触网工具 openWorldHint=true(SSH)", annOf("agent_ssh_status").openWorldHint, true);
eq("纯本地读文件 openWorldHint=false", annOf("agent_read_file").openWorldHint, false);
// 文献库/工作流那些 server 的工具同样带上了(共用一份判定)。
eq("库里的读工具也带了 annotations", annOf("workflow_list").readOnlyHint, true);
check("表里也有真工作流的工具(同一份表)", names.includes("workflow_list"), names);
check("agent 工具进表：文件/搜索/系统进程/持久进程/技能", [
  "agent_read_file",
  "agent_read_files",
  "agent_read_document",
  "agent_read_image",
  "agent_read_docx_xml",
  "agent_read_url",
  "agent_write_file",
  "agent_create_directory",
  "agent_write_pdf",
  "agent_edit_excel_range",
  "agent_edit_docx_xml",
  "agent_edit_file",
  "agent_file_info",
  "agent_move_file",
  "agent_list_dir",
  "agent_glob",
  "agent_grep",
  "agent_search_start",
  "agent_search_read",
  "agent_search_stop",
  "agent_search_list",
  "agent_list_processes",
  "agent_kill_process",
  "agent_bash",
  "agent_process_start",
  "agent_process_read",
  "agent_process_sessions",
  "agent_process_write",
  "agent_process_stop",
  "agent_ssh_connect",
  "agent_ssh_status",
  "agent_ssh_disconnect",
  "agent_ssh_exec",
  "agent_remote_job_start",
  "agent_remote_job_status",
  "agent_remote_job_logs",
  "agent_remote_job_list",
  "agent_remote_job_cancel",
  "agent_skill_list",
  "agent_skill_read",
].every((n) => names.includes(n)), names);
// 网页端的表 = 替身 3 + 真工作流 9 + agent 41（含新加的 `agent_context`）。
// **库那 22 个不在里面** —— 它们已从网页端撤掉(见 webToolHost 里那段),桌面引擎那条
// 路照旧挂着。
// **工作流那 9 个 = 表里的 11 个减掉 2 个会话工具** —— `session_read_log` 与
// `session_list`(2026-09-24 加)从公网摘掉了,见 `SESSION_LOG_TOOLS` 与上面那几条断言。
// 这条数字就是防"谁又把它挂回来"或"谁不小心删了工具"。
check("工具数量 = 替身 7 + 真工作流 9 + agent 41", names.length === 57, names.length);
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
// 库是空的,但**自带的那几份工作流**还在,所以这里的"跑出了结果"是指那份清单的
// 形状对,而不是"一条都没有"。这一条要证的是"放行了并且真的走到了真 handler",
// 内容本身由 mcode-admin-smoke 管。
// ⚠️ 早先这里还要求正文含「内置」二字。「内置」标注已于 2026-09-26 退役
// (mcodeServer.ts:「不再标内置/自建」),这条之所以一直绿,只是因为某份自带工作流的
// 描述里碰巧有这两个字 —— f87c6fe 改了那段描述它就红了。改成认一份一定在的自带项。
check(
  "…并且真的跑出了结果(自带那几份的清单)",
  realReadOnly.text.includes("份:") && realReadOnly.text.includes("id=`default`"),
  realReadOnly.text,
);
check(
  "闸门认识的只读清单里没有写工具",
  !WORKFLOW_READONLY_TOOLS.has("workflow_remove") && WORKFLOW_READONLY_TOOLS.has("workflow_list"),
);
// ⚠️ `session_list` 是 2026-09-24 加的，它**不能**进只读集 —— 它能枚举用户的全部
// 对话，等于把"用户给 id 才算授权"那道闸门拆掉（见 mcodeServer 那段注释）。
check(
  "`session_list` 不在自动放行集里(它要用户点头)",
  !WORKFLOW_READONLY_TOOLS.has("session_list"),
);

/* ── ⚠️ 网页/扩展那条路**看不到**用户的对话记录（2026-09-24）────────────────
   `host.listTools()` **不带 audience = 本机浏览器扩展那条路（`/mcp`）** —— 这条路
   也有审批闸门（不是免审批），但读会话记录那组仍被摘掉：`session_read_log` +
   `session_list` 合起来 = 枚举这台机器上每一个项目的对话并读全文，`contentTag.ts`
   也白纸黑字记着「网页模型那条路的表里就没有 session_read_log」。所以摘掉是**有意**
   的（见 `webToolHost` 里那段注释）。公网那条路（audience=public）由 `compactPublicTools`
   从 `agentSpecs` 起建，结构上就够不到工作流工具，另有一条断言钉住。

   ⚠️ 从前这条断言的名字写着「公网工具体里没有」而调的是 `host.listTools()`（本地），
   名实不符 —— 正是它让"本地该不该带这两个工具"看起来暧昧。现在名字对回它实际验的表。 */
const localWebToolNames = host.listTools().map((t) => t.name);
for (const name of SESSION_LOG_TOOLS) {
  check(
    `本机浏览器扩展表(/mcp)里没有 ${name}`,
    !localWebToolNames.includes(name),
    localWebToolNames.filter((n) => n.includes("session")),
  );
}
// 公网那条路同样看不到（它连工作流那组都没有，结构上就到不了这两个）。
{
  const pubNames = host.listTools("public").map((t) => t.name);
  for (const name of SESSION_LOG_TOOLS) {
    check(`公网表里没有 ${name}`, !pubNames.includes(name), pubNames.filter((n) => n.includes("session")));
  }
}
// 反向确认：桌面本机那条路**照旧带着**它们（不传参数 = 带上）。
const localToolNames = workflowMcpTools().map((t) => t.name);
check(
  "桌面本机那条路仍然带着 session_read_log 与 session_list",
  [...SESSION_LOG_TOOLS].every((n) => localToolNames.includes(n)),
  localToolNames.filter((n) => n.includes("session")),
);

/* ── `session_read_log` 的三种模式（2026-09-24 加）─────────────────────── */
/**
 * 直接调真 handler。
 *
 * ⚠️ **不能用 `host.callTool`**：公网那张表**故意没有**这两个工具（上面刚断言过）。
 * 这里验的是工具本身的行为，所以从桌面那条路的表里取 handler 直调 —— 与
 * `mcode-admin-smoke` 验工作流工具的姿势一致。
 */
async function workflowHandler(name: string, args: Record<string, unknown>): Promise<string> {
  const spec = workflowMcpTools().find((s) => s.name === name);
  if (!spec) throw new Error(`工具表里没有 ${name}`);
  const res = await spec.handler(args, { sessionId: "s_probe" } as never);
  const textBlock = (res as { content?: Array<{ type: string; text?: string }> }).content?.find(
    (b) => b.type === "text",
  );
  return textBlock?.text ?? "";
}

__seedSessionLogs({
  sessions: [
    { id: "s_other", title: "被引用的那条", projectId: "p1", archived: false, updatedAt: 1 },
  ],
  messages: {
    s_other: [
      // 思考块 —— 用户要求「规避思考过程」，**绝不能**出现在输出里。
      // ⚠️ 用**真库的形状**（渲染端 Block 用 `kind`，`toRecords` 原样落库）——
      // 从前夹具灌的是引擎侧的 `type` 形状，而真库只有 `kind`，于是断言绿着、
      // 工具对着真会话全是"(这条没有文本内容)"。
      { role: "assistant", content: [{ kind: "thinking", text: "内部推理SECRET_MARKER" }] },
      { role: "user", content: [{ kind: "text", text: "用户问的问题" }] },
      { role: "assistant", content: [{ kind: "text", text: "助手的最终结论" }] },
    ],
  },
});
const logSummary = await workflowHandler("session_read_log", { sessionId: "s_other" });
const logUser = await workflowHandler("session_read_log", { sessionId: "s_other", mode: "user" });
const logResult = await workflowHandler("session_read_log", { sessionId: "s_other", mode: "result" });
check(
  "`session_read_log` 默认(summary)给用户 + 助手正文",
  logSummary.includes("用户问的问题") && logSummary.includes("助手的最终结论"),
  logSummary,
);
check(
  "⚠️ 思考过程不进输出(规避 thinking)",
  !logSummary.includes("SECRET_MARKER") && !logUser.includes("SECRET_MARKER") && !logResult.includes("SECRET_MARKER"),
  logSummary,
);
check(
  "`mode: user` 只给用户说的",
  logUser.includes("用户问的问题") && !logUser.includes("助手的最终结论"),
  logUser,
);
check(
  "`mode: result` 只给助手的回复",
  logResult.includes("助手的最终结论") && !logResult.includes("用户问的问题"),
  logResult,
);

/* ── `session_list`：列出对话，且**标清属于哪个项目**（用户明确要求）────── */
__seedSessionLogs({
  sessions: [
    { id: "s_a", title: "甲项目里的对话", projectId: "p1", archived: false, updatedAt: 200 },
    { id: "s_b", title: "乙项目里的对话", projectId: "p2", archived: false, updatedAt: 100 },
  ],
  projects: [
    { id: "p1", name: "甲项目", path: "/proj/alpha", archived: false },
    { id: "p2", name: "乙项目", path: "/proj/beta", archived: false },
  ],
});
const listOut = await workflowHandler("session_list", {});
check(
  "`session_list` 列出两条对话及它们的 id",
  listOut.includes("s_a") && listOut.includes("s_b"),
  listOut,
);
check(
  "…并且标清了**每个对话属于哪个项目**",
  listOut.includes("甲项目") && listOut.includes("乙项目") &&
    listOut.includes("/proj/alpha") && listOut.includes("/proj/beta"),
  listOut,
);
const listFiltered = await workflowHandler("session_list", { query: "乙项目" });
check(
  "…`query` 能按项目名过滤",
  listFiltered.includes("s_b") && !listFiltered.includes("s_a"),
  listFiltered,
);

/* ── `session_list` 的三个假阴性都要堵上（2026-09-24 审查抓出来的）──────── */
__seedSessionLogs({
  sessions: [
    // s_pinned 置顶 —— 真实现的 listByProject 活跃档会把它滤掉（`pinned_at IS NULL`），
    // 工具必须用 listPinned 补回来，否则用户置顶的对话模型永远找不到。
    { id: "s_pinned", title: "置顶的那条调研", projectId: "p1", archived: false, pinnedAt: 5, updatedAt: 300 },
    // s_archivedproj 在**已归档项目**下 —— 项目层不能被归档过滤掉。
    { id: "s_archivedproj", title: "归档项目里的对话", projectId: "p3", archived: false, updatedAt: 400 },
    { id: "s_archived", title: "已归档的对话", projectId: "p1", archived: true, updatedAt: 50 },
  ],
  projects: [
    { id: "p1", name: "甲项目", path: "/proj/alpha", archived: false },
    { id: "p3", name: "旧项目", path: "/proj/old", archived: true },
  ],
});
const listPinned = await workflowHandler("session_list", {});
check(
  "★ 置顶的对话也要列出来（活跃档要补回 listPinned）",
  listPinned.includes("s_pinned"),
  listPinned,
);
check(
  "★ 已归档项目下的对话也列得出（项目层不按归档过滤）",
  listPinned.includes("s_archivedproj"),
  listPinned,
);
check(
  "…默认档**不**列已归档的对话（archived 参数还在管会话层）",
  !listPinned.includes("id s_archived —"),
  listPinned,
);
const listArchived = await workflowHandler("session_list", { archived: true });
check(
  "…archived:true 连归档会话一起列",
  listArchived.includes("id s_archived —"),
  listArchived,
);
// 本地时间：UTC 的话 GMT+8 的"今天早上"会画成"昨天"。桩里 updatedAt 是毫秒数，
// 这里只验输出**不带** UTC 尾巴的特征（toISOString 的 T 前日期 + Z）。更直接的
// 判据：本地时间与 UTC 时间在非零时区必然不同天 —— 取一个夹在两天边界的值。
{
  __seedSessionLogs({
    sessions: [
      // 2026-09-24T20:30:00Z = GMT+8 的 2026-09-25 04:30。UTC 渲染会说 09-24，本地说 09-25。
      { id: "s_tz", title: "时区探针", projectId: "p1", archived: false, updatedAt: Date.UTC(2026, 8, 24, 20, 30) },
    ],
    projects: [{ id: "p1", name: "甲项目", path: "/proj/alpha", archived: false }],
  });
  const listTz = await workflowHandler("session_list", {});
  const utcDay = new Date(Date.UTC(2026, 8, 24, 20, 30)).toISOString().slice(0, 10);
  const localDay = new Date(Date.UTC(2026, 8, 24, 20, 30)).toLocaleDateString("sv-SE");
  if (utcDay === localDay) {
    console.log("  skip 时区断言（这台机器就是 UTC，测不出差别）");
  } else {
    check(
      "★ 最后活动时间是**本地**时间（不是 UTC 的昨天）",
      listTz.includes(localDay) && !listTz.includes(utcDay),
      { utcDay, localDay, listTz },
    );
  }
}

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


const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
writeFileSync(path.join(CWD, "pixel.png"), Buffer.from(tinyPngBase64, "base64"));
const imageRead = await host.callTool("agent_read_image", { path: "pixel.png" }, { sessionId: "s1" });
const imageBlock = imageRead.content?.find((block) => block.type === "image");
check(
  "agent_read_image 返回标准 MCP image content block 而不是把 base64 塞进文本",
  imageBlock?.type === "image" && imageBlock.mimeType === "image/png" && imageBlock.data === tinyPngBase64,
  imageRead.content,
);
check("图片工具的文本投影不包含 base64", !imageRead.text.includes(tinyPngBase64.slice(0, 20)), imageRead.text);

const richUnsupported = await host.callTool(
  "agent_read_document",
  { path: "plain.unsupported" },
  { sessionId: "s1" },
);
check(
  "agent_read_document 对不支持格式给明确能力边界",
  richUnsupported.text.includes("PDF/DOCX/XLSX/PPTX") || richUnsupported.text.includes("暂不支持"),
  richUnsupported.text,
);

/* Remote Desktop Commander 富文件写能力对齐：全部真落盘，再从 MCP 读回验证。 */
approvalCalls.length = 0;
const madeDir = await host.callTool(
  "agent_create_directory",
  { path: "remote-parity/nested/dir" },
  { sessionId: "s1" },
);
check("agent_create_directory 可递归建目录", madeDir.text.includes("remote-parity"), madeDir.text);
const madeDirInfo = await host.callTool(
  "agent_file_info",
  { path: "remote-parity/nested/dir", count_lines: false },
  { sessionId: "s1" },
);
check("新目录可立刻被 file_info 看见", madeDirInfo.text.includes("type: directory"), madeDirInfo.text);
eq("create_directory 在 acceptEdits 档免重复审批", approvalCalls.length, 0);

const createdPdf = await host.callTool(
  "agent_write_pdf",
  { output_path: "remote-parity-created.pdf", markdown: "# Remote Parity PDF\n\nPDF-MARKER-7419" },
  { sessionId: "s1" },
);
check("agent_write_pdf 从 Markdown 真生成 PDF", createdPdf.text.includes("PDF 已生成") && createdPdf.text.includes("1 页"), createdPdf.text);
const readCreatedPdf = await host.callTool(
  "agent_read_document",
  { path: "remote-parity-created.pdf", max_pages: 5 },
  { sessionId: "s1" },
);
check(
  "生成的 PDF 能被现有 pdfjs 再读回文本",
  readCreatedPdf.text.includes("PDF-MARKER-7419") && readCreatedPdf.text.includes("[PDF 1 页]"),
  readCreatedPdf.text.slice(0, 1000),
);

const insertedPdf = await host.callTool(
  "agent_write_pdf",
  {
    source_path: "remote-parity-created.pdf",
    output_path: "remote-parity-inserted.pdf",
    operations: [{ type: "insert", page_index: 1, source_pdf_path: "remote-parity-created.pdf" }],
  },
  { sessionId: "s1" },
);
check("PDF 可插入另一份 PDF 的页面", insertedPdf.text.includes("2 页"), insertedPdf.text);
const deletedPdf = await host.callTool(
  "agent_write_pdf",
  {
    source_path: "remote-parity-inserted.pdf",
    output_path: "remote-parity-deleted.pdf",
    operations: [{ type: "delete", page_indexes: [0] }],
  },
  { sessionId: "s1" },
);
check("PDF 可按 0-based page index 删除页面", deletedPdf.text.includes("1 页"), deletedPdf.text);
eq("PDF 创建/页操作在 acceptEdits 档按文件编辑放行", approvalCalls.length, 0);

const xlsxPath = path.join(CWD, "remote-parity.xlsx");
await runFixturePython(
  [
    "import sys",
    "from openpyxl import Workbook",
    "wb=Workbook(); ws=wb.active; ws.title='Data'",
    "ws['A1']='seed'; wb.save(sys.argv[1])",
  ].join("\n"),
  [xlsxPath],
);
const excelEdited = await host.callTool(
  "agent_edit_excel_range",
  { path: "remote-parity.xlsx", range: "Data!B2:C3", content: [["alpha", 11], ["beta", 22]] },
  { sessionId: "s1" },
);
check("agent_edit_excel_range 真写入 2x2 Range", excelEdited.text.includes("4 cells"), excelEdited.text);
const excelReadBack = await host.callTool(
  "agent_read_document",
  { path: "remote-parity.xlsx", sheet: "Data", range: "B2:C3", max_rows: 10, max_cols: 10 },
  { sessionId: "s1" },
);
check(
  "Excel Range 修改后能结构化读回",
  excelReadBack.text.includes("alpha") && excelReadBack.text.includes("beta") && excelReadBack.text.includes("22"),
  excelReadBack.text,
);

const docxPath = path.join(CWD, "remote-parity.docx");
await runFixturePython(
  [
    "import sys,zipfile",
    "p=sys.argv[1]",
    "ct='''<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>'''",
    "rels='''<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>'''",
    "doc='''<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Before Marker</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'''",
    "with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z: z.writestr('[Content_Types].xml',ct); z.writestr('_rels/.rels',rels); z.writestr('word/document.xml',doc)",
  ].join("\n"),
  [docxPath],
);
const docxXml = await host.callTool(
  "agent_read_docx_xml",
  { path: "remote-parity.docx", limit: 200 },
  { sessionId: "s1" },
);
check("agent_read_docx_xml 展开正文 OOXML 并带出文本节点", docxXml.text.includes("<w:t>Before Marker</w:t>"), docxXml.text);
const docxEdited = await host.callTool(
  "agent_edit_docx_xml",
  {
    path: "remote-parity.docx",
    old_string: "<w:t>Before Marker</w:t>",
    new_string: "<w:t>After Marker</w:t>",
    expected_replacements: 1,
  },
  { sessionId: "s1" },
);
check("agent_edit_docx_xml 精确替换并重新打包 DOCX", docxEdited.text.includes("替换 1 处"), docxEdited.text);
const docxAfter = await host.callTool(
  "agent_read_docx_xml",
  { path: "remote-parity.docx", limit: 200 },
  { sessionId: "s1" },
);
check("DOCX XML 修改后可再次读取且内容已变化", docxAfter.text.includes("<w:t>After Marker</w:t>"), docxAfter.text);
eq("Excel/DOCX 结构化编辑在 acceptEdits 档不重复弹卡", approvalCalls.length, 0);

const wrote = await host.callTool(
  "agent_write_file",
  { path: "note.md", content: "第一行:桥冒烟\n第二行:替换前\n" },
  { sessionId: "s1" },
);
eq("acceptEdits 档 agent_write_file 不弹卡", approvalCalls.length, 0);
check("…并且真的写进了 cwd(临时目录)", wrote.text.includes(path.join(CWD, "note.md")), wrote.text);

/* ── 沙箱:文件工具被限制在项目目录里 ────────────────────────────────
   公网那条通路没有审批闸门,所以给一个沙箱根。这一段把它设成 CWD,验三件事:
   内正常、外被拒、`..` 逃逸也被拒。 */
sandboxValue = CWD;
const insideRead = await host.callTool("agent_read_file", { path: "note.md" }, { sessionId: "s1" });
check("沙箱内路径正常", insideRead.text.includes("桥冒烟"), insideRead.text);

/* ── ⚠️ **cwd 与沙箱不同时必须以沙箱为准** ─────────────────────────────
   用户报的真 bug:会话的 `lastCwd`(跟着 `cd` 走)和用户选的沙箱项目**可以是两个不同的
   目录**。那时如果相对路径按 cwd 解析、却按沙箱校验,结果是**所有相对路径都被拒** ——
   用户看到的就是"列目录失败 / 读不了文件"。

   这里造出那个形状:cwd 指向 A,沙箱指向 B,读 B 里的相对路径**必须成功**。 */
const A = mkdtempSync(path.join(tmpdir(), "mcode-cwd-a-"));
const B = mkdtempSync(path.join(tmpdir(), "mcode-cwd-b-"));
writeFileSync(path.join(B, "in-b.txt"), "我在沙箱里", "utf8");
const savedCwd = cwdValue;
cwdValue = A; // 会话的 lastCwd 指向**别的**目录
sandboxValue = B; // 用户在设置里选的是 B
const crossRead = await host.callTool("agent_read_file", { path: "in-b.txt" }, { sessionId: "s1" });
check(
  "cwd 与沙箱不同时,相对路径按**沙箱**解析(不是拿过期的 cwd 去撞沙箱)",
  crossRead.text.includes("我在沙箱里"),
  crossRead.text,
);
const crossWrite = await host.callTool(
  "agent_write_file",
  { path: "b-new.md", content: "写在沙箱里" },
  { sessionId: "s1" },
);
check("…写也落在沙箱里,不是 cwd 里", !crossWrite.text.includes("越界"), crossWrite.text);
check("…而且真的写进了沙箱 B", existsSync(path.join(B, "b-new.md")));
check("…没写进 cwd A", !existsSync(path.join(A, "b-new.md")));
cwdValue = savedCwd;
rmSync(A, { recursive: true, force: true });
rmSync(B, { recursive: true, force: true });
sandboxValue = CWD;

/* ── `agent_context`:报的必须是**沙箱**那个项目,不是过期的 cwd ─────────────
   用户报的 bug:设置里只选了一个项目,agent 却报出另一个(`lastCwd` 缓存里那个)。
   这里 cwd 与沙箱**故意设成不同**,断言它报的是沙箱那个。 */
{
  const ctxA = mkdtempSync(path.join(tmpdir(), "mcode-ctx-a-"));
  const ctxB = mkdtempSync(path.join(tmpdir(), "mcode-ctx-b-"));
  const savedCwd2 = cwdValue;
  cwdValue = ctxA;
  sandboxValue = ctxB;
  // `readEnvSnapshot` 要查库,而库根走 `libraryRoot()` → `dataRoot()` → 那个**必须**
  // 有 `MCODE_SMOKE_DATA_ROOT`(桩见 dataRoot 的 alias,没设就抛)。这一段只是要验
  // "环境块报的是哪个项目",所以给它一个临时数据根即可。
  const savedRoot = process.env.MCODE_SMOKE_DATA_ROOT;
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "mcode-ctx-root-"));
  process.env.MCODE_SMOKE_DATA_ROOT = tmpRoot;
  const originalLibraryList = LibraryRepo.list;
  let libraryReads = 0;
  LibraryRepo.list = () => { libraryReads++; throw new Error("library must not be queried by default"); };
  try {
    const basic = await host.callTool("agent_context", {}, { sessionId: "s1" });
    check("default context works without library access", basic.structuredContent?.writable_project === ctxB && libraryReads === 0, basic);
  } finally { LibraryRepo.list = originalLibraryList; }
  const context = await host.callTool("agent_context", {}, { sessionId: "s1" });
  check(
    "agent_context 报的可写项目是**沙箱**那个(不是过期的 cwd)",
    (context.structuredContent?.writable_project as string | undefined) === ctxB,
    context.structuredContent,
  );
  check("…并且明说这个能写", context.text.includes("可写"), context.text);
  check("default context excludes library details", !context.text.includes("## 资料库") && !("library_root" in (context.structuredContent ?? {})), context);
  const libraryContext = await host.callTool("agent_context", { include_library: true }, { sessionId: "s1" });
  check("explicit library context remains available/read-only", libraryContext.text.includes("资料库") && libraryContext.text.includes("只读"), libraryContext);
  const noAuth = await host.callTool("agent_ssh_connect", { host: "127.0.0.1", username: "fixture" }, { sessionId: "ssh-contract" });
  check("missing SSH auth is an error, not successful connection text", noAuth.isError === true, noAuth);
  const conflictingAuth = await host.callTool("agent_ssh_connect", { host: "127.0.0.1", username: "fixture", password: "fixture", private_key_path: "/nonexistent-fixture-key" }, { sessionId: "ssh-contract" });
  check("SSH refuses ambiguous auth before opening a key", conflictingAuth.isError === true && conflictingAuth.text.includes("一种"), conflictingAuth);
  const badKey = await host.callTool("agent_ssh_connect", { host: "127.0.0.1", username: "fixture", private_key_path: "/nonexistent-fixture-key" }, { sessionId: "ssh-contract" });
  check("SSH failure has structured state and error flag", badKey.isError === true && badKey.structuredContent?.state === "error" && typeof badKey.structuredContent?.connection_id === "string", badKey);
  check("permanent SSH failure does not promise reconnection", !badKey.text.includes("稍后用 agent_ssh_status"), badKey);
  const connectionIds = [...(await host.callTool("agent_ssh_status", {}, { sessionId: "ssh-contract" })).text.matchAll(/connection_id: (\S+)/g)].map(m => m[1]);
  for (const connection_id of connectionIds) await host.callTool("agent_ssh_disconnect", { connection_id }, { sessionId: "ssh-contract" });
  const tinyLog = await host.callTool("agent_remote_job_logs", { connection_id: "not-created", job_id: "fixture", max_bytes: 1 }, { sessionId: "ssh-contract" });
  check("UTF8 log budget rejects less than one codepoint at schema boundary", tinyLog.isError === true && tinyLog.text.includes("参数不合法"), tinyLog);

  if (savedRoot === undefined) delete process.env.MCODE_SMOKE_DATA_ROOT;
  else process.env.MCODE_SMOKE_DATA_ROOT = savedRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
  cwdValue = savedCwd2;
  rmSync(ctxA, { recursive: true, force: true });
  rmSync(ctxB, { recursive: true, force: true });
  sandboxValue = CWD;
}

// 造一个**确凿在沙箱外**的文件(临时目录的同级),用它验越界。
const OUTSIDE = mkdtempSync(path.join(tmpdir(), "mcode-outside-smoke-"));
const outsideFile = path.join(OUTSIDE, "secret.txt");
writeFileSync(outsideFile, "沙箱外的内容", "utf8");
const outsideRead = await host.callTool("agent_read_file", { path: outsideFile }, { sessionId: "s1" });
check("沙箱外的绝对路径被拒", outsideRead.text.includes("越界"), outsideRead.text);
check("…且没把内容读出来", !outsideRead.text.includes("沙箱外的内容"), outsideRead.text);
check("…错误里说清了根在哪", outsideRead.text.includes(CWD), outsideRead.text);

const escapeRead = await host.callTool("agent_read_file", { path: "../escape.txt" }, { sessionId: "s1" });
check("`..` 逃逸被拒", escapeRead.text.includes("越界"), escapeRead.text);

/* 兄弟目录 —— **名字以沙箱根的名字开头**的那种。这条专门钉住 `pathWithin` 里
   `path.relative` 那步:少了它,`..\CWDname-sibling` 会被纯字符串前缀比较判成
   在内部(经典漏洞)。 */
const sibling = `${CWD}-sibling`;
mkdirSync(sibling, { recursive: true });
const siblingFile = path.join(sibling, "leak.txt");
writeFileSync(siblingFile, "兄弟目录的内容", "utf8");
const siblingRead = await host.callTool("agent_read_file", { path: siblingFile }, { sessionId: "s1" });
check("同前缀的兄弟目录也被拒(不是纯字符串前缀比较)", siblingRead.text.includes("越界"), siblingRead.text);
check("…兄弟目录的内容没被读出来", !siblingRead.text.includes("兄弟目录的内容"), siblingRead.text);
rmSync(sibling, { recursive: true, force: true });

const outsideWrite = await host.callTool(
  "agent_write_file",
  { path: path.join(OUTSIDE, "nope.txt"), content: "x" },
  { sessionId: "s1" },
);
check("沙箱外写也被拒", outsideWrite.text.includes("越界"), outsideWrite.text);
check("…那个文件确实没被创建", !existsSync(path.join(OUTSIDE, "nope.txt")));

// 沙箱内的写照常。
const insideWrite = await host.callTool(
  "agent_write_file",
  { path: "inside-ok.md", content: "沙箱内写" },
  { sessionId: "s1" },
);
check("沙箱内写正常", !insideWrite.text.includes("越界"), insideWrite.text);

/* ── ⚠️ `agent_bash` 的**重定向目标**也要落在沙箱里 ─────────────────────
   原先 bash 完全不查沙箱:命令里 `> 外面/x` 想写哪儿写哪儿,而文件工具是拦的 ——
   同一条通路两套判据(2026-09-24 源码审查第 4 条)。

   解析器复用 Pi 那条路的 `extractBashWriteTargets`,所以覆盖面与它一致:
   `>` / `>>` / `tee` / `dd of=` / `sed -i`。**它是防误操作,不是沙箱** ——
   `cp`/`mv` 的目标参数、`python -c "open(...).write(...)"` 这类不认。 */
const bashOutsideWrite = await host.callTool(
  "agent_bash",
  // 重定向到一个**确凿在沙箱外**的路径。
  { command: `echo hi > "${path.join(OUTSIDE, "via-bash.txt")}"` },
  { sessionId: "s1" },
);
check(
  "agent_bash 重定向到沙箱外被拒",
  bashOutsideWrite.text.includes("在允许的目录") || bashOutsideWrite.text.includes("之外"),
  bashOutsideWrite.text,
);
check("…那个文件确实没被创建", !existsSync(path.join(OUTSIDE, "via-bash.txt")));

const bashInsideWrite = await host.callTool(
  "agent_bash",
  { command: `echo hi > bash-inside.txt` },
  { sessionId: "s1" },
);
check("agent_bash 重定向到沙箱内正常", !bashInsideWrite.text.includes("之外"), bashInsideWrite.text);
check("…而且真的写出来了", existsSync(path.join(CWD, "bash-inside.txt")));

/* ── 沙箱外只读门(资料库 / 技能库,2026-10-02)────────────────────────────
   用户要远程 AI「能看我的资料库、能用本地技能」,可两者都不在项目目录里。只读工具
   沙箱外再问一次 `sandboxReadCheck`;写工具一个字没放宽。 */
{
  const LIB = mkdtempSync(path.join(tmpdir(), "mcode-lib-"));
  writeFileSync(path.join(LIB, "ok.md"), "库里的内容", "utf8");
  writeFileSync(path.join(LIB, "blocked.md"), "被屏蔽的内容", "utf8");
  readCheckImpl = (abs, kind) => {
    if (!abs.startsWith(LIB)) return undefined;
    if (abs.endsWith("blocked.md")) return "被屏蔽了(测试)";
    if (kind === "search") return "不能全文搜索(测试)";
    return null;
  };
  const libRead = await host.callTool("agent_read_file", { path: path.join(LIB, "ok.md") }, { sessionId: "s1" });
  check("只读门:库里的文件读得到", libRead.text.includes("库里的内容"), libRead.text);
  const libBatch = await host.callTool("agent_read_files", { paths: [path.join(LIB, "ok.md")] }, { sessionId: "s1" });
  check("只读门:批量读也走同一道门", libBatch.text.includes("库里的内容"), libBatch.text);
  const libBlocked = await host.callTool("agent_read_file", { path: path.join(LIB, "blocked.md") }, { sessionId: "s1" });
  check("只读门:被屏蔽的拒,原话给模型", libBlocked.text.includes("被屏蔽了(测试)"), libBlocked.text);
  check("…内容没读出来", !libBlocked.text.includes("被屏蔽的内容"), libBlocked.text);
  const libList = await host.callTool("agent_list_dir", { path: LIB }, { sessionId: "s1" });
  check("只读门:列目录可以", libList.text.includes("ok.md"), libList.text);
  const libGrep = await host.callTool("agent_grep", { pattern: "内容", path: LIB }, { sessionId: "s1" });
  check("只读门:全文搜索按 search 问,被拒", libGrep.text.includes("不能全文搜索"), libGrep.text);
  const libWrite = await host.callTool(
    "agent_write_file",
    { path: path.join(LIB, "x.md"), content: "x" },
    { sessionId: "s1" },
  );
  check("只读门:写库被拒(写工具不问只读门)", libWrite.text.includes("越界"), libWrite.text);
  check("…文件确实没被创建", !existsSync(path.join(LIB, "x.md")));
  const stillOutside = await host.callTool("agent_read_file", { path: outsideFile }, { sessionId: "s1" });
  check("只读门:不归它管的仍报越界", stillOutside.text.includes("越界"), stillOutside.text);
  readCheckImpl = () => undefined;
  rmSync(LIB, { recursive: true, force: true });
}

/* ── 公网那张表(audience=public):不给工作流、给库的只读那组 ── */
{
  const pub = host.listTools("public").map((t) => t.name);
  check("公网表:没有工作流工具", !pub.some((n) => n.startsWith("workflow_") || n === "agent_profile_save"), pub);
  check("公网表:有库的只读工具", pub.includes("library_query"), pub);
  check("公网表:库的写工具不给", !pub.includes("library_write"), pub);
  check("公网表:agent 文件工具还在", pub.includes("agent_read_file") && pub.includes("agent_skill"), pub);
  check("公网表:名字不重复", new Set(pub).size === pub.length, pub);
  check("本机表:工作流照旧在", host.listTools().map((t) => t.name).includes("workflow_list"));
  const wfPublic = await host.callTool("workflow_list", {}, { sessionId: "s1", audience: "public" });
  check("公网:调工作流工具被拒", wfPublic.isError === true && wfPublic.text.includes("没有这个工具"), wfPublic.text);
}

/* Public compact regressions: temporary projects only; no global fixture writes. */
{
  const project = mkdtempSync(path.join(tmpdir(), "mcode-public-project-"));
  const outside = mkdtempSync(path.join(tmpdir(), "mcode-public-other-"));
  const skillDir = path.join(project, ".claude", "skills", "folder-name");
  const foreign = path.join(outside, ".mcode", "skills", "foreign");
  mkdirSync(skillDir, { recursive: true }); mkdirSync(foreign, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: project-skill\ndescription: analyze tables\n---\nPROJECT_SKILL_BODY\n" + "长行".repeat(2000));
  writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: forbidden-global\n---\nSECRET_SKILL_BODY");
  writeFileSync(path.join(project, "large.txt"), "x".repeat(90000));
  const oldSandbox = sandboxValue, oldCwd = cwdValue;
  sandboxValue = project; cwdValue = outside; readCheckImpl = () => null;
  const ctx = { sessionId: "s1", audience: "public" as const };
  const invoke = (name: string, args: Record<string, unknown> = {}) => host.callTool(name, args, ctx);
  try {
    eq("compact public tool count", host.listTools("public").length, 39);
    const removed = ["agent_read_files", "agent_skill_list", "agent_skill_read", "agent_process_sessions", "library_collections", "library_search", "library_items", "library_links"];
    for (const name of removed) {
      check(`compact absent ${name}`, !host.listTools("public").some(t => t.name === name));
      check(`compact rejects legacy call ${name}`, (await invoke(name)).isError === true);
      // ★ 光"拒了"不够 —— 客户端缓存了旧 tools/list 时,得告诉他**合并成了谁**。
      //   而这句提示过去只写在 `callTool` 里,`handleCall` 在它之前就用 `-32602 unknown tool`
      //   挡掉了 → 永远到不了。现在走 `host.migrationHint`,由 endpoint 在拒绝前问一句。
      check(`★ 旧名 ${name} 能问出迁移提示`, (host.migrationHint?.(name, "public") ?? "").includes("→") || (host.migrationHint?.(name, "public") ?? "").includes("（"), host.migrationHint?.(name, "public"));
    }
    check("★ migrationHint 对现役工具名返回 undefined(不是所有名字都给提示)", host.migrationHint?.("agent_skill", "public") === undefined, host.migrationHint?.("agent_skill", "public"));
    check("desktop batch and skill tools retained", host.listTools().some(t => t.name === "agent_read_files") && host.listTools().some(t => t.name === "agent_skill_list"));
    for (const name of ["agent_skill", "library_query", "agent_read_file"]) {
      check(`compact readonly annotation ${name}`, host.listTools("public").find(t => t.name === name)?.annotations?.readOnlyHint === true);
    }
    const projectContext = await invoke("agent_context");
    check("context includes lightweight project skill index", String(JSON.stringify(projectContext.structuredContent?.project_skills)).includes("project-skill") && !projectContext.text.includes("PROJECT_SKILL_BODY"), projectContext);
    const list = await invoke("agent_skill", { query: "tables" });
    check("project skill uses bound project, not cwd", list.text.includes("project-skill") && !list.text.includes("forbidden-global"), list);
    check("skill index is metadata only", !list.text.includes("PROJECT_SKILL_BODY"), list);
    check("skill query has no false hit", !(await invoke("agent_skill", { query: "unrelated" })).text.includes("project-skill"));
    mkdirSync(path.join(project, ".claude", "skills", "other"), { recursive: true });
    writeFileSync(path.join(project, ".claude", "skills", "other", "SKILL.md"), "---\nname: second-skill\ndescription: other task\n---\nSECOND_BODY");
    const indexPage = await invoke("agent_skill", { limit: 1 });
    check("skill index is paginated", indexPage.structuredContent?.has_more === true && indexPage.structuredContent?.next_offset === 1 && indexPage.structuredContent?.total === 2, indexPage);
    const indexPage2 = await invoke("agent_skill", { offset: 1, limit: 1 });
    check("skill index continuation is distinct", indexPage2.text.includes("second-skill") && indexPage2.structuredContent?.has_more === false, indexPage2);
    const read = await invoke("agent_skill", { action: "read", name: "project-skill", page: { max_chars: 1000 } });
    check("skill read preserves lossless pagination", read.structuredContent?.has_more === true && typeof read.structuredContent?.sha256 === "string", read);
    const continuation = await invoke("agent_skill", { action: "read", name: "project-skill", page: { offset: read.structuredContent?.next_offset ?? 1, column_offset: read.structuredContent?.next_column_offset ?? 0, expected_sha256: read.structuredContent?.sha256 ?? "0".repeat(64) } });
    check("skill continuation succeeds", !continuation.isError, continuation);
    check("skill never falls back global", (await invoke("agent_skill", { action: "read", name: "forbidden-global" })).isError === true);
    check("skill read requires name", (await invoke("agent_skill", { action: "read" })).isError === true);
    const batch = await invoke("agent_read_file", { paths: ["large.txt", "missing.txt"], max_chars: 1000 });
    const files = batch.structuredContent?.files as Array<Record<string, unknown>> | undefined;
    check("batch preserves successful metadata and partial error", files?.length === 2 && files[0]?.has_more === true && files[1]?.isError === true && !batch.isError, batch);
    const budget = await invoke("agent_read_file", { paths: ["large.txt", "large.txt", "large.txt", "large.txt"], max_chars: 60000 });
    check("batch bounded with explicit pending requests", (budget.structuredContent?.pending_files as unknown[])?.length === 2, budget);
    check("read rejects ambiguous path and paths", (await invoke("agent_read_file", { path: "large.txt", paths: ["large.txt"] })).isError === true);
    const version = await invoke("agent_read_file", { paths: [{ path: "large.txt", expected_sha256: "0".repeat(64) }] });
    check("batch enforces per-file expected hash", (version.structuredContent?.files as Array<Record<string, unknown>>)?.[0]?.isError === true, version);
    const priorCalls = __handlerCalls.length;
    for (const [action, params] of Object.entries({ collections: {}, search: { query: "fixture" }, items: { collectionId: "c1" }, links: { itemId: "i1" } })) {
      const out = await invoke("library_query", { action, ...params });
      check(`library dispatch ${action}`, !out.isError && out.text.includes(`"action":"${action}"`), out);
    }
    eq("four readonly library handlers dispatched", __handlerCalls.length - priorCalls, 4);
    const beforeInvalid = __handlerCalls.length;
    check("library missing argument rejected", (await invoke("library_query", { action: "items" })).isError === true);
    check("library irrelevant argument rejected", (await invoke("library_query", { action: "collections", itemId: "i1" })).isError === true);
    check("library mutation action rejected", (await invoke("library_query", { action: "remove", itemId: "i1" })).isError === true);
    eq("invalid library input has no handler effects", __handlerCalls.length, beforeInvalid);
    check("public missing-id process read still lists own sessions", !(await invoke("agent_process_read")).isError);
    const forbiddenFile = path.join(foreign, "SKILL.md");
    check("generic read cannot use library allowlist for global skills", (await invoke("agent_read_file", { path: forbiddenFile })).isError === true);
    check("desktop generic read unchanged", !(await host.callTool("agent_read_file", { path: forbiddenFile }, { sessionId: "s1" })).isError);
    symlinkSync(path.join(outside, ".mcode", "skills"), path.join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(skillDir, path.join(project, "safe-alias"), process.platform === "win32" ? "junction" : "dir");
    check("in-project symlink is still readable", !(await invoke("agent_read_file", { path: "safe-alias/SKILL.md" })).isError);
    symlinkSync(foreign, path.join(project, ".claude", "skills", "alias"), process.platform === "win32" ? "junction" : "dir");
    check("skill scan filters external symlink before reading metadata", !(await invoke("agent_skill")).text.includes("forbidden-global"));
    check("edit cannot read or mutate through global alias", (await invoke("agent_edit_file", { path: "escape/foreign/SKILL.md", old_string: "SECRET_SKILL_BODY", new_string: "changed" })).isError === true);
    check("create cannot write through global alias parent", (await invoke("agent_write_file", { path: "escape/foreign/new.txt", content: "must not write" })).isError === true && !existsSync(path.join(foreign, "new.txt")));
    check("direct alias read denied", (await invoke("agent_read_file", { path: "escape/foreign/SKILL.md" })).isError === true);
    for (const [name, args] of [
      ["agent_list_dir", { path: ".", depth: 4 }],
      ["agent_glob", { path: ".", pattern: "**/*", include_hidden: true }],
      ["agent_grep", { path: ".", pattern: "SECRET_SKILL_BODY", include_hidden: true }],
      ["agent_search_start", { path: ".", pattern: "SECRET_SKILL_BODY", search_type: "content", include_hidden: true, wait_ms: 1000 }],
    ] as const) {
      const out = await invoke(name, args);
      check(`recursive public guard ${name}`, !out.isError && (name === "agent_grep" ? out.structuredContent?.count === 0 : !out.text.includes("SECRET_SKILL_BODY")) && !out.text.includes("escape") && !out.text.includes("forbidden-global"), out);
    }
    const backgroundFiles = await invoke("agent_search_start", { path: ".", pattern: "escape", search_type: "files", include_hidden: true, wait_ms: 1000 });
    check("background file walk skips external aliases", backgroundFiles.text.includes("total_results: 0"), backgroundFiles);
    sandboxValue = null;
    check("unbound public skill refuses cwd fallback", (await invoke("agent_skill")).isError === true);
  } finally {
    sandboxValue = oldSandbox; cwdValue = oldCwd; readCheckImpl = () => undefined;
    // Remove junctions before temporary roots; never recursively follow a junction.
    rmSync(path.join(project, "safe-alias"), { force: true, recursive: true });
    rmSync(path.join(project, "escape"), { force: true, recursive: true });
    rmSync(path.join(project, ".claude", "skills", "alias"), { force: true, recursive: true });
    rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
}

// 关掉沙箱(null)= 不限制 —— 这条防的是"顺手给所有会话都套上沙箱",那会改掉
// 本机 claude 引擎那条路一直在用的行为。
sandboxValue = null;
const unrestricted = await host.callTool("agent_read_file", { path: outsideFile }, { sessionId: "s1" });
check("沙箱为 null 时不限制(本机那条路行为不变)", unrestricted.text.includes("沙箱外的内容"), unrestricted.text);
rmSync(OUTSIDE, { recursive: true, force: true });

const readBack = await host.callTool("agent_read_file", { path: "note.md" }, { sessionId: "s1" });
check(
  "…agent_read_file 按行号读回来",
  readBack.text.includes("1\t第一行:桥冒烟") && readBack.text.includes("2\t第二行:替换前"),
  readBack.text,
);

const wroteSecond = await host.callTool(
  "agent_write_file",
  { path: "second.txt", content: "第二个文件\n批量读取命中\n" },
  { sessionId: "s1" },
);
check("批量读的第二个文件先写成功", wroteSecond.text.includes("second.txt"), wroteSecond.text);
const batchRead = await host.callTool(
  "agent_read_files",
  { paths: ["note.md", "second.txt", "missing.txt"], limit_per_file: 20 },
  { sessionId: "s1" },
);
check(
  "agent_read_files 一次带回多个文件且单个缺失不拖垮整批",
  batchRead.text.includes("第一行:桥冒烟") &&
    batchRead.text.includes("批量读取命中") &&
    batchRead.text.includes("missing.txt") &&
    batchRead.text.includes("失败:"),
  batchRead.text,
);

// >2MB 不再整文件拒绝；offset/limit 走流式读取，适合日志。
writeFileSync(path.join(CWD, "huge.log"), "stream-line\n".repeat(190_000), "utf8");
const hugeRead = await host.callTool(
  "agent_read_file",
  { path: "huge.log", offset: 189_995, limit: 3 },
  { sessionId: "s1" },
);
check(
  "agent_read_file 对大文件按范围流式读而不是报太大",
  hugeRead.text.includes("189995\tstream-line") && hugeRead.text.includes("大文件流式读取"),
  hugeRead.text.slice(0, 600),
);


const info = await host.callTool("agent_file_info", { path: "note.md" }, { sessionId: "s1" });
check(
  "agent_file_info 返回文件元数据和文本行数",
  info.text.includes("type: file") && info.text.includes("line_count:") && info.text.includes("modified_at:"),
  info.text,
);

approvalCalls.length = 0;
const moved = await host.callTool(
  "agent_move_file",
  { source: "second.txt", destination: "moved/second-renamed.txt" },
  { sessionId: "s1" },
);
eq("acceptEdits 下 agent_move_file 不弹审批", approvalCalls.length, 0);
check("agent_move_file 真正移动了文件", moved.text.includes("second-renamed.txt"), moved.text);
const movedRead = await host.callTool(
  "agent_read_file",
  { path: "moved/second-renamed.txt", limit: 20 },
  { sessionId: "s1" },
);
check("移动后的路径可直接读取", movedRead.text.includes("批量读取命中"), movedRead.text);

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

await host.callTool(
  "agent_write_file",
  { path: "nested/level/two.md", content: "tree" },
  { sessionId: "s1" },
);
const tree = await host.callTool(
  "agent_list_dir",
  { depth: 3, max_entries: 50 },
  { sessionId: "s1" },
);
check(
  "agent_list_dir depth>1 一次看到多层项目结构",
  tree.text.includes("nested/") && tree.text.includes("nested/level/") && tree.text.includes("nested/level/two.md"),
  tree.text,
);


await host.callTool(
  "agent_write_file",
  { path: "nested/level/search-target.txt", content: "before-context\nneedle-alpha\nafter-context\n" },
  { sessionId: "s1" },
);
const contentSearch = await host.callTool(
  "agent_search_start",
  {
    search_type: "content",
    pattern: "needle-alpha",
    literal: true,
    context_lines: 1,
    wait_ms: 1000,
    max_results: 20,
  },
  { sessionId: "s1" },
);
const searchId = /search_id:\s*(search_[a-z0-9]+)/i.exec(contentSearch.text)?.[1] ?? "";
check("agent_search_start 返回 opaque search_id", searchId.startsWith("search_"), contentSearch.text);
check(
  "后台内容搜索首批结果包含命中和上下文",
  contentSearch.text.includes("needle-alpha") && contentSearch.text.includes("before-context") && contentSearch.text.includes("after-context"),
  contentSearch.text,
);
const searchList = await host.callTool("agent_search_list", {}, { sessionId: "s1" });
check("agent_search_list 列出当前对话搜索", searchList.text.includes(searchId), searchList.text);
const searchRead = await host.callTool(
  "agent_search_read",
  { search_id: searchId, offset: 0, length: 20 },
  { sessionId: "s1" },
);
check("agent_search_read 可分页重读已有结果", searchRead.text.includes("needle-alpha"), searchRead.text);
const foreignSearchStop = await host.callTool(
  "agent_search_stop",
  { search_id: searchId },
  { sessionId: "another-session" },
);
check("搜索会话绑定发起对话，别的会话不能停", foreignSearchStop.text.includes("不属于当前对话"), foreignSearchStop.text);

const fileSearch = await host.callTool(
  "agent_search_start",
  { search_type: "files", pattern: "two.md", literal: true, wait_ms: 1000, max_results: 20 },
  { sessionId: "s1" },
);
check("后台文件名搜索也能找到多层文件", fileSearch.text.includes("nested/level/two.md"), fileSearch.text);

const globbed = await host.callTool("agent_glob", { pattern: "**/*.md" }, { sessionId: "s1" });
check("agent_glob 按模式找到了它", globbed.text.includes("note.md"), globbed.text);

const grepped = await host.callTool("agent_grep", { pattern: "桥冒烟" }, { sessionId: "s1" });
check("agent_grep 按内容找到了行", grepped.text.includes("note.md:1:"), grepped.text);

/* 大目录不能把 glob/grep 的名额吃光:先放 900 个噪声文件(比旧的 800 上限多),
 * 目标文件放在后面那个目录里 —— 旧实现先收前 800 个文件再过滤,就会回"没有匹配"。 */
{
  const noise = path.join(CWD, "aaa-noise");
  mkdirSync(noise, { recursive: true });
  for (let i = 0; i < 900; i += 1) writeFileSync(path.join(noise, `n${i}.txt`), "noise\n");
  mkdirSync(path.join(CWD, "zzz", "deep"), { recursive: true });
  writeFileSync(path.join(CWD, "zzz", "deep", "target-file.ts"), "const needle = call(1);\n");
  writeFileSync(path.join(CWD, ".hidden-file.ts"), "const needle = 2;\n");
  const g1 = await host.callTool("agent_glob", { pattern: "**/target-file.ts" }, { sessionId: "s1" });
  check("glob:大目录后面的文件也找得到", g1.text.includes("zzz/deep/target-file.ts"), g1.text);
  const g2 = await host.callTool("agent_glob", { pattern: "zzz/deep/*.ts" }, { sessionId: "s1" });
  check("glob:带目录前缀的模式能用,路径相对工作目录", g2.text.includes("zzz/deep/target-file.ts"), g2.text);
  const g3 = await host.callTool("agent_glob", { pattern: "*.ts" }, { sessionId: "s1" });
  check("glob:隐藏文件默认不列", !g3.text.includes(".hidden-file.ts"), g3.text);
  if (g3.text.includes("没有匹配")) check("glob:没匹配时提示用 **/ 递归", g3.text.includes("**/*.ts"), g3.text);
  const g4 = await host.callTool("agent_glob", { pattern: ".hidden-*.ts" }, { sessionId: "s1" });
  check("glob:模式里写了 . 段就包含隐藏项", g4.text.includes(".hidden-file.ts"), g4.text);
  const r1 = await host.callTool("agent_grep", { pattern: "call(1)", literal: true }, { sessionId: "s1" });
  check("grep:大目录后面的文件也搜得到 + literal", r1.text.includes("zzz/deep/target-file.ts:1:"), r1.text);
  const r2 = await host.callTool("agent_grep", { pattern: "call(" }, { sessionId: "s1" });
  check("grep:非法正则自动按原文搜", !r2.isError && r2.text.includes("target-file.ts:1:") && r2.text.includes("按原文"), r2.text);
  const r3 = await host.callTool("agent_grep", { pattern: "needle", path: "zzz" }, { sessionId: "s1" });
  check("grep:path 指向子目录时路径仍相对工作目录", r3.text.includes("zzz/deep/target-file.ts:1:"), r3.text);
  rmSync(noise, { recursive: true, force: true });
}

/* edit:失败是 isError;多处一次改;CRLF 文件用 LF 原文也能对上。 */
{
  writeFileSync(path.join(CWD, "crlf.txt"), "one\r\ntwo\r\nthree\r\ntwo\r\n");
  const miss = await host.callTool("agent_edit_file", { path: "crlf.txt", old_string: "nope", new_string: "x" }, { sessionId: "s1" });
  check("edit:没找到 → isError", miss.isError === true, miss.text);
  const dup = await host.callTool("agent_edit_file", { path: "crlf.txt", old_string: "two", new_string: "2" }, { sessionId: "s1" });
  check("edit:出现多次 → isError 并报次数", dup.isError === true && dup.text.includes("2 次"), dup.text);
  const crlfEdit = await host.callTool(
    "agent_edit_file",
    { path: "crlf.txt", old_string: "one\ntwo\nthree", new_string: "ONE\nTWO\nTHREE" },
    { sessionId: "s1" },
  );
  check("edit:CRLF 文件用 LF 原文也能改", !crlfEdit.isError && crlfEdit.text.includes("第 1 行"), crlfEdit.text);
  const multi = await host.callTool(
    "agent_edit_file",
    { path: "crlf.txt", edits: [{ old_string: "ONE", new_string: "1" }, { old_string: "THREE", new_string: "3" }] },
    { sessionId: "s1" },
  );
  check("edit:edits 一次改多处", !multi.isError && multi.text.includes("替换 2 处"), multi.text);
  const atomic = await host.callTool(
    "agent_edit_file",
    { path: "crlf.txt", edits: [{ old_string: "1", new_string: "uno" }, { old_string: "missing", new_string: "x" }] },
    { sessionId: "s1" },
  );
  check("edit:edits 有一处对不上就整次不写", atomic.isError === true && atomic.text.includes("第 2 处"), atomic.text);
  const after = await host.callTool("agent_read_file", { path: "crlf.txt" }, { sessionId: "s1" });
  check("…文件保持上一次成功后的样子", after.text.includes("1\t1") && after.text.includes("3\t3") && !after.text.includes("uno"), after.text);
}

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

/* 持久进程:启动一次，后续 stdin/stdout 连续使用；读/停不重复审批。 */
approvalCalls.length = 0;

approvalCalls.length = 0;
const systemProcesses = await host.callTool(
  "agent_list_processes",
  { filter: String(process.pid), limit: 20 },
  { sessionId: "s1" },
);
check("agent_list_processes 能看到当前 smoke 的真实 OS PID", systemProcesses.text.includes(String(process.pid)), systemProcesses.text);
eq("列系统进程是只读，不弹审批", approvalCalls.length, 0);

const killProbe = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),30000)"], {
  windowsHide: true,
  stdio: "ignore",
});
if (!killProbe.pid) throw new Error("kill probe 没拿到 pid");
approvalCalls.length = 0;
const killed = await host.callTool(
  "agent_kill_process",
  { pid: killProbe.pid, force: true },
  { sessionId: "s1" },
);
eq("agent_kill_process 即使在 acceptEdits 也必须审批", approvalCalls.length, 1);
check("审批后能终止指定真实 OS PID", !killed.isError, killed.text);
approvalCalls.length = 0;

const processStarted = await host.callTool(
  "agent_process_start",
  {
    command:
      `node -e "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>console.log('persistent-smoke:'+d.trim()));console.log('process-ready')"`,
    wait_ms: 500,
    timeout_ms: 15_000,
  },
  { sessionId: "s1" },
);
eq("agent_process_start 作为可执行动作要审批", approvalCalls.length, 1);
const processId = /process_id:\s*(proc_[a-z0-9]+)/i.exec(processStarted.text)?.[1] ?? "";
check("持久进程启动返回 opaque process_id", processId.startsWith("proc_"), processStarted.text);

approvalCalls.length = 0;
const processWritten = await host.callTool(
  "agent_process_write",
  { process_id: processId, input: "2468", wait_ms: 1200 },
  { sessionId: "s1" },
);
eq("agent_process_write 仍按可执行动作审批", approvalCalls.length, 1);
check("写 stdin 后同一次调用就拿到新输出", processWritten.text.includes("persistent-smoke:2468"), processWritten.text);

approvalCalls.length = 0;
const processList = await host.callTool("agent_process_read", {}, { sessionId: "s1" });
check("agent_process_read 省略 id 可列当前对话进程", processList.text.includes(processId), processList.text);
eq("列/读持久进程不重复审批", approvalCalls.length, 0);
const processRead = await host.callTool(
  "agent_process_read",
  { process_id: processId, cursor: 0, max_chars: 20_000 },
  { sessionId: "s1" },
);
check("持久进程可按 cursor 重读已有输出", processRead.text.includes("persistent-smoke:2468"), processRead.text);

/* ── 结构化输出 + 阻塞读 ──────────────────────────────────────────────
   两条都对着用户报的问题:
   ① 返回值带 structuredContent,模型不必从文本里正则抠 next_cursor;
   ② read 默认**阻塞等到有输出**,而不是 5 秒一到回空、逼模型空轮询。 */
eq(
  "进程工具在 tools/list 里带 outputSchema",
  typeof host.listTools().find((t) => t.name === "agent_process_read")?.outputSchema,
  "object",
);

/* ── **每个**工具都要有 outputSchema，且每个 schema 都得有 text ──────────────
   用户反复报"很多工具还是不满足这个需求"(ChatGPT 对**每个**工具都提示
   「建议添加 outputSchema」)。所以这条断言是**全表**的,不是挑几个:

   ① 表里**一个都不能少** —— 少一个,那个工具在 ChatGPT 里就还挂着那条提示;
   ② 每个 schema 的 `required` 里必须有 `text` —— `callTool` 总是把文本投影塞进
      `structuredContent.text`,schema 不认这个字段的话,严格客户端会判失败
      (见 `mcp-outputschema-must-pair-structuredcontent` 那条记忆)。 */
const allTools = host.listTools();
const missingSchema = allTools.filter((t) => typeof t.outputSchema !== "object").map((t) => t.name);
eq("**每个**工具都有 outputSchema(一个都不能少)", missingSchema, []);
const schemasWithoutText = allTools
  .filter((t) => {
    const req = (t.outputSchema as { required?: unknown[] } | undefined)?.required;
    return !Array.isArray(req) || !req.includes("text");
  })
  .map((t) => t.name);
eq("每个 outputSchema 的 required 里都有 text", schemasWithoutText, []);

// ★ **声明了 outputSchema,就不能让"分支返回"被它判成失败。** 同一个工具的
//   不同分支返回**不同形状**:`agent_process_read` 省略 `process_id` 时是"列进程"
//   (只回 text),`agent_skill` 的 list 分支多给 `has_more`/`next_offset`。若 schema 把
//   声明字段全钉进 `required`、又置 `additionalProperties:false`(zodToJsonSchema 的默认),
//   这两支都会被严格客户端判成调用失败 —— 而那恰恰是它是**成功**返回。
//   所以判据:每个 outputSchema 的 `required` **只有 text**、且 `additionalProperties` 不为
//   false。真返回里的字段仍由 properties 描述(模型据此读),只是不钉死"这一支必须有"。
const badRequired = allTools
  .filter((t) => {
    const req = (t.outputSchema as { required?: unknown[] }).required;
    return !Array.isArray(req) || req.length !== 1 || req[0] !== "text";
  })
  .map((t) => t.name);
eq("★ 每个 outputSchema 的 required 只有 text(不钉死分支专属字段)", badRequired, []);
const closedSchemas = allTools
  .filter((t) => (t.outputSchema as { additionalProperties?: unknown }).additionalProperties === false)
  .map((t) => t.name);
eq("★ 每个 outputSchema 都不关闭 additionalProperties(不然多返回的字段被判失败)", closedSchemas, []);

const processOutputSchema = host.listTools().find((t) => t.name === "agent_process_read")?.outputSchema;
check(
  "…outputSchema 描述了 next_cursor / has_more",
  JSON.stringify(processOutputSchema ?? "").includes("next_cursor") &&
    JSON.stringify(processOutputSchema ?? "").includes("has_more"),
  processOutputSchema,
);
const structuredRead = await host.callTool(
  "agent_process_read",
  { process_id: processId, cursor: 0 },
  { sessionId: "s1" },
);
check(
  "tools/call 的结果带 structuredContent",
  typeof structuredRead.structuredContent === "object" && structuredRead.structuredContent !== null,
  structuredRead.structuredContent,
);
eq("…里面的 process_id 对得上", structuredRead.structuredContent?.process_id, processId);
check("…output 就在字段里,不用解析文本", typeof structuredRead.structuredContent?.output === "string", structuredRead.structuredContent);

/* ── 阻塞读:进程先沉默 2 秒,再一次调用就该等到那批输出。
   改前 MAX_PROCESS_WAIT_MS=5000 + 默认 wait_ms=0 会让这次立刻回空 —— 这正是
   "断断续续汇报"的机制本身。这条断言就是钉住那个行为的。 */
const sleepy = await host.callTool(
  "agent_process_start",
  {
    command: `node -e "setTimeout(()=>{console.log('late-output');},2000)"`,
    wait_ms: 0,
    timeout_ms: 15_000,
  },
  { sessionId: "s1" },
);
const sleepyId = /process_id:\s*(proc_[a-z0-9]+)/i.exec(sleepy.text)?.[1] ?? "";
check("沉默进程已启动", sleepyId.startsWith("proc_"), sleepy.text);
const startedAt = Date.now();
const blockedRead = await host.callTool(
  "agent_process_read",
  // 不传 wait_ms —— 验的就是**默认值**会阻塞(旧默认 0 会立刻回空)。
  { process_id: sleepyId, cursor: 0 },
  { sessionId: "s1" },
);
const waited = Date.now() - startedAt;
check(
  "读默认阻塞,一次调用等到 2 秒后才出现的输出",
  blockedRead.text.includes("late-output"),
  blockedRead.text,
);
check("…确实等了(不是立刻返回)", waited >= 1500, waited);
check(
  "…而且进程结束时 status 不再是 running",
  blockedRead.structuredContent?.status === "exited",
  blockedRead.structuredContent,
);

/* ── ⚠️ **有输出就快点回,别等满 55 秒** ─────────────────────────────
   用户报的:"长任务吐了一小段重要日志,却要等好久才交给模型"。

   原先的判据是"攒满 maxChars(2 万字符)才回"—— 于是"跑一个长任务、它每隔一会吐一行
   进度"这种最常见的形状,每次都要等满 55 秒,而模型明明已经能读了。

   这里起一个**吐 2 行、然后一直活着**的进程(短进程会因为"进程结束"而立刻返回,验不出
   这条),读一次:应当在**很短**时间内就拿到那两行,而不是等满默认的 55 秒。 */
const chatty = await host.callTool(
  "agent_process_start",
  {
    command: `node -e "console.log('progress-1');setTimeout(()=>console.log('progress-2'),400);setInterval(()=>{},1000)"`,
    wait_ms: 0,
    timeout_ms: 20_000,
  },
  { sessionId: "s1" },
);
const chattyId = /process_id:\s*(proc_[a-z0-9]+)/i.exec(chatty.text)?.[1] ?? "";
check("长任务进程起来了", chattyId.startsWith("proc_"), chatty.text);
const chattyStartedAt = Date.now();
const chattyRead = await host.callTool(
  "agent_process_read",
  // 不传 wait_ms —— 验的就是默认行为:有输出时**不该**占满 55 秒。
  { process_id: chattyId, cursor: 0 },
  { sessionId: "s1" },
);
const chattyWaited = Date.now() - chattyStartedAt;
check(
  "**有输出可读时不占满 waitMs**(不再等满 55 秒才交给模型)",
  chattyWaited < 10_000,
  { waited: chattyWaited },
);
check("…而且确实拿到了那两行", chattyRead.text.includes("progress-1"), chattyRead.text);
await host.callTool("agent_process_stop", { process_id: chattyId }, { sessionId: "s1" });

/* ── 上限本身被抬高了:沉默 **6 秒**(长于旧的 5 秒上限),显式传 wait_ms=55000
   应该照样等到。若上限还是 5000,这次会被截断、回"(暂无新输出)"。
   为什么必须有这条:上一条用的是"沉默 2 秒",5 秒上限也够等到它 —— 所以那条**钉不住
   上限的值**,只钉住了"默认会阻塞"(变异验证 M1 因此不红,这是变异不等价,不是断言弱)。
   这一条才真正对着"从 5 秒抬到 55 秒"那处改动。 */
const slow = await host.callTool(
  "agent_process_start",
  { command: `node -e "setTimeout(()=>{console.log('slow-output');},6000)"`, wait_ms: 0, timeout_ms: 20_000 },
  { sessionId: "s1" },
);
const slowId = /process_id:\s*(proc_[a-z0-9]+)/i.exec(slow.text)?.[1] ?? "";
const slowRead = await host.callTool(
  "agent_process_read",
  { process_id: slowId, cursor: 0, wait_ms: 55_000 },
  { sessionId: "s1" },
);
check(
  "等待上限被抬高:显式 wait_ms=55000 能等到 6 秒后的输出",
  slowRead.text.includes("slow-output"),
  slowRead.text,
);
await host.callTool("agent_process_stop", { process_id: slowId }, { sessionId: "s1" });
// 收掉它:虽然它自己跑完了,但 Windows 下残留的句柄会锁住 CWD,让后面的 rmSync 报 EBUSY。
await host.callTool("agent_process_stop", { process_id: sleepyId }, { sessionId: "s1" });
// 上面这次 start 是"可执行动作"、**吃了一枚审批**;后面的断言在数 approvalCalls,
// 不重置的话会把我的临时进程算到它们头上。
approvalCalls.length = 0;


const managedSessions = await host.callTool("agent_process_sessions", {}, { sessionId: "s1" });
check("agent_process_sessions 显式列出持久进程会话", managedSessions.text.includes(processId), managedSessions.text);

const foreignStop = await host.callTool(
  "agent_process_stop",
  { process_id: processId },
  { sessionId: "another-session" },
);
check(
  "持久进程 id 绑定发起对话,别的会话不能读/停",
  foreignStop.text.includes("不属于当前对话"),
  foreignStop.text,
);
const stillRunning = await host.callTool(
  "agent_process_read",
  { process_id: processId, cursor: 0 },
  { sessionId: "s1" },
);
check("跨会话 stop 被拒后原进程仍在", stillRunning.text.includes("status: running"), stillRunning.text);

const processStopped = await host.callTool(
  "agent_process_stop",
  { process_id: processId, cursor: 0 },
  { sessionId: "s1" },
);
eq("停止自己创建的进程属于安全清理,不审批", approvalCalls.length, 0);
check(
  "agent_process_stop 最终不再是 running",
  !processStopped.text.includes("status: running"),
  processStopped.text,
);

approvalCalls.length = 0;
const sshStatus = await host.callTool("agent_ssh_status", {}, { sessionId: "s1" });
eq("agent_ssh_status 是只读工具，不弹审批", approvalCalls.length, 0);
check("没有连接时 status 给出可理解结果", sshStatus.text.includes("没有 SSH 连接"), sshStatus.text);

approvalCalls.length = 0;
allowDecision = false;
const remoteStartDenied = await host.callTool(
  "agent_remote_job_start",
  { connection_id: "ssh_missing", command: "echo 不该跑", job_id: "smoke-job" },
  { sessionId: "s1" },
);
eq("远程 job 启动属于有副作用动作，要审批", approvalCalls.length, 1);
eq("拒绝远程 job 启动后不执行 handler", remoteStartDenied.isError, true);
check("远程 job 拒绝沿用统一审批理由", remoteStartDenied.text.includes("我现在不想动库里东西"), remoteStartDenied.text);

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
/* Approval cancellation: an interrupt/timeout invalidates stale clicks but keeps session grants. */
const approvalLifecycle = new ApprovalBridge();
approvalLifecycle.setPermissionMode("approval-owner", "acceptEdits");
const granted = approvalLifecycle.makeApprovalHandler("approval-owner", () => {})({
  requestId: "prior-always-grant",
  toolName: "agent_bash",
  input: { command: "safe fixture" },
  description: "fixture",
});
eq("初次始终允许 resolve 到所属会话", approvalLifecycle.resolveApproval("prior-always-grant", { allow: true }, true), "approval-owner");
await granted;
const staleApproval = approvalLifecycle.makeApprovalHandler("approval-owner", () => {})({
  requestId: "late-after-interrupt",
  toolName: "agent_bash",
  input: { command: "must not run" },
  description: "fixture",
});
const staleOutcome = staleApproval.then(() => "allowed", (err: Error) => err.message);
const otherSessionApproval = approvalLifecycle.makeApprovalHandler("another-owner", () => {})({
  requestId: "other-session-pending",
  toolName: "agent_bash",
  input: {},
  description: "fixture",
});
const otherOutcome = otherSessionApproval.then(() => "allowed", (err: Error) => err.message);
eq(
  "取消只返回所属会话的待处理请求",
  approvalLifecycle.rejectPending("approval-owner"),
  [{ requestId: "late-after-interrupt", kind: "approval" }],
);
eq("中断后的迟到批准已失效", approvalLifecycle.resolveApproval("late-after-interrupt", { allow: true }, true), null);
eq("被取消的审批 promise 已拒绝", await staleOutcome, "Session cancelled");
eq("取消保留此前的始终允许", approvalLifecycle.isAlwaysAllowed("approval-owner", "agent_bash"), true);
eq("取消保留会话权限模式", approvalLifecycle.getPermissionMode("approval-owner"), "acceptEdits");
eq("其他会话的待处理审批不受影响", approvalLifecycle.resolveApproval("other-session-pending", { allow: true }), "another-owner");
eq("其他会话审批仍可正常完成", await otherOutcome, "allowed");
approvalLifecycle.setPermissionMode("approval-owner", "read-only");
eq("★ 切到只读即撤销原会话的始终允许", approvalLifecycle.isAlwaysAllowed("approval-owner", "agent_bash"), false);
eq("切权限不影响别的会话", approvalLifecycle.getPermissionMode("another-owner"), undefined);

configureMcpToolHost(null);

console.log(`\n${passed}/${checks} 通过`);
if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
