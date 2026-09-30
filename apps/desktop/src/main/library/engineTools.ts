/**
 * 资料库工具的**跨引擎桥** —— 让 Pi / Codex 也拿到 `mcode-library` 那一套工具。
 *
 * 库工具(`libraryMcpTools()`)原来只经进程内 MCP server 挂在 Claude 上。Pi 与 Codex 没有
 * 进程内 MCP,于是在那两个引擎下 `library_search` / `library_import_files` /
 * `library_attach_pdf` / `library_adopt_markdown` / `library_write_note` 全都不存在 ——
 * 内置工作流(文献检索的「判断并入库」、文献导入、转录挂回)照指令去调就落空(2026-09-30)。
 *
 * 通用部分(描述符、zod 校验、审批语义)在 `mcp/engineBridge.ts`;这里只给出「哪张表 +
 * 哪些只读」,并保留原来的具名导出。
 */
import type { ProviderContext } from "@contracts/provider";
import { libraryMcpTools, LIBRARY_READONLY_TOOLS } from "@main/mcp/libraryServer.js";
import { makeEngineBridge, type EngineToolDescriptor } from "@main/mcp/engineBridge.js";
import type { ToolResult } from "@main/mcp/sdk.js";

const bridge = makeEngineBridge("资料库", libraryMcpTools, LIBRARY_READONLY_TOOLS);

/** 库工具一律 `library_` 开头(见 `toolRules.isReadOnlyToolName` 那段命名约定)。 */
export function isLibraryToolName(name: string): boolean {
  return name.startsWith("library_");
}

export function isLibraryReadonlyTool(name: string): boolean {
  return bridge.isReadonly(name);
}

export function libraryToolDescriptors(): EngineToolDescriptor[] {
  return bridge.descriptors();
}

/** 按名字派发一次库工具。**不做审批**(Pi 由 tool_call 守卫负责)。 */
export function invokeLibraryTool(name: string, args: unknown, sessionId: string): Promise<ToolResult> {
  return bridge.invoke(name, args, sessionId);
}

/** 带审批的派发 —— 给**没有工具守卫**的引擎(Codex 动态工具)用。 */
export function invokeLibraryToolGated(
  name: string,
  args: unknown,
  sessionId: string,
  ctx: ProviderContext,
  opts: { autoApprove: boolean },
): Promise<ToolResult> {
  return bridge.invokeGated(name, args, sessionId, ctx, opts);
}
