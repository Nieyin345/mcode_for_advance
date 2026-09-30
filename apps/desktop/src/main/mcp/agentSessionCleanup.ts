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
