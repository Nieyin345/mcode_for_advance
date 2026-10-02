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
  /**
   * MCP 的行为提示(readOnlyHint / destructiveHint / openWorldHint / …)。
   *
   * **不是可选的装饰**:ChatGPT 的开发者模式靠 `readOnlyHint` 决定要不要弹确认框 ——
   * 不标就把只读工具也当成写工具,每次都弹。判定从 `toolRules.annotationsForTool`
   * 派生(与 mcode 自己的"哪些工具不用问"共用同一份只读清单)。
   */
  annotations?: Record<string, unknown>;
  /**
   * 这个工具**返回**什么的 JSON Schema。可选 —— 只有那些返回值值得模型结构化读取的
   * 工具才填(目前是 `agent_process_*` 那一组:它们的 `next_cursor` / `status` 让模型
   * 不得不从文本里正则解析,给了 schema 就能直接读)。
   *
   * 为什么是可选而不是人人都有:绝大多数工具返回的是一段人话摘要,给它们编一份
   * outputSchema 只是为了"显得规范",反而多一份要维护的谎言。
   */
  outputSchema?: unknown;
}

/** 工具调用的一次结果。`isError` 走 MCP 的约定:失败也是**结果**,模型看得见、能自己改。 */
export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolCallResult {
  /** Text projection kept for internal callers/tests and approval UI summaries. */
  text: string;
  /** Full MCP content blocks. When omitted, the endpoint wraps `text` as one text block. */
  content?: McpToolContent[];
  /**
   * 结构化结果(MCP 协议的标准字段,与 `content` 并列)。
   *
   * 有了它,模型不用再从 `text` 里正则抠 `next_cursor: 4821` 这种;`text` 仍然给
   * 人和走 SDK 那条路(SDK 的 `SdkMcpToolDefinition` **不支持** outputSchema,所以
   * 那条路的模型只能读文本 —— 这也是为什么两者要并存,而不是替换)。
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * 工具的提供方。真实的那个(`main/mcp/webToolHost.ts`)拿的是与进程内 server 同一份
 * 工具表并复用 mcode 现有的审批闸门;smoke 里注的是假的。
 */
/**
 * 谁在问这张表:`local` = 本机浏览器扩展(`/mcp`,默认);`public` = 公网 MCP(ChatGPT 直连)。
 * 两边给的工具不一样(公网:不给工作流那组、多给资料库只读那组),见 `webToolHost.ts`。
 */
export type McpAudience = "local" | "public";

export interface McpToolHost {
  listTools(audience?: McpAudience): McpToolInfo[];
  /**
   * 调用一个工具。
   *
   * `ctx.sessionId` 可能是 null(扩展没带会话头)—— 那时**由宿主决定怎么办**:
   * 真实宿主会回一句"这次调用没带会话标识"的失败结果,因为审批闸门(权限模式、
   * 「始终允许」)全是按会话记的,没有会话就没有闸门,不能就这么放行。
   */
  callTool(
    name: string,
    args: unknown,
    ctx: { sessionId: string | null; audience?: McpAudience },
  ): Promise<McpToolCallResult>;
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
export interface McpRequestOptions {
  /** 见 {@link McpAudience}。不给 = `local`。 */
  audience?: McpAudience;
  /**
   * 慢的 `tools/call` 改用 SSE 回、中途发保活注释(见 {@link handleCall})。
   * **只给公网那条路开** —— 它前面是 Cloudflare:一个请求 100 秒内一个字节都没回就
   * 524,这个上限免费/Pro/Business 都改不了。扩展的 `/mcp` 是本机回环,不需要。
   */
  keepAliveLongCalls?: boolean;
}

/** agent_* 的通用用法 —— 两条通道共用。 */
const AGENT_TOOL_GUIDE =
  "agent_* 支持文本/图片/Office/PDF 读取，文件与目录修改，后台搜索，系统进程和持久进程。" +
  "同时读多个文本文件优先 agent_read_files。" +
  "PDF 创建/页操作用 agent_write_pdf；Excel Range 用 agent_edit_excel_range；" +
  "DOCX 结构修改先 agent_read_docx_xml 再 agent_edit_docx_xml。" +
  "图片由 agent_read_image 返回标准 MCP image block，只有支持视觉输入的客户端/模型才能直接理解。" +
  (process.platform === "win32"
    ? "这台机器是 Windows：agent_bash 用 cmd.exe 执行（不是 bash；要 PowerShell 就写 powershell -NoProfile -Command \"...\"），路径用反斜杠或带引号。"
    : "agent_bash 用 /bin/sh 执行。") +
  "REPL/dev server/长构建优先 agent_process_start，然后用 agent_process_read 取增量输出——" +
  "它**默认会阻塞等到有输出**（最多约 55 秒），不要传 wait_ms=0 去做短轮询，" +
  "那只会制造大量空往返；一次调用就是等下一批日志。返回里 has_more 为 true 就立刻再读一次，" +
  "status 不是 running 说明进程已结束。agent_process_* 的返回带 structuredContent，直接读字段，不用解析文本。" +
  "远程 SSH 训练/长任务必须优先 agent_remote_job_start：任务状态和日志落在服务器 ~/.mcode/jobs，SSH/MCP 断线后可恢复；" +
  "短远程检查才用 agent_ssh_exec；重要训练显式提供稳定 job_id，网络失败重试必须复用同一个 id，避免重复启动。";

/** 本机浏览器扩展(`/mcp`)那条:工作流在、走 mcode 的审批闸门。 */
const LOCAL_INSTRUCTIONS =
  "Mcode 桌面端的工具。资料库、工作流和 agent_* 电脑操作能力都从这个 MCP 端点提供。" +
  "相对路径以当前 mcode 会话工作目录为基准。" +
  AGENT_TOOL_GUIDE +
  "写入、启动命令、杀系统进程等有副作用操作遵循 mcode 当前权限模式，必要时会弹审批卡；" +
  "用户拒绝后不要换说法重复同一个动作。";

/** 公网 MCP 那条(远程 AI 直连):没有工作流/对话记录,资料库只读,免审批但锁在可写项目里。 */
const PUBLIC_INSTRUCTIONS =
  "Mcode 桌面端的远程工具：agent_* 电脑操作、资料库只读查询（library_*）和本地技能（agent_skill_list / agent_skill_read）。" +
  "这条通道没有工作流/自动化工具，也读不到用户的对话记录。" +
  "开始干活前先调一次 agent_context：它告诉你唯一可写的项目目录（writable_project）、其它只读项目和资料库概况。" +
  "相对路径以可写项目目录为基准；写文件、建目录、移动和命令的写目标都只能落在这个目录里，越界会被拒绝——换成项目内的路径，别反复重试。" +
  "资料库和技能目录可以用 agent_read_* / agent_list_dir 读，但不能改，要改先复制进项目。" +
  "用户提到某个技能时先 agent_skill_list 确认，再 agent_skill_read 读 SKILL.md，照里面的步骤做。" +
  AGENT_TOOL_GUIDE +
  "这条通道不弹审批卡，调用会直接执行：删除、覆盖、杀进程这类不可逆操作先跟用户确认；用户拒绝后不要换说法重复同一个动作。";

/** 慢调用多久之后切 SSE、多久发一次保活。smoke 用 {@link configureMcpLongCallTiming} 调短。 */
let longCallSwitchAfterMs = 25_000;
let longCallKeepaliveMs = 20_000;

/** 仅供 smoke:把切换/保活的时间调短,免得一条断言等半分钟。 */
export function configureMcpLongCallTiming(next: { switchAfterMs?: number; keepaliveMs?: number }): void {
  if (next.switchAfterMs !== undefined) longCallSwitchAfterMs = next.switchAfterMs;
  if (next.keepaliveMs !== undefined) longCallKeepaliveMs = next.keepaliveMs;
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: McpRequestOptions = {},
): Promise<void> {
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
        // 两条通道给的工具不一样(见 webToolHost.ts),说明也得跟着分开 —— 公网那条没有
        // 工作流、免审批但锁在可写项目里;写成同一段会让远程 AI 去调根本不存在的工具。
        instructions: opts.audience === "public" ? PUBLIC_INSTRUCTIONS : LOCAL_INSTRUCTIONS,
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
      result(res, body.id, { tools: host.listTools(opts.audience) });
      return;
    }

    case "tools/call":
      await handleCall(req, res, body, opts);
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

/** 客户端声明收得下 SSE(Streamable HTTP 规定客户端 POST 时 Accept 要同时带两种)。 */
function acceptsEventStream(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  return value.toLowerCase().includes("text/event-stream");
}

async function handleCall(
  req: IncomingMessage,
  res: ServerResponse,
  body: JsonRpcRequest,
  opts: McpRequestOptions = {},
): Promise<void> {
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
  if (!host.listTools(opts.audience).some((tool) => tool.name === name)) {
    // 协议层错误:这个名字根本不在表里(不是"工具跑失败了")。
    rpcError(res, body.id, -32602, `unknown tool: ${name}`);
    return;
  }

  const sessionId = sessionIdOf(req);
  const toolHost = host;
  const call: Promise<unknown> = toolHost.callTool(name, params.arguments ?? {}, { sessionId, audience: opts.audience }).then(
    (out) => ({
      content: out.content?.length ? out.content : [{ type: "text", text: out.text }],
      ...(out.structuredContent ? { structuredContent: out.structuredContent } : {}),
      ...(out.isError ? { isError: true } : {}),
    }),
    (err: unknown) => {
      // 工具自己抛了 —— 也是模型该看见的一次失败,不是连接该断的理由。
      log.error(`mcp endpoint: tool ${name} threw: ${(err as Error).message}`);
      return {
        content: [{ type: "text", text: `失败:${(err as Error).message}` }],
        isError: true,
      };
    },
  );

  if (!opts.keepAliveLongCalls || !acceptsEventStream(req)) {
    result(res, body.id, await call);
    return;
  }

  // 公网那条路:快的调用照旧回一个 JSON(绝大多数调用,行为与以前完全一样);
  // 过了 `longCallSwitchAfterMs` 还没完,就改成 SSE —— 先回头,再隔一阵发一行
  // `: keepalive` 注释(SSE 里冒号开头的行客户端会忽略),最后用一条 `message` 事件
  // 把 JSON-RPC 结果送过去。Cloudflare 的 100 秒是"多久没收到字节",不是总时长,
  // 所以这样能撑过任意长的调用。
  const pending = Symbol("pending");
  let switchTimer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    call,
    new Promise<typeof pending>((resolve) => {
      switchTimer = setTimeout(() => resolve(pending), longCallSwitchAfterMs);
    }),
  ]);
  if (switchTimer) clearTimeout(switchTimer);
  if (early !== pending) {
    result(res, body.id, early);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    // 让中间的反代别攒着不发(nginx 认这个头;Cloudflare 对 event-stream 本来就不攒)。
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.write(": mcode tool still running\n\n");
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, longCallKeepaliveMs);
  try {
    const payload = await call;
    if (!res.writableEnded) {
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: payload })}\n\n`);
    }
  } finally {
    clearInterval(keepalive);
    res.end();
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
