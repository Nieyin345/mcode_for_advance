/**
 * `agent_*` 工具里**只读那一小撮**的跨引擎桥 —— 让 Claude / Pi / Codex 的**桌面**会话
 * 也能用统一的文档读取（`agent_read_document` 读 PDF/DOCX/XLSX/PPTX、`agent_read_image`、
 * `agent_context` 项目/资料库概况）。
 *
 * ## 为什么只桥这几个，不桥整张表
 *
 * `mcp/agentTools.ts` 那一整套文件/进程/SSH 工具是**给网页那条路**建的（文件头写明：
 * "只进 webToolHost 那张表，不注册给桌面三引擎"）。桌面三家各有自己的原生工具链（Claude
 * 的 Read/Bash、Pi 的 read/bash、Codex 的壳命令），再挂一整套只会重名打架。
 *
 * 但**统一的文档读取**是个例外：三家原生 Read 都不处理 Office（DOCX/XLSX/PPTX），桌面用户
 * 想"读一下这份 docx"时，三个引擎各自落空。把它桥过来，正好落实"基础工具统一"。
 *
 * ## 安全边界（这是本桥存在的**前提**）
 *
 * 只桥 **{@link AGENT_ENGINE_READONLY}** 里那几个 —— 它们全在 `AGENT_READONLY_TOOLS`
 * 里（任何权限模式都放行，改不了任何东西）。**绝不**桥写文件 / bash / SSH / 进程 /
 * 后台搜索那些：桌面已经能用「引擎工具」页关掉原生工具了，不需要再从这里开一个绕审批的
 * 口子。表里若出现非只读名字，{@link agentEngineReadonlySpecs} 会**跳过**并告警，而不是
 * 悄悄放行 —— 坏东西显式报出来。
 *
 * 纯模块：只依赖 `./agentTools.js`（那张表本身是无状态纯构造）与 `./engineBridge.js`。
 */
import type { ProviderContext } from "@contracts/provider";
import { agentMcpTools, AGENT_MCP_SERVER, AGENT_READONLY_TOOLS, type AgentToolsDeps } from "@main/mcp/agentTools.js";
import { makeEngineBridge, type EngineToolDescriptor } from "@main/mcp/engineBridge.js";
import { agentEngineCwdFor } from "@main/mcp/agentEngineCwd.js";
import type { McpToolSpec, ToolResult } from "@main/mcp/sdk.js";
import { loadCreateMcpServer, toSdkTools } from "@main/mcp/sdk.js";
import { log } from "@main/lib/logger.js";

/**
 * 桥给桌面引擎的 agent 工具 —— **只有这几个**。
 *
 * 挑它们的理由：
 *   - `agent_read_document`：统一读 PDF / DOCX / XLSX / PPTX（PDF 走 pdfjs，Office 走
 *     pandoc/Python），是三家原生 Read 都缺的那一块；
 *   - `agent_read_image`：统一读图片（原生各家视模型而定）；
 *   - `agent_context`：一次问清"当前项目 / 资料库有哪些条目"，省去模型用 bash 猜。
 *
 * 都必须在 `AGENT_READONLY_TOOLS` 里（下面有断言）。
 */
export const AGENT_ENGINE_READONLY: readonly string[] = [
  "agent_read_document",
  "agent_read_image",
  "agent_context",
];

/** 桌面会话没有沙箱（不套 `sandboxRootFor`）—— 与 claude 引擎原有自由度一致。 */
export interface AgentEngineDeps {
  /** 会话 id → 工作目录（相对路径解析基准）。 */
  cwdFor(sessionId: string): string | null;
}

/**
 * 只取 {@link AGENT_ENGINE_READONLY} 里、且确实是只读的那些 spec。
 * 任何一个不在只读集里 → 跳过并**告警**（绝不静默放行写工具）。
 */
export function agentEngineReadonlySpecs(deps: AgentEngineDeps): McpToolSpec[] {
  const all = agentMcpTools({
    cwdFor: deps.cwdFor,
    // 桌面本机会话不设沙箱（同 claude 引擎原有行为）。公网那条路自己有 sandboxRootFor。
    sandboxRootFor: () => null,
  });
  const byName = new Map(all.map((s) => [s.name, s]));
  const out: McpToolSpec[] = [];
  for (const name of AGENT_ENGINE_READONLY) {
    if (!AGENT_READONLY_TOOLS.has(name)) {
      log.warn(`agentEngineBridge: 「${name}」不在 AGENT_READONLY_TOOLS 里，拒绝桥给桌面引擎`);
      continue;
    }
    const spec = byName.get(name);
    if (spec) out.push(spec);
  }
  return out;
}

const bridge = makeEngineBridge("agent", () => agentEngineReadonlySpecs(bridgeDeps), AGENT_READONLY_TOOLS);

/**
 * `makeEngineBridge` 的 `specs()` 取法没有 session 参数，而 `agentMcpTools` 的 deps 需要
 * `cwdFor`。登记表本身在 {@link ./agentEngineCwd.js} —— 单独一个零依赖模块，好让
 * 「删会话后登记真的被摘掉」能被无头套件直接验（桥这份 import 图带 `ssh2`，套件打不动）。
 *
 * 取不到（会话没登记）→ `cwdFor` 返回 null，`agent_*` 会拒绝相对路径并提示用绝对路径 ——
 * 这是既有语义，不是本桥引入的新行为。
 */
const bridgeDeps: AgentEngineDeps = {
  cwdFor: (sessionId) => agentEngineCwdFor(sessionId),
};

// 重新导出：三个 provider 与桥的调用方一直从 `agentEngineBridge` 取这个函数。
export { registerAgentEngineSession } from "@main/mcp/agentEngineCwd.js";

export function isAgentToolName(name: string): boolean {
  return AGENT_ENGINE_READONLY.includes(name);
}

export function isAgentReadonlyTool(name: string): boolean {
  return AGENT_READONLY_TOOLS.has(name);
}

export function agentToolDescriptors(): EngineToolDescriptor[] {
  return bridge.descriptors();
}

/**
 * Claude 那条路用的**进程内 MCP server**（Claude 有 in-process MCP，另两家没有，走上面的
 * descriptors/invoke）。名字用 `mcode-agent-tools` —— `mcode-agent-` 前缀同时被
 * `isReservedMcpServerName` 挡在用户/项目可注册名之外（内置身份）。
 *
 * ⚠️ **别名,不是第二个字面量。** `toolRules` 的只读索引按 {@link AGENT_MCP_SERVER} 建键,
 * 而这里是实际注册给 SDK 的名字 —— 两处写着不同的字符串时,那三个只读工具的全名
 * (`mcp__<server>__agent_read_*`)在索引里查不到,于是"任何权限模式都不需要审批"落空:
 * default 档每读一份 PDF 都弹卡,dontAsk 档直接拒。同一个事实只留一份(硬规矩 2)。
 */
export const AGENT_ENGINE_MCP_SERVER = AGENT_MCP_SERVER;

export async function buildAgentEngineMcpServer(opts: { sessionId: string }) {
  const createSdkMcpServer = await loadCreateMcpServer();
  return createSdkMcpServer({
    name: AGENT_ENGINE_MCP_SERVER,
    version: "1.0.0",
    instructions:
      "统一的文档/图片读取与环境概况工具。读 PDF/DOCX/XLSX/PPTX 用 agent_read_document，" +
      "读图片用 agent_read_image，想一次问清当前项目与资料库有哪些条目用 agent_context。" +
      "它们是只读的，任何权限模式都不需要审批。",
    alwaysLoad: true,
    tools: toSdkTools(agentEngineReadonlySpecs(bridgeDeps), { sessionId: opts.sessionId }),
  });
}

/** 不带审批的派发 —— 给 Pi（它注册的工具天然经过 `tool_call` 守卫）。 */
export function invokeAgentTool(name: string, args: unknown, sessionId: string): Promise<ToolResult> {
  return bridge.invoke(name, args, sessionId);
}

/** 带审批的派发 —— 给 Codex（动态工具没有守卫）。只读工具在 `invokeGated` 里直接过。 */
export function invokeAgentToolGated(
  name: string,
  args: unknown,
  sessionId: string,
  ctx: ProviderContext,
  opts: { autoApprove: boolean },
): Promise<ToolResult> {
  return bridge.invokeGated(name, args, sessionId, ctx, opts);
}
