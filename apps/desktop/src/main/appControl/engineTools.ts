/**
 * mcode-app 给**没有进程内 MCP** 的引擎(Codex 动态工具 / Pi 扩展)用的那一份:
 * JSON-schema 描述 + 统一调用入口。与 `memory/engineTools.ts` 同一个形状。
 * 审批在 `invokeAppTool` 里做,引擎侧对 `app_*` 不要再套一层审批。
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ProviderContext } from "@contracts/provider";
import type { ToolResult } from "@main/mcp/sdk.js";
import { appMcpTools, invokeAppTool } from "./tools.js";

export function appToolDescriptors(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return appMcpTools().map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: zodToJsonSchema(z.object(spec.inputSchema), { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>,
  }));
}

export function isAppToolName(name: string): boolean {
  // 【T24】**判据是表成员资格，不是前缀猜名。** `document_*` 六个工具就住在同一张
  // `appMcpTools()` 表里，走同一个 `invokeAppTool`（审批在 handler 里按工具分档）。
  // 【T20】`extension_*` 同理。
  // 【T51】这里**去掉了前缀门**：原来写的是「前缀在 {app_, document_, extension_} 里
  // **且** 在表里」，等于每加一个新前缀（这次是 `workflow_guide`）都要回来同步一次，
  // 忘了就表现为 app-control 的「描述符与工具表一致」变红 —— 而那条断言的**本意**
  // 就是表成员资格。前缀门只是叠在它上面的一层冗余，并且是唯一会漏的那一层。
  // 表本身就是白名单：不在 `appMcpTools()` 里的名字一律 false。
  return appMcpTools().some((t) => t.name === name);
}

export function invokeAppEngineTool(name: string, args: unknown, sessionId: string, ctx: ProviderContext): Promise<ToolResult> {
  return invokeAppTool(name, args, sessionId, ctx);
}
