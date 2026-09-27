/**
 * 把一段对话复制成新的一段 —— 「右键左栏的对话 → 复制一份」背后那件事。
 *
 * ## 两件事,顺序不能反
 *
 * 1. **先在引擎那边复制上下文**(Claude 是 SDK 的 `forkSession`:把会话文件抄一份、
 *    消息 UUID 全部重编),拿到新的引擎侧会话 id;
 * 2. **再建 Mcode 这一侧的会话行**,把消息行抄过去,`claudeSessionId` 直接写上第 1 步
 *    拿到的那个。
 *
 * 反过来的话,第 1 步失败时第 2 步建出来的行会**留在库里** —— 一段看起来有历史、而
 * 模型那边是空的对话。那比直接报个错糟得多,所以这里让它在失败时什么都不留下。
 *
 * ## 为什么单独一个模块
 *
 * 和 `sessionStart.ts` 同一个理由:这段逻辑要能在没有 Electron 的环境里跑起来
 * (`scripts/session-fork-smoke`)—— 而"顺序反了会留下半成品""消息 id 必须重编"这两条
 * 都是**看代码看不出来**的错,只有真建一次才知道。IPC 那一层只负责解析参数。
 */
import { SessionRepo, ProjectRepo, MessageRepo } from "@main/store/repositories.js";
import { providerRegistry } from "@main/providers/registry.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";
import { uid } from "@main/utils.js";
import type { Session } from "@contracts/session";

/**
 * 复制一段对话。返回新建的那一行。
 *
 * 失败时**抛**,而且库里不会多出任何东西(见文件头)。
 */
export async function forkSession(sourceId: string, title: string): Promise<Session> {
  const source = SessionRepo.get(sourceId);
  if (!source) throw new Error(`fork: unknown session ${sourceId}`);
  const project = ProjectRepo.get(source.projectId);
  if (!project) throw new Error(`fork: unknown project ${source.projectId}`);

  // 会话文件是按**跑在哪个目录**分开放的,所以要拿源会话当时那个目录去找 —— 这里用
  // 读出来的路径、**不调 `resolveSessionCwd`**:那个函数会顺手把还没落地的 worktree
  // 建出来,而"复制一段对话"不该有那种副作用。
  const cwd = source.worktreePath ?? project.path;

  let providerSessionId: string | null = null;
  if (source.claudeSessionId) {
    const provider = providerRegistry.resolve(source.providerId);
    if (!provider.forkSession) {
      throw new Error(`引擎 ${source.providerId} 不支持复制对话(它没法把上下文交出去)`);
    }
    // 引擎那边的失败**在这里落一行日志再往上抛**。渲染端只拿得到一句
    // "Error invoking remote method 'session:for…"(Electron 把真实原因截掉了),
    // 而这一句背后可能是"会话文件不在这台机器上""这段对话一条消息都没有""引擎
    // 的配置根找错了"—— 三种都得看 main.log 才知道是哪种。
    try {
      providerSessionId = await provider.forkSession(source.claudeSessionId, { cwd, title });
    } catch (err) {
      log.error(
        `session fork failed at provider: ${source.id} (provider=${source.providerId}, ` +
          `cli session=${source.claudeSessionId}, cwd=${cwd}): ${(err as Error).message}`,
      );
      throw err;
    }
  }

  const now = Date.now();
  const fork: Session = {
    ...source,
    id: uid("sess_"),
    // **必须指向第 1 步新复制出来的那一段**,不是源那一段 —— 指向源的话,两个会话会
    // 抢着写同一个会话文件。
    claudeSessionId: providerSessionId,
    title,
    // A fork has no in-flight turn or pending approval of its own, even when
    // the source snapshot was captured while active.
    status: "idle",
    // 新开的一段不该一出生就钉在最上面,也不该落在归档里。
    archived: false,
    pinnedAt: null,
    // 用量是"这一段对话花了多少",属于会话自己的账 —— 带过来的话,新对话一打开就
    // 顶着一笔它没花过的钱。
    usageHistory: null,
    createdAt: now,
    updatedAt: now,
  };
  SessionRepo.create(fork);

  const { messages } = MessageRepo.listBySession(source.id);
  if (messages.length > 0) {
    MessageRepo.replaceAll(
      fork.id,
      // 消息 id 必须**重新生成** —— 它是主键,照抄会撞上源那一行。而且那两行本来就该
      // 是两条独立的记录:删掉源对话不该动到分叉出去的这一段。
      messages.map((m) => ({ ...m, id: uid("msg_"), sessionId: fork.id })),
    );
  }

  broadcastSessionChanged(fork);
  log.info(
    `session forked: ${source.id} -> ${fork.id} (${messages.length} messages${
      providerSessionId ? `, provider session ${providerSessionId}` : ", no provider session yet"
    })`,
  );
  return fork;
}
