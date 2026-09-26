import { memoryProjectForSession, memoryWriteOrigin } from "./access.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ProviderContext } from "@contracts/provider";
import { memoryMcpTools, MEMORY_READONLY_TOOLS } from "@main/mcp/memoryServer.js";
import { fail, type ToolResult } from "@main/mcp/sdk.js";
export function memoryToolDescriptors() {
  return memoryMcpTools().map(spec => ({ name: spec.name, description: spec.description,
    inputSchema: zodToJsonSchema(z.object(spec.inputSchema), { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown> }));
}
export async function invokeMemoryTool(name: string, args: unknown, sessionId: string, ctx: ProviderContext): Promise<ToolResult> {
  const spec = memoryMcpTools().find(tool => tool.name === name);
  if (!spec) return fail("未知记忆工具");
  try {
    let input = z.object(spec.inputSchema).parse(args);
    if (!MEMORY_READONLY_TOOLS.has(name)) {
      // Persistent memory changes get explicit approval, independent of engine-specific file grants.
      if (!ctx.requestApproval) return fail("记忆写入审批不可用，未修改任何记录");
      const projectId = memoryProjectForSession(sessionId), origin = memoryWriteOrigin(sessionId);
      const global = typeof input.path === "string" ? input.path.startsWith("global/") : input.scope === "global";
      const description = `持久记忆变更：${global ? "全局（所有项目共享）" : `项目 ${projectId}`}；来源 ${origin.kind} / ${sessionId}。临时工作流产物不会自动升级为长期记忆。`;
      const decision = await ctx.requestApproval({ requestId: randomUUID(), toolName: name, input, description });
      if (!decision.allow) return fail("用户未批准记忆修改");
      if (decision.updatedInput !== undefined) input = z.object(spec.inputSchema).parse(decision.updatedInput);
    }
    return await spec.handler(input, { sessionId });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
}
