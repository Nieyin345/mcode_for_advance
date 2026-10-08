/**
 * 会话收场时释放 agent 工具占着的东西(持久进程 / 后台搜索 / SSH 连接)。
 *
 * 三个管理器(`agentProcessSessions` / `agentSearchSessions` / `agentRemoteSsh`)是
 * `agentMcpTools()` 里建的进程级单例,按 `ownerSessionId` 分桶;它们各自在这里登记
 * 一个"按会话释放"的函数,会话**真正没了**的地方(`lib/rowDeletion.ts`:删会话、删项目)
 * 调 {@link disposeAgentSession}。没有这一步时:进程要熬到自己的超时才死,搜索要等
 * 下一次 start/list 才被动回收,而 SSH 连接带 keepalive + 自动重连,对话删了还会
 * 一直连下去(审计 OBS-M14-01)。
 *
 * ⚠️ 不挂在 `RuntimeManager.dispose` 上:那条路也被"换引擎 / 节点卡死重来"调用,
 * 对话还要继续,不能顺手杀掉它正在用的进程和连接。
 *
 * 刻意零依赖:调用方(rowDeletion)在好几套冒烟里按别名装配,这里不能把
 * `agentTools.ts` 那张大 import 图带过去。
 */

type AgentSessionDisposer = (sessionId: string) => void;

const disposers = new Set<AgentSessionDisposer>();

/** 登记一个按会话释放的函数;返回注销函数。 */
export function registerAgentSessionDisposer(fn: AgentSessionDisposer): () => void {
  disposers.add(fn);
  return () => {
    disposers.delete(fn);
  };
}

const shutdownHooks = new Set<() => void>();

/** 登记一个「应用退出时」的清理函数(杀掉还在跑的后台进程等);返回注销函数。 */
export function registerAgentShutdownHook(fn: () => void): () => void {
  shutdownHooks.add(fn);
  return () => {
    shutdownHooks.delete(fn);
  };
}

/**
 * 应用退出时调用(`index.ts` 的 `before-quit`)。
 *
 * agent 用 `agent_process_start` 起的后台进程(`npm run dev` 之类,最长可跑 60 分钟)
 * 不会随应用一起死:类 Unix 上它们是独立进程组(`TREE_KILLABLE` 的 `detached`),
 * Windows 上子进程本来就不随父进程退出。不在这里杀,关掉 Mcode 后端口还被占着。
 */
export function disposeAllAgentResources(): void {
  for (const fn of shutdownHooks) {
    try {
      fn();
    } catch (err) {
      console.warn(`disposeAllAgentResources failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 释放该会话名下所有 agent 工具资源。单个管理器出错不影响其余几个,也不抛给调用方
 *  (调用方正走在删除流程里,不能因为清理失败半途而废)。 */
export function disposeAgentSession(sessionId: string): void {
  for (const fn of disposers) {
    try {
      fn(sessionId);
    } catch (err) {
      console.warn(`disposeAgentSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * 测试用:当前登记了几条按会话释放 / 退出清理。
 *
 * 「登记一次就够」这件事没有别的观察点 —— 这两张表是模块私有的,重复登记的代价
 * (闭包各自捕着三张管理器)从外面看不见。冒烟据它断言"重复取工具表不会一直往上堆"。
 */
export function __registeredDisposerCount(): number {
  return disposers.size;
}
export function __registeredShutdownHookCount(): number {
  return shutdownHooks.size;
}
