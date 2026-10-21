/**
 * **mcode-host-mcp 的 stdio 传输层** —— ARC-006 桥 2 的第二片(`hostMcpServer.ts` 是纯逻辑核心)。
 *
 * ## 它是什么
 *
 * 一个标准 MCP 客户端的 stdio 服务器形态(与 `genoffice mcp` 同一种):引擎(Node-RED)
 * 把 `mcode-host-mcp` 当成一个 stdio MCP server 拉起来,往 stdin 写**换行分隔的 JSON-RPC**,
 * 从 stdout 读回应。
 *
 * 本文件只做两件事:
 *   1. **帧**:逐行读 stdin / 逐行写 stdout,认 MCP 需要的四帧 —— `initialize`、
 *      `notifications/initialized`(忽略)、`tools/list`、`tools/call`(另加规范里的
 *      `ping`);坏 JSON / 未知方法 → JSON-RPC error,**不崩进程**;stdin 关闭 → 正常收束。
 *   2. **把请求交给远端端口** {@link HostMcpRemote} —— 本进程**不持有**工具表与执行器:
 *      真正的 `tools()` / `invoke()` 在主进程(`createHostMcpServer` 的装配在那里,因为
 *      `appMcpTools()` / `invokeAppTool` 的 import 图带着 electron 与 sql.js,外部 Node
 *      进程装不下)。本地直连与回环中继都实现同一个端口,传输层不关心是哪种。
 *
 * ## 边界(与规范的最小集,如实写明)
 *
 *   - **没有** `resources/*` / `prompts/*` / `logging` / 采样 / roots —— 本 server 只暴露工具,
 *     `initialize` 的能力声明也只报 `tools`(不带 `listChanged`,表是静态的);
 *   - **不支持 JSON-RPC 批量请求**(MCP 2025-06-18 已移除批量)→ `-32600`,不猜语义;
 *   - 帧按**到达顺序串行处理**(一次一条):传输层不需要并发,串行让"stdin 关闭时在途
 *     请求先写完再退出"变成天然行为;
 *   - **stdout 只写 JSON 帧,一个多余字节都没有**;所有日志走 stderr(注入的 `log`)。
 *     stdio 协议下 stdout 被污染 = 客户端解析失败 = 整个 server 看起来"连不上"。
 *
 * ## 协议版本 —— 全仓唯一一份
 *
 * 版本常量与协商规则住在这里,本机浏览器扩展 / 公网那条 HTTP 端点
 * (`providers/bridge/mcpEndpoint.ts`)从这里转出 —— 两个 MCP server 面共用一个答案,
 * 不再各写一个字面量。值本身与扩展侧 `core/mcp/constants.ts` 对齐。
 */
import type { HostMcpToolDescriptor } from "./hostMcpServer.js";
import type { ToolResult } from "./sdk.js";

/** 与扩展侧 `core/mcp/constants.ts` 的 `MCP_PROTOCOL_VERSION` 对齐。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** 跟着一起认的历史版本 —— 客户端 negotiate 时会带它自己最新的那版(MCP 规范)。 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2024-11-05",
  "2025-03-26",
  MCP_PROTOCOL_VERSION,
];

/** 协商:客户端报的版本我们认就用它的,不认就回我们自己最新的那版(协议规定的做法)。 */
export function negotiateMcpProtocolVersion(params: unknown): string {
  const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  if (typeof asked === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(asked)) return asked;
  return MCP_PROTOCOL_VERSION;
}

/** `initialize` 回给客户端的 serverInfo(名字就是 MCP 条目里要填的那个)。 */
export const HOST_MCP_SERVER_NAME = "mcode-host-mcp";
export const HOST_MCP_SERVER_VERSION = "1.0.0";

/** 给模型看的用法说明(与 `mcode-app` 的指令同一口径:工具表同一份、审批在宿主)。 */
const HOST_MCP_INSTRUCTIONS =
  "Mcode 桌面端的控制工具。工具表与 Agent 的 appMcpTools() 是同一份;" +
  "只读与纯界面操作直接执行,有副作用的需要用户在宿主审批卡上批准,高风险操作每次都要本人批准;" +
  "没有审批通道时会明确拒绝(unavailable),不会降级为无审批执行。";

/**
 * 传输层背后的宿主端口 —— 工具表的读取与工具调用都从这儿来。
 *
 * 生产有两条实现:主进程内直接包一个 {@link import("./hostMcpServer.js").HostMcpServer}
 * (本地直连,测试用);mcode-host-mcp 子进程包里的是回环 HTTP 中继实现(见
 * `hostMcpMain.ts`)。**传输层不知道也不关心是哪一种。**
 */
export interface HostMcpRemote {
  listTools(): Promise<HostMcpToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<ToolResult>;
}

/** 一个 JSON-RPC 2.0 错误负载。 */
export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/** 一条 JSON-RPC 2.0 回应(notification 不产生回应)。 */
export interface JsonRpcResponsePayload {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

/** 只有带 `id` 的才要回话(notification 一律不应答,与 mcpEndpoint 同一条规则)。 */
function hasId(body: { id?: unknown }): boolean {
  return body.id !== undefined && body.id !== null;
}

function idOf(body: { id?: unknown }): string | number | null {
  return typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponsePayload {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponsePayload {
  return { jsonrpc: "2.0", id, result };
}

/**
 * 分发一个**已解析**的 JSON-RPC 请求。
 *
 * 返回 `null` = 这是 notification,不应答。永不抛 —— 远端端口抛错由
 * {@link handleHostMcpLine} 统一变成 `-32603`。
 */
export async function dispatchHostMcpRequest(
  remote: HostMcpRemote,
  body: Record<string, unknown>,
): Promise<JsonRpcResponsePayload | null> {
  const id = idOf(body);
  const wantsReply = hasId(body);
  const method = typeof body.method === "string" ? body.method : "";
  if (!method) return rpcError(id, -32600, "invalid request: missing method");

  switch (method) {
    case "initialize":
      if (!wantsReply) return null;
      return rpcResult(id, {
        protocolVersion: negotiateMcpProtocolVersion(body.params),
        // 工具表是静态的(由主进程代码决定),没有 listChanged。
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: HOST_MCP_SERVER_NAME, version: HOST_MCP_SERVER_VERSION },
        instructions: HOST_MCP_INSTRUCTIONS,
      });

    case "notifications/initialized":
      // 客户端确认握手完成 —— notification,不应答。
      return null;

    case "ping":
      return wantsReply ? rpcResult(id, {}) : null;

    case "tools/list": {
      if (!wantsReply) return null;
      const tools = await remote.listTools();
      if (!Array.isArray(tools)) throw new Error("宿主返回的 tools/list 不是数组");
      return rpcResult(id, { tools });
    }

    case "tools/call": {
      if (!wantsReply) return null;
      const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (!name) return rpcError(id, -32602, "tools/call requires a tool name");
      const result = await remote.callTool(name, params.arguments ?? {});
      // 核心保证返回 ToolResult(失败也是结果,isError=true);这里原样投影成 MCP 结果。
      const content = Array.isArray(result?.content) ? result.content : [];
      return rpcResult(id, {
        content,
        ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {}),
        ...(result?.isError ? { isError: true } : {}),
      });
    }

    default:
      // notification 型的未知方法不该让客户端炸掉(它本来就等不到回话)。
      return wantsReply ? rpcError(id, -32601, `method not found: ${method}`) : null;
  }
}

/**
 * 处理**一行**输入(一个 NDJSON 帧),返回要写回的那一行回应(没有回应就是 `null`)。
 *
 * 解析失败 → `-32700`(id 为 null,与 JSON-RPC 规范一致);请求体不是对象 → `-32600`。
 * **永不抛** —— 任何异常都落成 `-32603`,进程继续读下一行。
 */
export async function handleHostMcpLine(
  remote: HostMcpRemote,
  line: string,
): Promise<JsonRpcResponsePayload | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return rpcError(null, -32700, `parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rpcError(null, -32600, "invalid request: expected a single JSON-RPC object (batches are not supported)");
  }
  const body = parsed as Record<string, unknown>;
  try {
    return await dispatchHostMcpRequest(remote, body);
  } catch (err) {
    return rpcError(idOf(body), -32603, `internal error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface HostMcpStdioStreams {
  /** 默认 `process.stdin`。测试可注入。 */
  input?: NodeJS.ReadableStream;
  /** 默认 `process.stdout`。**只允许写 JSON 帧。** */
  output?: NodeJS.WritableStream;
  /** 默认写 stderr。测试可注入。 */
  log?: (line: string) => void;
}

const defaultLog = (line: string): void => {
  try {
    process.stderr.write(line + "\n");
  } catch {
    // stderr 断了不能反过来把 server 弄崩;没有别的落点,静默。
  }
};

/**
 * 跑 stdio 会话直到 stdin 关闭(或输出端断开)。
 *
 * - 逐行读 stdin(容忍 `\r\n`,空行跳过),**按到达顺序串行**分发;每条回应都等写入
 *   回调落定再处理下一帧 —— 于是返回时(stdin 关闭)不会丢在途回应;
 * - 任何一帧的失败都不会结束会话:坏 JSON / 未知方法照常回 error 后继续;
 * - 本函数**不调用** `process.exit` —— 退出码由入口决定(正常收束 = 0)。
 */
export function runHostMcpStdio(remote: HostMcpRemote, streams: HostMcpStdioStreams = {}): Promise<void> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const log = streams.log ?? defaultLog;

  log(`[${HOST_MCP_SERVER_NAME}] stdio transport ready (frames on stdout, logs on stderr)`);

  return new Promise<void>((resolve) => {
    let buffer = "";
    let closed = false;
    let inFlight: Promise<void> = Promise.resolve();

    const writeLine = (line: string): Promise<void> =>
      new Promise<void>((done) => {
        try {
          // 回调 = 这一块已交给操作系统;stdin 关闭后立刻退出也不会截断回应。
          output.write(line + "\n", () => done());
        } catch {
          done(); // 输出端已经断了(EPIPE)—— 不再写,也不抛。
        }
      });

    const enqueue = (line: string): void => {
      inFlight = inFlight.then(async () => {
        const reply = await handleHostMcpLine(remote, line);
        if (reply !== null) await writeLine(JSON.stringify(reply));
      });
    };

    const finish = (): void => {
      if (closed) return;
      closed = true;
      inFlight.then(() => resolve());
    };

    // 【类型收窄】`NodeJS.ReadableStream.on` 在 @types/node 里是两个互不兼容的
    // 重载组成的联合，直接调用会报 TS2349（"不是可调用的"）。只用到 EventEmitter
    // 的 on，收窄到那一层即可；运行时行为不变（ReadableStream 本来就继承它）。
    const inputEvents = input as NodeJS.EventEmitter;
    inputEvents.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.trim()) enqueue(line);
        idx = buffer.indexOf("\n");
      }
    });
    inputEvents.on("end", () => {
      // 最后一行可能没有换行符。
      if (buffer.trim()) enqueue(buffer);
      buffer = "";
      finish();
    });
    inputEvents.on("error", () => finish());
    // 输出端断开(客户端走了)同样收束;再写也没有意义。
    (output as NodeJS.EventEmitter).on?.("error", () => finish());
  });
}
