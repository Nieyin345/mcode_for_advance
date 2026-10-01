/**
 * **mcode-app** 进程内 MCP server(Claude 引擎用)—— 让 agent 完全控制 Mcode。
 * 工具表与审批都在 `main/appControl/tools.ts`;这里只是把它包成 SDK server。
 * Claude 的 canUseTool 对 `mcp__mcode-app__*` 直接放行(与记忆工具同理):
 * 同一个 `app_api_call` 读设置和删项目是两回事,只有 handler 看得到参数。
 */
import type { ProviderContext } from "@contracts/provider";
import { APP_MCP_SERVER } from "@contracts/appControl";
import { loadCreateMcpServer, toSdkTools } from "./sdk.js";

export async function buildAppMcpServer(opts: { sessionId: string; context?: ProviderContext }) {
  const createSdkMcpServer = await loadCreateMcpServer();
  const { appMcpTools, invokeAppTool } = await import("@main/appControl/tools.js");
  return createSdkMcpServer({
    name: APP_MCP_SERVER,
    version: "1.0.0",
    instructions:
      "控制 Mcode 软件本身的工具 —— 界面上能做的事,这里基本都能做。\n" +
      "- 找功能:app_api_list(不带参数看功能域)→ app_api_describe 看参数 → app_api_call 调用;\n" +
      "- 界面:app_ui_state 看当前状态,app_ui 切对话/开文件/开设置/开面板/弹提示/改界面偏好;\n" +
      "- 对话:app_session_new 开新对话(可带第一条消息),app_session_send 给别的对话发消息;\n" +
      "- 工作流:app_workflow_run 立即运行。\n" +
      "只读和纯界面操作自动执行;有副作用的弹审批卡;高风险(装插件/MCP/钩子、删项目、改密钥、" +
      "开公网、改权限……)每次都要用户本人批准;替用户批准审批、读 API Key 等不开放。" +
      "用户没要求的高风险操作不要主动去做。",
    tools: toSdkTools(
      appMcpTools().map((spec) => ({
        ...spec,
        handler: (args: unknown) => invokeAppTool(spec.name, args, opts.sessionId, opts.context ?? ({} as ProviderContext)),
      })),
      { sessionId: opts.sessionId },
    ),
  });
}
