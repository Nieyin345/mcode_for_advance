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
 * ## 第 2 步自己也必须是**一个事务**(MC-027)
 *
 * 第 1 步(引擎复制上下文)只保证了"引擎失败前本地不落任何东西"。而第 2 步从前是
 * 先 `SessionRepo.create(fork)`、再 `MessageRepo.replaceAll(fork.id, …)` —— 后者自带事务
 * 但**不含**前者。于是"会话行建出来了、消息写到一半失败"会留下一段**空壳/半截**对话:
 * 文件头宣称的"失败时数据库不会多出任何东西"在那条路上是假的。
 *
 * 现在两件事走**同一个 `BEGIN`/`COMMIT`**(见 {@link createForkedSession}):会话行与它
 * 的全部消息要么一起落库,要么一起回滚。跨模块的 {@link providerRegistry} / {@link uid}
 * 照旧,只是写库那一步自己开了事务 —— **不改 repositories.ts**(它属于另一个 lane;
 * `MessageRepo` 的 ID 必须重编、书签要按 idMap 重映射,这些只有本模块知道)。
 * 注:与外部引擎会话绑定的失败回收(补偿清理 / 记 orphan)仍是后续工作 —— 这里先保证
 * **本地库**这条不变量。
 *
 * ## 为什么单独一个模块
 *
 * 和 `sessionStart.ts` 同一个理由:这段逻辑要能在没有 Electron 的环境里跑起来
 * (`scripts/session-fork-smoke`)—— 而"顺序反了会留下半成品""消息 id 必须重编"这两条
 * 都是**看代码看不出来**的错,只有真建一次才知道。IPC 那一层只负责解析参数。
 */
import { SessionRepo, ProjectRepo, MessageRepo } from "@main/store/repositories.js";
import { getDb, persist } from "@main/store/db.js";
import { v, SESSION_COLUMNS } from "@main/store/sessionSchema.js";
import { providerRegistry } from "@main/providers/registry.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";
import { uid } from "@main/utils.js";
import type { Session } from "@contracts/session";

/**
 * 在一个事务里写入新会话行 + 它的全部消息。任一步抛错 → ROLLBACK,库里**一行都不留**
 * (MC-027:从前 `SessionRepo.create` 与 `MessageRepo.replaceAll` 是两段独立事务,后者失败
 * 会留下一个没有消息的空壳)。
 *
 * 语句与 `SessionRepo.create` / `MessageRepo.replaceAll` **逐字一致** —— 只是把两段各自
 * 的 `BEGIN/COMMIT` 合成一段。列名 / 占位符 / 绑定值仍由 `SESSION_COLUMNS` 生成(与
 * {@link SessionRepo} 同一份单一事实来源),内容绑定也与 `replaceAll` 的 `JSON.stringify`
 * 同形,所以不走公共函数也不会漂移。
 */
function createForkedSession(fork: Session, messages: ReadonlyArray<{ id: string; sessionId: string; role: string; content: unknown; createdAt: number }>): void {
  const db = getDb();
  db.run("BEGIN");
  try {
    const cols = SESSION_COLUMNS.map((c) => c.name).join(", ");
    const marks = SESSION_COLUMNS.map(() => "?").join(", ");
    db.run(
      `INSERT INTO sessions (${cols}) VALUES (${marks})`,
      SESSION_COLUMNS.map((c) => c.bind(fork)),
    );
    if (messages.length > 0) {
      const stmt = db.prepare(
        "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const m of messages) {
        stmt.run([v(m.id), v(m.sessionId), v(m.role), v(JSON.stringify(m.content)), v(m.createdAt)]);
      }
      stmt.free();
    }
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  persist();
}

/**
 * 复制一段对话。返回新建的那一行。
 *
 * 失败时**抛**,而且库里不会多出任何东西(见文件头)。
 */
export async function forkSession(sourceId: string, title: string): Promise<Session> {
  const source = SessionRepo.get(sourceId);
  // 文案是**用户看得到的那个 toast 正文**(标题走 i18n,这行原样进 body)。中文。
  if (!source) throw new Error(`要复制的对话已经不在了:${sourceId}`);
  const project = ProjectRepo.get(source.projectId);
  if (!project) throw new Error(`这段对话所属的项目已经不在了:${source.projectId}`);

  // 会话文件是按**跑在哪个目录**分开放的,所以要拿源会话当时那个目录去找 —— 这里用
  // 读出来的路径、**不调 `resolveSessionCwd`**:那个函数会顺手把还没落地的 worktree
  // 建出来,而"复制一段对话"不该有那种副作用。
  const cwd = source.worktreePath ?? project.path;

  let providerSessionId: string | null = null;
  if (source.claudeSessionId) {
    // 【MC-056】复制对话必须用**源会话记的那个引擎**；取不到就明确拒绝，不静默回退默认。
    // 从前 `resolve(source.providerId)` 在引擎被卸/存值失效时悄悄返回默认(claude-sdk)，
    // 于是一段 pi-sdk 的历史被当成 Claude 会话去 fork —— 底层会话文件格式根本对不上，
    // 而且用户以为复制的是原引擎的上下文。
    const provider = providerRegistry.getRequired(source.providerId);
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
  // 源的消息先读出来,好把书签按 **旧 id → 新 id** 重映射(见下)。
  const { messages } = MessageRepo.listBySession(source.id);
  const idMap = new Map<string, string>();
  const copiedMessages = messages.map((m) => {
    const id = uid("msg_");
    idMap.set(m.id, id);
    return { ...m, id, sessionId: "" }; // sessionId 下面 replaceAll 时按 fork.id 归一
  });

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
    // ⚠️ **本轮的临时态不带过去。** `...source` 会把上一轮的 `turnFiles`(那个"本轮修改"
    // 卡片)与 `planDraft` 原样抄给分叉 —— 而它们描述的是**源对话上一步的动作**,不是分叉
    // 这一段的。尤其 `turnFiles` 的 rewind 会写进共享的 worktree,点一下就把源对话上一轮
    // 的改动撤了(而分叉自己什么也没做)。`status`/`usageHistory` 那几项已在这里重置,
    // 这几项同理。
    turnFiles: null,
    planDraft: null,
    // ★ **书签跟着消息 id 重映射。** 书签锚在**消息 id** 上,而上面每个 id 都重生成 ——
    // 不重映射的话,分叉出去的每一个书签都指向源对话里那条(在分叉里根本不存在)的消息,
    // 渲染端一律判成 stale、跳不过去。锚不到任何一条的丢弃。
    bookmarks: source.bookmarks && source.bookmarks.length > 0
      ? (() => {
          const remapped = source.bookmarks
            .map((b) => {
              const mapped = idMap.get(b.messageId);
              return mapped ? { ...b, messageId: mapped } : null;
            })
            .filter((b): b is NonNullable<typeof b> => b !== null);
          return remapped.length > 0 ? remapped : null;
        })()
      : source.bookmarks,
    createdAt: now,
    updatedAt: now,
  };
  // ★ 会话行与它的全部消息**同一个事务**(MC-027)。消息 id 必须重新生成 —— 它是主键,
  // 照抄会撞上源那一行;那两行本来就该是两条独立的记录:删掉源对话不该动到分叉这一段。
  // create + replaceAll 两段各自带事务的写法会留下"有行没消息"的空壳,这里合成一段。
  createForkedSession(
    fork,
    copiedMessages.map((m) => ({ ...m, sessionId: fork.id })),
  );

  broadcastSessionChanged(fork);
  log.info(
    `session forked: ${source.id} -> ${fork.id} (${copiedMessages.length} messages${
      providerSessionId ? `, provider session ${providerSessionId}` : ", no provider session yet"
    })`,
  );
  return fork;
}
