/**
 * 进程内 MCP server 共用的那一小块:SDK 的惰性加载,以及工具返回值的两个构造器。
 *
 * ## 为什么要单独一个文件
 *
 * 抽出来之前,同一段五行的加载器在**三个地方**各有一份(`ClaudeAgentSdkProvider`、
 * `mcp/libraryServer.ts`,以及这里)。多出来的这个文件看着像是为省几行代码而生的 ——
 * 但它省掉的是三份会各自漂移的样板:每份都有自己那个 `createMcpServerFn` 模块变量、
 * 自己的返回类型写法、自己的一句注释。三个 server 加一个预热入口共用一份,
 * "有没有加载过"才只有一个答案。
 *
 * `text` / `fail` / `SdkTool` 跟着一起放,是因为它们与加载器服务于同一件事 —— 写一个
 * 进程内 MCP server。多一个 server 时,这一份就该是它 import 的第一样东西。
 */
import type { z } from "zod";
import type { createSdkMcpServer as CreateSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

/** 一个工具的返回值。MCP 只认这种形状的文本结果。 */
export type ToolContent =
  | { type: "text"; text: string; data?: never; mimeType?: never }
  | { type: "image"; data: string; mimeType: string; text?: never };

export interface ToolResult {
  /** Tool execution failed; preserve this flag across every transport. */
  isError?: boolean;
  content: ToolContent[];
  /** 结构化结果(可选)。只有网页端那条路会把它转给模型 —— SDK 那条路的
   *  `SdkMcpToolDefinition` 没有这个位置(见 `McpToolSpec.outputSchema` 那段)。 */
  structuredContent?: Record<string, unknown>;
}

/** MCP 工具处理函数上下文：会话标识，以及可选的 public/local 来源。
 * 来源由宿主设置，不接受工具参数伪造；省略时保持本机原有行为。
 *
 *  绝大多数工具用不上它 —— 它们动的是库里/工作流里那份全局状态。用得上的是
 *  「挂进这次对话」那类:附件是**按会话**存的,没有会话 id 就不知道该挂给谁。 */
export interface McpToolContext {
  sessionId: string;
  audience?: "public" | "local";
}

/**
 * 一个工具的**声明**,不含 SDK。
 *
 * 直接把内联数组交给 `createSdkMcpServer` 也可以,但那样工具表就只活在 SDK 的形状里。
 * 网页端那条通路不过 SDK(它把工具表原样报给浏览器里的扩展),想用同一份表就得抄一遍 ——
 * 而抄一遍的那份一定会在下次加工具时漂移。所以把"名字 + 说明 + 入参形状 + 处理函数"
 * 收成这一个类型,两个 server 都用它声明,谁要用谁 map 一次。
 *
 * `inputSchema` 与 SDK 的 `inputSchema` 同形:**字段名 → zod 类型**的裸 shape
 * (不是 `z.object(...)`,包裹由各自的消费方做)。
 */
export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  /**
   * 返回值的结构(zod 裸 shape,同 `inputSchema` 的写法)。**可选** —— 只有返回值
   * 值得结构化读取的工具才填,目前只有 `agent_process_*` 那一组(它们的 `next_cursor`
   * 让模型不得不从文本里正则解析)。
   *
   * ⚠️ **只有网页端那条路用得上它。** Claude Agent SDK 的 `SdkMcpToolDefinition`
   * 没有 `outputSchema` 字段(见 sdk.d.ts:`name / description / inputSchema /
   * annotations / _meta / handler`),所以进程内 server 报不出这个 —— 两条路共用
   * 这张表,靠这个可选字段区分,不给就没有。
   */
  outputSchema?: Record<string, z.ZodTypeAny>;
  /**
   * ⚠️ `args` 是宽的,这不是偷懒:表里每个 handler 都写着自己的**具体形状**
   * (`{ id: string }`、`{ journals: string[] }`…),而调用方是**按名字动态派发**的 ——
   * 它拿到的是线上来的一个 JSON 对象,派发那一刻不知道也不该知道是哪一种。
   * 真实校验发生在更前面:走 SDK 的那条路由 SDK 按 `inputSchema` 校验,走网页端的那条
   * 由 webToolHost 用同一份 zod schema 校验。所以到 handler 里时形状**已经是对的**,
   * 只是类型系统追不到那一步。
   *
   * 用 `Record<string, unknown>` 会立刻在二十几个 handler 上炸出 "缺属性" 的错误 ——
   * 那是拿类型系统去否定一件它本来就看不见的事。与 {@link SdkTool} 那段是同一个取舍。
   */
  handler: (args: any, ctx: McpToolContext) => Promise<ToolResult> | ToolResult;
}

/**
 * 把工具表按会话套成 SDK 要的形状 —— 两个 server 都走这一段。
 *
 * 会话在这里**闭合**进每个 handler:表本身是无状态的(它还得给网页端那条通路复用),
 * "挂进哪次对话"由调用方给的那一次决定。SDK 要求异步 handler;同步结果/异常也统一
 * 转成 Promise。以普通结果对象跨越协议边界,保留错误标记、图片及结构化内容。
 */
export function toSdkTools(specs: McpToolSpec[], ctx: McpToolContext): SdkTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    handler: async (args: Record<string, unknown>) => ({ ...await spec.handler(args, ctx) }),
  }));
}

/** 成功:把要说的写清楚。 */
export function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/**
 * 成功,且**带结构化结果**:`text` 给人/给 SDK 那条路读,`structured` 给网页端的模型
 * 直接读字段。两者内容该一致(同一件事实的两种投影),别只更新一边。
 */
export function structured(t: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: t }], structuredContent: structured };
}

/** MCP 标准图片结果；data 是不带 data: 前缀的 base64。 */
export function image(data: string, mimeType: string, caption?: string): ToolResult {
  return {
    content: [
      ...(caption ? [{ type: "text" as const, text: caption }] : []),
      { type: "image" as const, data, mimeType },
    ],
  };
}

/** Return a recoverable tool error, distinct from a JSON-RPC transport error. */
export function fail(msg: string): ToolResult {
  return { content: [{ type: "text", text: `失败:${msg}` }], isError: true };
}

/**
 * ⚠️ SDK 把 tool handler 的入参声明成宽的 `{ [x: string]: unknown }`(它没法知道每个
 * 工具的 zod schema)。我们的 handler 写的是**具体形状** —— 那才是可读的,而且运行时
 * zod 已经校验过了。与其在十几个 handler 里各写一遍 `as`,不如在交付边界上统一转一次型。
 */
export type SdkTool = NonNullable<Parameters<typeof CreateSdkMcpServer>[0]["tools"]>[number];

let createMcpServerFn: typeof CreateSdkMcpServer | null = null;

/**
 * 惰性载入 SDK 的 `createSdkMcpServer`。这个模块很大,不能挂在启动路径上 ——
 * 但也不用在这里单独预热:`preloadClaudeSdk()` 已经在空闲时把它(和 `query`)
 * 一起载进来了,两个加载器共用同一份缓存。
 */
export async function loadCreateMcpServer(): Promise<typeof CreateSdkMcpServer> {
  if (!createMcpServerFn) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    createMcpServerFn = sdk.createSdkMcpServer;
  }
  return createMcpServerFn;
}
