/**
 * **mcode-host-mcp 的回环中继(主进程一侧)** —— ARC-006 桥 2 的第三片。
 *
 * ## 它解决什么
 *
 * `mcode-app` 是**进程内** SDK server,外部进程连不上。桥 2 的形状是 stdio MCP server
 * (`hostMcpStdio.ts` + 可执行入口 `hostMcpMain.ts`),但那个子进程里**装不下**真正的
 * 执行器:`appMcpTools()` / `invokeAppTool` 的 import 图带着 electron 与 sql.js。
 *
 * 所以子进程只做"协议面",真正的工具表与调用留在主进程:
 *
 *   Node-RED ──stdio──▶ mcode-host-mcp 子进程 ──回环 HTTP(127.0.0.1 + 一次性令牌)──▶ 本文件
 *                                                                                    │
 *                                                                     createHostMcpServer(...)
 *                                                                     ├ tools()  = appMcpTools() 同一份
 *                                                                     └ invoke() = invokeAppTool(宿主编排)
 *
 * ## 线协议(与 `hostMcpMain.ts` 的客户端逐字对齐)
 *
 *   POST <url>/rpc
 *   Authorization: Bearer <token>
 *   { "op": "list" }                          → 200 { ok: true, tools: HostMcpToolDescriptor[] }
 *   { "op": "call", "name": "...", "args": … } → 200 { ok: true, result: ToolResult }
 *   失败                                       → { ok: false, error: "..." }(HTTP 4xx/5xx)
 *
 * 工具**业务**失败不是中继失败:核心把一切失败都建模成 `ToolResult`(`isError: true`),
 * 中继原样转发,HTTP 仍是 200 —— 与 MCP 的约定一致(失败也是模型该看见的结果)。
 *
 * ## 围栏(三层,缺一不可)
 *
 *   1. **只绑 127.0.0.1**(`listenOnDialablePort`,与扩展桥 / 公网 MCP 同一条);
 *   2. **Host 头必须是回环名** —— 防 DNS 重绑定:网页把域名解析到 127.0.0.1 后浏览器
 *      发来的请求 Host 不是回环名,直接 403(同 `bridgeServer.ts` 的判据);
 *   3. **一次性令牌**:每次 `startHostMcpRelayServer` 现铸一枚 32 字节随机令牌,随
 *      子进程环境变量下发,进程/服务器一关就作废;比较用 `timingSafeEqual`。
 *
 * ## 审批能力在哪一侧
 *
 * **审批卡只可能在中继的宿主一侧弹** —— 子进程没有 UI,也永远不接触审批决策:
 * `createHostMcpServer` 的审批端口由装配方注入(生产:由
 * `RuntimeManager.webToolGate(sessionId)` 构造,见报告),核心在调用执行器**之前**
 * 完成分档与审批;子进程发来的参数里没有任何"已批准"字段能影响判据(核心会剥掉
 * 未声明字段,分档只看工具名/方法/动作)。
 *
 * 本文件**不知道**审批怎么实现 —— 它接收一个已装配好的核心,只负责把帧送到、把结果
 * 送回。这样 smoke 与生产装配走的是同一条路。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { listenOnDialablePort } from "@main/lib/loopbackPort.js";
import type { HostMcpToolDescriptor } from "./hostMcpServer.js";
import type { ToolResult } from "./sdk.js";

/** 中继要的那一小面核心 —— `createHostMcpServer` 的返回值天然满足。 */
export interface HostMcpRelayCore {
  listTools(): HostMcpToolDescriptor[];
  callTool(name: string, args: unknown): Promise<ToolResult>;
}

/** 子进程发来的请求(线协议;`hostMcpMain.ts` 用 `import type` 引它,不会把本文件拖进子进程包)。 */
export type HostMcpRelayRequest =
  | { op: "list" }
  | { op: "call"; name: string; args: unknown };

/** 中继的回应(同上,type-only)。 */
export type HostMcpRelayReply =
  | { ok: true; tools: HostMcpToolDescriptor[] }
  | { ok: true; result: ToolResult }
  | { ok: false; error: string };

export interface HostMcpRelayOptions {
  /** 已装配好的核心。生产:`createHostMcpServer({ tools: appMcpTools, invoke }, approvalPort)`。 */
  core: HostMcpRelayCore;
  /** 日志;默认 stderr。**绝不能**写到 stdout 的协议帧通道里去(那是子进程的事,这里只是保险)。 */
  log?: (line: string) => void;
}

export interface HostMcpRelayHandle {
  /** `http://127.0.0.1:<port>` —— 放进了子进程的 `MCODE_HOST_MCP_RELAY_URL`。 */
  url: string;
  /** 一次性令牌 —— 放进了子进程的 `MCODE_HOST_MCP_RELAY_TOKEN`。 */
  token: string;
  /** 关服务器(幂等)。 */
  close(): Promise<void>;
}

/** 请求体上限:工具入参最大是 `workflow_save` 的整张图,4MB 与 `mcpEndpoint` 同一取值。 */
const MAX_RELAY_BODY = 4 * 1024 * 1024;

const defaultLog = (line: string): void => {
  try {
    process.stderr.write(line + "\n");
  } catch {
    // stderr 断了不能反过来把中继弄崩。
  }
};

/** Host 头必须是回环名(防 DNS 重绑定,判据同 `bridgeServer.ts`)。 */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1).toLowerCase()
    : host.split(":", 1)[0]!.toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || /^127\./.test(name);
}

/** 常量时间比较 —— 长度不同也先跑完一条等长比较,避免用长度差当侧信道。 */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RELAY_BODY) {
        reject(new Error(`请求体超过 ${MAX_RELAY_BODY} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 起一个只给 mcode-host-mcp 子进程用的回环中继。
 *
 * @returns 地址 + 一次性令牌(装配方负责把它们交给子进程,如作为环境变量)。
 */
export async function startHostMcpRelayServer(options: HostMcpRelayOptions): Promise<HostMcpRelayHandle> {
  const log = options.log ?? defaultLog;
  const token = randomBytes(32).toString("hex");

  const httpServer: Server = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      log(`[host-mcp-relay] handler threw: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: "relay internal error" } satisfies HostMcpRelayReply);
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ① 只回收环 Host(防 DNS 重绑定);② 只收 POST /rpc。
    if (!isLoopbackHost(req.headers.host)) {
      json(res, 403, { ok: false, error: "forbidden host" } satisfies HostMcpRelayReply);
      return;
    }
    if (req.method !== "POST" || (req.url ?? "").split("?", 1)[0] !== "/rpc") {
      res.setHeader("Allow", "POST");
      json(res, 404, { ok: false, error: "not found" } satisfies HostMcpRelayReply);
      return;
    }
    // ③ 一次性令牌。格式不对/不匹配一律 401,且不读 body。
    const auth = req.headers.authorization ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!given || !tokenMatches(given, token)) {
      json(res, 401, { ok: false, error: "invalid token" } satisfies HostMcpRelayReply);
      return;
    }

    let body: HostMcpRelayRequest;
    try {
      const raw = await readBody(req);
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        json(res, 400, { ok: false, error: "body must be a JSON object" } satisfies HostMcpRelayReply);
        return;
      }
      body = parsed as HostMcpRelayRequest;
    } catch (err) {
      json(res, 400, {
        ok: false,
        error: `bad JSON body: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies HostMcpRelayReply);
      return;
    }

    try {
      if (body.op === "list") {
        json(res, 200, { ok: true, tools: options.core.listTools() } satisfies HostMcpRelayReply);
        return;
      }
      if (body.op === "call") {
        if (typeof body.name !== "string" || body.name.trim() === "") {
          json(res, 400, { ok: false, error: "call requires a tool name" } satisfies HostMcpRelayReply);
          return;
        }
        const result = await options.core.callTool(body.name.trim(), body.args ?? {});
        json(res, 200, { ok: true, result } satisfies HostMcpRelayReply);
        return;
      }
      json(res, 400, { ok: false, error: `unknown op: ${String((body as { op?: unknown }).op)}` } satisfies HostMcpRelayReply);
    } catch (err) {
      // 核心承诺不抛(失败建模为 ToolResult);走到这里说明端口装配坏了 —— 明确报出来。
      log(`[host-mcp-relay] core threw: ${err instanceof Error ? err.message : String(err)}`);
      json(res, 500, {
        ok: false,
        error: `tool host failed: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies HostMcpRelayReply);
    }
  }

  const port = await listenOnDialablePort(httpServer);
  const url = `http://127.0.0.1:${port}`;
  log(`[host-mcp-relay] listening on ${url}`);

  return {
    url,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
