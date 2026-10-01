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
  return name.startsWith("app_") && appMcpTools().some((t) => t.name === name);
}

export function invokeAppEngineTool(name: string, args: unknown, sessionId: string, ctx: ProviderContext): Promise<ToolResult> {
  return invokeAppTool(name, args, sessionId, ctx);
}
