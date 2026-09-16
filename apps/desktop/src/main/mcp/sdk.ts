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
import type { createSdkMcpServer as CreateSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

/** 一个工具的返回值。MCP 只认这种形状的文本结果。 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

/** 成功:把要说的写清楚。 */
export function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/** 失败也走正常结果 —— 模型读得懂,能自己改;抛异常会变成 isError,更难恢复。 */
export function fail(msg: string): ToolResult {
  return { content: [{ type: "text", text: `失败:${msg}` }] };
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
