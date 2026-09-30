/**
 * 资料库工具的**跨引擎桥** —— 让 Pi / Codex 也拿到 `mcode-library` 那一套工具。
 *
 * ## 为什么要有(2026-09-30)
 *
 * 库工具(`libraryMcpTools()`)原来只经进程内 MCP server 挂在 Claude 上。Pi 与 Codex 没有
 * 进程内 MCP,于是在那两个引擎下 `library_search` / `library_import_files` /
 * `library_attach_pdf` / `library_adopt_markdown` / `library_write_note` 全都不存在 ——
 * 内置工作流(文献检索的「判断并入库」、文献导入、转录挂回)照指令去调就落空,而用户
 * 看到的只是「换了个引擎,流程就不灵了」。工具属于内核,内核应当与引擎无关。
 *
 * 形状照 `memory/engineTools.ts`:同一份 spec 表(不抄第二份),描述符给引擎注册,
 * 调用按名字派发,入参先过同一份 zod schema。
 *
 * ## 审批 —— 与 Claude 那条路同一套语义
 *
 * `toolRules.shouldAutoApprove`:`LIBRARY_READONLY_TOOLS` 在任何模式下都免问,写操作
 * 要用户点头(全放行档除外)。闸门落在各引擎**自己的**通道上:
 *
 *   - **Pi**:注册的工具天然经过 `mcodeExtension` 的 `tool_call` 守卫(权限模式 + 审批卡),
 *     那里只需让只读的直接过 —— 用 {@link isLibraryReadonlyTool}。
 *   - **Codex**:动态工具没有守卫,由 {@link invokeLibraryToolGated} 在调用前自己问。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ProviderContext } from "@contracts/provider";
import { libraryMcpTools, LIBRARY_READONLY_TOOLS } from "@main/mcp/libraryServer.js";
import { fail, type ToolResult } from "@main/mcp/sdk.js";

/** 库工具一律 `library_` 开头(见 `toolRules.isReadOnlyToolName` 那段命名约定)。 */
export function isLibraryToolName(name: string): boolean {
  return name.startsWith("library_");
}

export function isLibraryReadonlyTool(name: string): boolean {
  return LIBRARY_READONLY_TOOLS.has(name);
}

/** 给引擎注册用的描述符:名字 + 说明 + JSON Schema(与 `memoryToolDescriptors` 同形)。 */
export function libraryToolDescriptors(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return libraryMcpTools().map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: zodToJsonSchema(z.object(spec.inputSchema), { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>,
  }));
}

/**
 * 按名字派发一次库工具。**不做审批**(调用方负责,见文件头)。
 *
 * 入参在这里过 zod:走 SDK 的那条路由 SDK 按 `inputSchema` 校验,这条路没有 SDK 兜着,
 * 不校验的话 handler 会拿到线上来的任意形状(`McpToolSpec.handler` 那段说的正是这个前提)。
 */
export async function invokeLibraryTool(name: string, args: unknown, sessionId: string): Promise<ToolResult> {
  const spec = libraryMcpTools().find((tool) => tool.name === name);
  if (!spec) return fail(`未知资料库工具:${name}`);
  try {
    const input = z.object(spec.inputSchema).parse(args ?? {});
    return await spec.handler(input, { sessionId });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 带审批的派发 —— 给**没有工具守卫**的引擎(Codex 动态工具)用。
 *
 * @param autoApprove 调用方按自己的权限模式算出的「这一档是否全放行」(Codex:完全访问且
 *   不在计划模式)。只读工具不看它,永远直接跑。
 *
 * 没有审批通道时**拒绝**而不是放行:库写操作(删条目、改名、移动)不可静默发生,
 * 与 Codex `decideApproval` 的「No bridge — deny safe」同一取向。
 */
export async function invokeLibraryToolGated(
  name: string,
  args: unknown,
  sessionId: string,
  ctx: ProviderContext,
  opts: { autoApprove: boolean },
): Promise<ToolResult> {
  let input = args;
  if (!isLibraryReadonlyTool(name) && !opts.autoApprove && !(ctx.isToolAlwaysAllowed?.(name) ?? false)) {
    if (!ctx.requestApproval) return fail("资料库写操作需要用户批准,但审批通道不可用;没有做任何修改。");
    const decision = await ctx.requestApproval({ requestId: randomUUID(), toolName: name, input: args });
    if (!decision.allow) return fail(decision.reason ? `用户未批准这次资料库修改:${decision.reason}` : "用户未批准这次资料库修改。");
    if (decision.updatedInput !== undefined) input = decision.updatedInput;
  }
  return invokeLibraryTool(name, input, sessionId);
}
