/**
 * **MCP 端点** —— 让浏览器里的那个扩展把 mcode 的工具当成它自己的工具用。
 *
 * ## 它解决的是什么
 *
 * 网页版模型的对话在**真实浏览器**里跑(见 `extensionBridge.ts`),那边是别人的页面,
 * 我们伸不进手去。所以"让它调用 mcode 的工具"这件事只能反过来做:把 mcode 的工具
 * **暴露成一个 MCP server**,由扩展那侧(它本来就是个标准 MCP 客户端)连过来取。
 *
 *   - 扩展 → mcode:`POST /mcp`,标准 streamable HTTP(`initialize` / `tools/list` /
 *     `tools/call`);
 *   - mcode → 工具:交给注入进来的 {@link McpToolHost}(真实实现见 `main/mcp/webToolHost.ts`,
 *     它拿的是与进程内那两个 server **同一份**工具表)。
 *
 * ## 为什么和扩展桥共用端口与令牌
 *
 * 用户已经为一个东西配过一次地址和令牌了(扩展桥)。再开一个端口、再发一个令牌,
 * 就为了让同一个浏览器扩展连两次 —— 用户得配两遍,还得记住哪个是哪个。共用之后
 * 扩展里填的是**同一个地址**,只是路径写成 `/mcp`。
 *
 * ## 这个文件是**纯**的
 *
 * 不 import electron、不 import db、不 import 任何主进程的 store —— 工具从哪儿来由
 * {@link configureMcpToolHost} 注入(与 `configureExtensionBridgeTokenStore` 同一个
 * 套路)。这样无头 smoke 能把假宿主注进来,把这条协议逐条断言一遍。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { log } from "@main/lib/logger.js";
// 会话头字面量住在契约层（理由见下面那段注释）。既要转出去，也要在本文件里用来读请求。
import { MCODE_SESSION_HEADER } from "@contracts/customModel";

/** 端点的路径。扩展里配的完整地址就是 `<扩展桥地址>/mcp`。 */
export const MCP_ENDPOINT_PATH = "/mcp";

/**
 * 会话标识头 —— 「这次工具调用属于哪次对话」。
 *
 * 字面量与它那份长注释住在 `@contracts/customModel`（跨进程的线协议常量该在契约层，
 * 而且这里 import 了 logger，纯模块不能引这份）。这里只是转出，让认这条头的人有一个
 * 就近的入口。
 */
export { MCODE_SESSION_HEADER };

/** 与扩展侧 `core/mcp/constants.ts` 的 `MCP_PROTOCOL_VERSION` 对齐。 */
const MCP_PROTOCOL_VERSION = "2025-06-18";
/** 扩展那头支持的历史版本,跟着一起认 —— 它 negotiate 时会带自己最新的那版。 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", MCP_PROTOCOL_VERSION];

/**
 * 请求体上限。工具的入参里最大的是 `workflow_save` 的整张图,几十 KB 量级;
 * 4MB 是"远够用、又不至于让一次畸形请求把主进程吃住"的位置。
 */
const MAX_MCP_BODY = 4 * 1024 * 1024;

/** 一个工具报给扩展的样子 —— `inputSchema` 已经是 JSON Schema(不是 zod)。 */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** 工具调用的一次结果。`isError` 走 MCP 的约定:失败也是**结果**,模型看得见、能自己改。 */
export interface McpToolCallResult {
  text: string;
  isError?: boolean;
}

/**
 * 工具的提供方。真实的那个(`main/mcp/webToolHost.ts`)拿的是与进程内 server 同一份
 * 工具表并复用 mcode 现有的审批闸门;smoke 里注的是假的。
 */
export interface McpToolHost {
  listTools(): McpToolInfo[];
  /**
   * 调用一个工具。
   *
   * `ctx.sessionId` 可能是 null(扩展没带会话头)—— 那时**由宿主决定怎么办**:
   * 真实宿主会回一句"这次调用没带会话标识"的失败结果,因为审批闸门(权限模式、
   * 「始终允许」)全是按会话记的,没有会话就没有闸门,不能就这么放行。
   */
  callTool(name: string, args: unknown, ctx: { sessionId: string | null }): Promise<McpToolCallResult>;
}

let host: McpToolHost | null = null;

/** 装配真实宿主 —— 只由 `main/index.ts` 调。传 null 是卸载(smoke 用完就还回去)。 */
export function configureMcpToolHost(next: McpToolHost | null): void {
  host = next;
}

/** 这个请求该归到哪次对话。没有这个头就是 null(见 {@link MCODE_SESSION_HEADER})。 */
export function sessionIdOf(req: IncomingMessage): string | null {
  const raw = req.headers[MCODE_SESSION_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value : null;
}

/* ────────────────────────────── JSON-RPC ────────────────────────────── */

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** 只有带上 `id` 的才要回话(notification 一律不应答,回 202 就够)。 */
function hasId(body: JsonRpcRequest): boolean {
  return body.id !== undefined && body.id !== null;
}

function result(res: ServerResponse, id: unknown, payload: unknown): void {
  json(res, 200, { jsonrpc: "2.0", id, result: payload });
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string): void {
  json(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** 收下但不回话 —— MCP 的 notification 就是这样(HTTP 202 + 空体)。 */
function accepted(res: ServerResponse): void {
  res.writeHead(202);
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * 处理一次 `POST /mcp`。
 *
 * 无状态:不发 `Mcp-Session-Id`(协议里那一项是**可选**的,不给就等于"每次请求都是
 * 独立的一次")。这里确实没有需要挂的东西 —— 工具表是静态的,而"这次是哪个会话"
 * 每次都从头里读,不靠连接上的状态记。
 */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    // 我们不主动往客户端推消息,所以没有 GET(SSE 那条)可给。
    res.setHeader("Allow", "POST");
    json(res, 405, { error: "MCP endpoint is POST-only" });
    return;
  }

  let body: JsonRpcRequest;
  try {
    const raw = await readBody(req);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      json(res, 400, { error: "body must be a JSON-RPC object" });
      return;
    }
    body = parsed as JsonRpcRequest;
  } catch (err) {
    json(res, 400, { error: `bad JSON body: ${(err as Error).message}` });
    return;
  }

  const method = typeof body.method === "string" ? body.method : "";
  if (!method) {
    rpcError(res, body.id, -32600, "missing method");
    return;
  }

  switch (method) {
    case "initialize":
      result(res, body.id, {
        protocolVersion: negotiatedVersion(body.params),
        // 工具表是静态的(它由主进程的代码决定),所以没有 listChanged。
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mcode", version: "1.0.0" },
        instructions:
          "Mcode 桌面端的工具。文献库(检索、导入、分类、笔记、模版)与工作流" +
          "(读/写工作流、节点类型、代理档案)都在这里。写操作会**弹在用户的 mcode 窗口里**" +
          "等他确认 —— 所以一次写调用可能要过一会儿才回,而且用户可能拒绝。" +
          "被拒绝不是出错,是用户不同意,别换个说法重试同一个动作。",
      });
      return;

    case "notifications/initialized":
      accepted(res);
      return;

    case "ping":
      result(res, body.id, {});
      return;

    case "tools/list": {
      if (!host) {
        rpcError(res, body.id, -32603, "mcode tool host is not ready");
        return;
      }
      result(res, body.id, { tools: host.listTools() });
      return;
    }

    case "tools/call":
      await handleCall(req, res, body);
      return;

    default:
      // notification 型的未知方法不该让客户端炸掉(它本来就等不到回话)。
      if (!hasId(body)) {
        accepted(res);
        return;
      }
      rpcError(res, body.id, -32601, `method not found: ${method}`);
      return;
  }
}

async function handleCall(req: IncomingMessage, res: ServerResponse, body: JsonRpcRequest): Promise<void> {
  const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof params.name === "string" ? params.name : "";
  if (!name) {
    rpcError(res, body.id, -32602, "tools/call requires a tool name");
    return;
  }
  if (!host) {
    rpcError(res, body.id, -32603, "mcode tool host is not ready");
    return;
  }
  if (!host.listTools().some((tool) => tool.name === name)) {
    // 协议层错误:这个名字根本不在表里(不是"工具跑失败了")。
    rpcError(res, body.id, -32602, `unknown tool: ${name}`);
    return;
  }

  const sessionId = sessionIdOf(req);
  try {
    const out = await host.callTool(name, params.arguments ?? {}, { sessionId });
    result(res, body.id, {
      content: [{ type: "text", text: out.text }],
      ...(out.isError ? { isError: true } : {}),
    });
  } catch (err) {
    // 工具自己抛了 —— 也是模型该看见的一次失败,不是连接该断的理由。
    log.error(`mcp endpoint: tool ${name} threw: ${(err as Error).message}`);
    result(res, body.id, {
      content: [{ type: "text", text: `失败:${(err as Error).message}` }],
      isError: true,
    });
  }
}

/** 客户端报的版本我们认就用它的,不认就回我们自己最新的那版(协议规定的协商方式)。 */
function negotiatedVersion(params: unknown): string {
  const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  if (typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)) return asked;
  return MCP_PROTOCOL_VERSION;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY) {
        reject(new Error(`请求体超过 ${MAX_MCP_BODY} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}