/**
 * **Agent 记忆访问作用域**(MC-092)—— 宿主铸造的可信会话身份,绝不由模型参数填写。
 *
 * ## 它补的洞
 *
 * 专用记忆工具(`memory_write` 等 MCP 工具)走 `memory/access.ts` 的 `requireMemoryAccess`,
 * 按**会话所属项目**过滤作用域。但另一条路 —— 通用业务接口 `app_api_call { method: "memory.save", … }`
 * —— 直接调 IPC handler,**没有等价的项目隔离**:模型可以带 `projects/<别的项目>/…` 的路径
 * 读写任意项目的记忆,或 `list` 出所有项目的记忆。三引擎共用这条通用工具,所以不能指望
 * 「模型会选对工具」—— 授权必须绑在所有入口上。
 *
 * ## 为什么用 `AsyncLocalStorage` 而不是全局变量
 *
 * 节点/会话是**并发**跑的(`executionEngine`/`automationEventOrigin` 同款理由):一个模块级
 * 变量会把 A 会话的项目身份泄给同时跑着的 B。`AsyncLocalStorage` 让作用域只在这个调用链里
 * 生效,`callRpc` 一返回就没了 —— 执行点(记忆 handler)拿到的永远是**这次调用**的身份。
 *
 * ## 两种消费者
 *
 * - **桌面用户**(渲染端经真实 IPC 调 `memory.*`,不经 `app_api_call`):无作用域 →
 *   `agentMemoryScope()` 返回 `undefined` → 保留全局管理权限(用户本来就能管全部记忆)。
 * - **Agent**(经 `app_api_call`):`tools.ts` 在 `callRpc` 外层 `runWithAgentMemoryScope
 *   (session.projectId, …)` → 记忆 handler 见到作用域就**逐入口**限制到该项目 + 全局。
 *
 * ⚠️ 身份**只能由宿主产生**:作用域值来自 `SessionRepo.get(sessionId).projectId`(宿主事实),
 * 不从 `args` 里读任何东西 —— 否则模型自己填一个 `projectId` 就绕过去了。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { SessionRepo } from "@main/store/repositories.js";
import { MEMORY_PROJECT_ID } from "./paths.js";

interface AgentMemoryScope {
  /** 会话所属项目 id(宿主解析,不是模型给的)。 */
  projectId: string;
}

const storage = new AsyncLocalStorage<AgentMemoryScope>();

/** 当前调用链是否处在 agent 记忆作用域里;在则返回其项目 id,否则 `undefined`。 */
export function currentAgentMemoryProjectId(): string | undefined {
  return storage.getStore()?.projectId;
}

/**
 * 在给定的项目身份下跑一段调用(agent 经 `app_api_call` 调 `memory.*` 时由 `tools.ts` 包上)。
 * 作用域随异步链传播,`fn` 一返回即消失。
 */
export function runWithAgentMemoryScope<T>(projectId: string, fn: () => T): T {
  return storage.run({ projectId }, fn);
}

/**
 * 从会话 id 解析出项目身份并跑 `fn`;会话没有有效项目 id 时**拒绝**(不静默降级成全权限)。
 *
 * @throws 会话不存在 / 项目 id 形状不合法 —— 记不清属于谁时,记忆访问必须 fail-closed。
 */
export function runWithAgentMemoryScopeForSession<T>(sessionId: string, fn: () => T): T {
  const session = SessionRepo.get(sessionId);
  const projectId = session?.projectId;
  if (typeof projectId !== "string" || !MEMORY_PROJECT_ID.test(projectId)) {
    throw new Error("这次调用没有可用的宿主会话项目身份,拒绝访问记忆。");
  }
  return storage.run({ projectId }, fn);
}
