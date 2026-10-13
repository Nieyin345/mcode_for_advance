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
  /** 会话 id(宿主给的)。项目身份**延迟**到真正需要时再解析 —— 见下。 */
  sessionId: string;
}

const storage = new AsyncLocalStorage<AgentMemoryScope>();

/**
 * 当前调用链是否处在 agent 记忆作用域里;在则返回其**会话所属项目 id**,否则 `undefined`。
 *
 * ⚠️ **身份在这里才解析**(而不是装作用域时):装作用域的 `tools.ts` 那条路对**任何**
 * `memory.*` 调用都包一层,而有些调用(如被 smoke 换桩的 handler)根本不会走到读记忆那一步
 * —— 那时去查库既无意义又可能撞上未初始化的库。真正要判作用域的是**执行点**(记忆 handler),
 * 所以解析收在这里:只有真的读/写/列记忆时才查 `SessionRepo`,那才是"该保守拒绝"的时刻。
 *
 * 会话不存在 / 项目 id 形状不合法 → **抛错**(fail-closed,不降级成全权限)。
 */
export function currentAgentMemoryProjectId(): string | undefined {
  const scope = storage.getStore();
  if (scope === undefined) return undefined; // 桌面用户(无作用域):全局管理权限。
  const session = SessionRepo.get(scope.sessionId);
  const projectId = session?.projectId;
  if (typeof projectId !== "string" || !MEMORY_PROJECT_ID.test(projectId)) {
    throw new Error("这次调用没有可用的宿主会话项目身份,拒绝访问记忆。");
  }
  return projectId;
}

/**
 * 在给定的项目身份下跑一段调用(agent 经 `app_api_call` 调 `memory.*` 时由 `tools.ts` 包上)。
 * 作用域随异步链传播,`fn` 一返回即消失。**只记会话 id**,项目身份延迟到执行点解析。
 */
export function runWithAgentMemoryScopeForSession<T>(sessionId: string, fn: () => T): T {
  return storage.run({ sessionId }, fn);
}

/* ═══════════════════ 扩展数据区访问作用域(MC-095)—— 同一个机制 ═══════════════════
 *
 * 与上面的记忆作用域**共用同一套机制**(宿主铸造、`AsyncLocalStorage`、`tools.ts` 装、
 * handler 查),只是带的是**扩展身份**(`extensionId`),作用的执行点是六条
 * `extensionStore.*` handler。**再写一个独立的作用域模块**才是"第二套"——这里不另起。
 *
 * ## 它补的洞
 *
 * 六条 `extensionStore.*` RPC 都接受请求者自填的 `extensionId`,主进程 handler 从前不绑
 * 调用主体。Agent 经通用 `app_api_call` 填 `extensionId:"别人的扩展"` 就能读 / 写另一个
 * 扩展的键值与文件(复核 E1:`foreignKv=PRIVATE_A_ONLY`)—— handler 一点都不知道这是谁在调。
 *
 * ## 语义(与记忆**相反**的一处:桌面直连**没有**作用域 = 保留)
 *
 * - **桌面渲染端直连**(`panelBridge` 的 `storage.*` / `extension.*`,经真实 IPC 不经这里):
 *   无作用域 → handler 保留「任意 id」权限。桥已用 `host.item.id` 自绑(面板脚本在沙箱
 *   iframe 里够不到 `window.api`,只能经桥),所以渲染端是可信的。
 * - **Agent 经 `app_api_call` / 面板经 `api.call`**:`tools.ts` 在 `callRpc` 外层装作用域。
 *   作用域带**宿主铸造**的可达扩展 id;**缺 id**(= 代理型通用调用,没有扩展身份)→
 *   handler **一律拒**。这是 fail-closed:模型不能靠自填 id 越到别的扩展。
 *
 * ⚠️ 身份**只能宿主产生**:作用域里的 id 由宿主代码放进去,绝不从 `args` 里读 —— 否则
 * 模型自己填一个 `extensionId` 就绕过去了。
 */

/** 一次通用/面板调用的扩展身份:`extensionId` 缺省 = 代理型调用,**没有**可访问的扩展。 */
interface AgentExtensionScope {
  extensionId?: string;
}

const extensionStorage = new AsyncLocalStorage<AgentExtensionScope>();

/**
 * 当前调用链是否处在扩展访问作用域里。
 *   - `undefined` = **没有作用域**(桌面渲染端直连)→ handler 保留「任意 id」(桥自绑)。
 *   - `{ extensionId }` = 通用通道调用,只许访问 `extensionId`(`undefined` = 无身份 → 全拒)。
 */
export function currentAgentExtensionScope(): AgentExtensionScope | undefined {
  return extensionStorage.getStore();
}

/**
 * 装「代理型通用调用」作用域:**没有**扩展身份。`extensionStore.*` 借用它的判据 → 一律拒。
 * Agent 经通用 `app_api_call` 调 `extensionStore.*` 时由 `tools.ts` 包上(除非宿主已为本
 * 调用链铸过身份,见 `tools.ts` 的注释)。
 */
export function runWithUnboundAgentExtensionScope<T>(fn: () => T): T {
  return extensionStorage.run({}, fn);
}

/**
 * 装「代表某个扩展」的作用域(宿主铸造的可达 id)—— 只许访问该扩展的数据区。
 * 供宿主为「代某扩展行事」的调用链铸身份(当前生产无此调用点;公开给断言做正控)。
 */
export function runWithAgentExtensionScopeForExtension<T>(extensionId: string, fn: () => T): T {
  return extensionStorage.run({ extensionId }, fn);
}

/**
 * 该 `extensionStore.*` 调用能不能访问 `extensionId` 的数据区 —— 不能则返回**拒绝理由**
 * (原样给模型 / 面板);能则 `null`。判据只有这一份,六条 handler 共用。
 *
 * 无作用域(桌面直连)= 放行;有作用域但身份对不上(含无身份)= 拒。
 */
export function extensionAccessRefusal(extensionId: string): string | null {
  const scope = extensionStorage.getStore();
  if (scope === undefined) return null; // 桌面渲染端直连:桥已自绑 id,保留。
  if (scope.extensionId === extensionId) return null; // 代表这个扩展行事:放行。
  return "这次调用没有被授予访问该扩展数据区的权限(通用调用未绑定可信扩展身份);扩展只能访问自己的数据区。";
}
