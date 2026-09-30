/**
 * 工作流工具(`mcode-workflow`)的**跨引擎桥** —— 让 Pi / Codex 也能看、建、改工作流 /
 * 节点类型 / 代理档案,读对话记录,以及代理间通信(`agent_peers` / `agent_notify` /
 * `agent_ask`)。
 *
 * 原来这一套只经进程内 MCP 挂在 Claude 上(2026-09-30 之前)。`agent_ask` **不阻塞**
 * (发完这一轮照常结束,答复到了宿主回头叫醒提问方,见 mcodeServer 里它的说明),所以放进
 * Codex 的动态工具没有「一直等」的风险;收信一侧 Pi / Codex 早就走排队那条路。
 *
 * 审批:`WORKFLOW_READONLY_TOOLS` 免问,其余(存 / 删工作流、写节点类型、`session_list`、
 * `agent_notify` / `agent_ask`)照常要用户点头 —— 与 Claude 同一份清单。通用部分见
 * `mcp/engineBridge.ts`。
 */
import { workflowMcpTools, WORKFLOW_READONLY_TOOLS } from "./mcodeServer.js";
import { makeEngineBridge } from "./engineBridge.js";

/** 本机引擎用完整的一套(含对话记录与代理通信);公网那条路不走这里。 */
export const workflowEngineBridge = makeEngineBridge("工作流", () => workflowMcpTools(), WORKFLOW_READONLY_TOOLS);
