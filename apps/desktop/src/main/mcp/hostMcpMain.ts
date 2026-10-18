/**
 * **`mcode-host-mcp` 的可执行入口** —— ARC-006 桥 2 的 stdio MCP server 本体。
 *
 * ## 形态(与 `genoffice mcp` 同一种)
 *
 * 引擎(Node-RED)作为标准 MCP 客户端拉起的子进程:
 *
 *   <electron|node> hostMcpMain.js     (Electron 下带 ELECTRON_RUN_AS_NODE=1)
 *
 * 它只做协议面(`hostMcpStdio.ts`):stdin 上读换行分隔的 JSON-RPC,stdout 上写回应。
 * 工具表与执行**不在这里** —— `appMcpTools()` / `invokeAppTool` 的 import 图带 electron
 * 与 sql.js,Node 语义的子进程装不下。所以本入口把 `listTools` / `callTool` 中继给
 * 主进程起的**回环 HTTP 端点**(`hostMcpRelayServer.ts`)。
 *
 * ## 中继的形状(宿主 → 子进程,全部经环境变量)
 *
 *   MCODE_HOST_MCP_RELAY_URL    宿主回环地址,如 `http://127.0.0.1:54321`(只收回环名)
 *   MCODE_HOST_MCP_RELAY_TOKEN  一次性令牌;随会话生成,进程/服务器一关即作废
 *
 * 线协议(POST <url>/rpc,Authorization: Bearer <token>):
 *   { op: "list" }                          → { ok: true, tools }
 *   { op: "call", name, args }              → { ok: true, result: ToolResult }
 *   任何失败                                → { ok: false, error }(HTTP 4xx/5xx)
 *
 * 缺环境变量 / 地址不是回环 → **拒绝启动**(exit 2,stderr 说明原因):没有宿主就没有
 * 工具表,静默起来一个空 server 只会让客户端以为"连上了但没有工具"。
 *
 * ## 审批
 *
 * 审批决策全在宿主一侧(核心 `createHostMcpServer` 在调用执行器前完成分档与审批);
 * 本进程没有 UI,也不解析任何"已批准"字段 —— 危险档在宿主没有审批端口时,经这条中继
 * 回来的就是 `approval_unavailable` 的 ToolResult,原样交给客户端。
 *
 * ## 日志
 *
 * 一律 stderr。stdout 只允许 JSON 帧 —— 写脏一个字节,整条 stdio 协议就废了。
 */
import { pathToFileURL } from "node:url";
import { runHostMcpStdio, type HostMcpRemote } from "./hostMcpStdio.js";
import type { HostMcpRelayReply, HostMcpRelayRequest } from "./hostMcpRelayServer.js";
import type { HostMcpToolDescriptor } from "./hostMcpServer.js";
import type { ToolResult } from "./sdk.js";

/** 环境变量名 —— 与 `hostMcpRelayServer.ts` 文件头写明的宿主契约是同一对。 */
export const RELAY_URL_ENV = "MCODE_HOST_MCP_RELAY_URL";
export const RELAY_TOKEN_ENV = "MCODE_HOST_MCP_RELAY_TOKEN";

/** 一次中继请求的等待上限。工具里有长时间运行的(进程读取等),给足;但别无限等一个死掉的主进程。 */
const RELAY_TIMEOUT_MS = 10 * 60_000;

function stderr(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    // stderr 断了也不能反过来崩。
  }
}

/** 只允许回环目标 —— 令牌是给本机宿主的,不该被一个拼错的环境变量带去外网。 */
function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * 回环中继端口 —— `HostMcpRemote` 的实现:把一次列表/调用 POST 给宿主。
 *
 * 失败(网络、鉴权、宿主 500)**抛错**;传输层把它变成 JSON-RPC `-32603`,不吞。
 * 工具**业务**失败不是这里的失败:它是 `{ ok: true, result: { isError: true, … } }`。
 */
export function createRelayRemote(relayUrl: string, token: string): HostMcpRemote {
  const endpoint = new URL("/rpc", relayUrl).toString();
  const post = async (body: HostMcpRelayRequest): Promise<HostMcpRelayReply> => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`中继回应不是 JSON(HTTP ${res.status})`);
    }
    const reply = parsed as HostMcpRelayReply;
    if (reply === null || typeof reply !== "object" || typeof (reply as { ok?: unknown }).ok !== "boolean") {
      throw new Error(`中继回应形状不对(HTTP ${res.status})`);
    }
    if (!reply.ok) throw new Error(`中继拒绝了请求(HTTP ${res.status}):${reply.error}`);
    return reply;
  };

  return {
    async listTools(): Promise<HostMcpToolDescriptor[]> {
      const reply = await post({ op: "list" });
      if (!("tools" in reply)) throw new Error("中继的 list 回应没有 tools");
      return reply.tools;
    },
    async callTool(name: string, args: unknown): Promise<ToolResult> {
      const reply = await post({ op: "call", name, args });
      if (!("result" in reply)) throw new Error("中继的 call 回应没有 result");
      return reply.result;
    },
  };
}

/** 入口主体:读环境 → 建中继端口 → 跑 stdio。返回进程应使用的退出码。 */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  streams: Parameters<typeof runHostMcpStdio>[1] = {},
): Promise<number> {
  const relayUrl = env[RELAY_URL_ENV]?.trim() ?? "";
  const token = env[RELAY_TOKEN_ENV]?.trim() ?? "";
  if (!relayUrl || !token) {
    stderr(
      `[mcode-host-mcp] 缺少 ${RELAY_URL_ENV} / ${RELAY_TOKEN_ENV} —— ` +
        `本进程只做 stdio 协议面,工具表与执行在主进程;由宿主装配(main/index.ts)注入这对环境变量。`,
    );
    return 2;
  }
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    stderr(`[mcode-host-mcp] ${RELAY_URL_ENV} 不是合法 URL:${relayUrl}`);
    return 2;
  }
  if (parsed.protocol !== "http:" || !isLoopbackUrl(parsed)) {
    stderr(`[mcode-host-mcp] 中继地址必须是不带路径的回环 http 地址,拒绝:${relayUrl}`);
    return 2;
  }

  await runHostMcpStdio(createRelayRemote(relayUrl, token), streams);
  return 0;
}

/**
 * 直接执行时跑 main。用 `import.meta.url` 与 `process.argv[1]` 比对 —— **不采用**
 * "被 import 就静默"的隐式约定:这个文件是 bundle 入口,`argv[1]` 就是它自己。
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url || pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      stderr(`[mcode-host-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(1);
    },
  );
}
