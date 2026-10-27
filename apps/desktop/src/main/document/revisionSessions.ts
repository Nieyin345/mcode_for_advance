/**
 * 【Office 深度集成】**修订会话** —— 每个文档一份待审改动与评论的宿主侧事实源。
 *
 * ## 它解决什么
 *
 * 有了 {@link PendingChange} 这个统一形状之后，还缺三件事：
 *
 *   1. **归属**：一条改动属于哪份文档、由谁产生的；
 *   2. **生命周期**：接受/拒绝之后，条目要消失，且要真的作用到文档上；
 *   3. **持久**：切换标签、重开文档之后，未处理的改动不能丢。
 *
 * 本模块管 1 和 2；3 交给调用方（文档打开时重新向编辑器要一遍 ——
 * 因为**文档本身才是改动的真正存储**，宿主持有的只是索引）。
 *
 * ## 为什么宿主不自己存改动内容
 *
 * 一条修订的"原文"与"新文"住在编辑器里（docs 是 ProseMirror 的 `ins`/`del` Mark）。
 * 宿主要是另存一份，两边会分叉：用户在编辑器里手动改了、或者 undo 了一次，
 * 宿主那份就过期了。所以：
 *
 *   - **编辑器的状态是唯一事实**；
 *   - 本模块只缓存左栏需要的**摘要**，并且每次 `syncFromEditor` 时整批替换；
 *   - 接受/拒绝**派发回编辑器执行**，不在宿主里算 diff。
 *
 * ## 与 `document_tool_call` 的关系
 *
 * AI 产生的改动经过工具层，工具层的返回里带 `batchId`。本模块按批次收，
 * 于是一条「把第三章重写」的指令产生的 12 处修订，在左栏里是一组，不是 12 条散沙。
 */
import type {
  PendingChange,
  PendingChangeBatch,
  RevisionComment,
  RevisionEditor,
  RevisionState,
} from "./pendingChanges.js";
import { openComments, resolvedComments, sortChanges } from "./pendingChanges.js";

/** 一个文档的修订会话。 */
interface DocSession {
  filePath: string;
  editor: RevisionEditor;
  /** 编辑模式 / 复核模式。**AI 默认 review**，人可切。 */
  mode: "edit" | "review";
  changes: PendingChange[];
  comments: RevisionComment[];
  /** 最近一次同步时间（诊断用）。 */
  syncedAt: number;
}

/**
 * 按文档路径管理修订会话。
 *
 * **路径必须先归一化**（用 `physicalPath`）再进这里 —— 否则 `D:\WS\a.docx` 与
 * `d:/ws/a.docx` 会变成两个会话，左栏就只显示一半改动。
 */
/** 把一次接受/拒绝送到编辑器执行。由装配层按编辑器类型分发。 */
export type RevisionDecider = (input: {
  filePath: string;
  editor: RevisionEditor;
  action: "accept" | "reject";
  ids: readonly string[];
}) => Promise<{ ok: true } | { ok: false; reason: string }>;

export class RevisionSessions {
  private readonly sessions = new Map<string, DocSession>();
  private decider: RevisionDecider | null = null;
  /** 批次 → 该批次的改动 id（一条 AI 指令产生的一组改动）。 */
  private readonly batches = new Map<string, string[]>();

  /** 打开文档时登记（`mode` 取调用方给的值；AI 侧一律传 `"review"`）。 */
  ensure(filePath: string, editor: RevisionEditor, mode: "edit" | "review" = "review"): void {
    const existing = this.sessions.get(filePath);
    if (existing !== undefined) {
      // 编辑器变了（同一路径换格式几乎不可能，但要显式处理而不是静默沿用）。
      if (existing.editor !== editor) {
        this.sessions.set(filePath, { filePath, editor, mode, changes: [], comments: [], syncedAt: Date.now() });
      }
      return;
    }
    this.sessions.set(filePath, { filePath, editor, mode, changes: [], comments: [], syncedAt: Date.now() });
  }

  /** 文档关闭时摘掉。**未处理的改动随之丢弃** —— 它们仍在文件/编辑器里，
   *  下次打开会重新同步回来（所以不是丢数据，只是丢索引）。 */
  forget(filePath: string): void {
    this.sessions.delete(filePath);
    // 批次索引里指向这个文档的条目一并清掉，防长期运行后无限增长。
    for (const [batchId, ids] of [...this.batches]) {
      const stillAlive = ids.some((id) =>
        [...this.sessions.values()].some((session) => session.changes.some((change) => change.id === id)),
      );
      if (!stillAlive) this.batches.delete(batchId);
    }
  }

  /** 切编辑/复核模式。 */
  setMode(filePath: string, mode: "edit" | "review"): boolean {
    const session = this.sessions.get(filePath);
    if (session === undefined) return false;
    session.mode = mode;
    return true;
  }

  modeOf(filePath: string): "edit" | "review" | null {
    return this.sessions.get(filePath)?.mode ?? null;
  }

  /**
   * 用编辑器当前的真实状态**整批替换**缓存的改动。
   *
   * 为什么是整批替换而不是增量合并：编辑器是唯一事实源，增量合并会在
   * "用户在编辑器里手动改了/undo 了"之后留下幽灵条目。整批替换的代价是
   * 每次同步要传全量摘要 —— 但摘要本来就只有几十个字。
   */
  syncFromEditor(filePath: string, changes: readonly PendingChange[], comments: readonly RevisionComment[] = []): void {
    const session = this.sessions.get(filePath);
    if (session === undefined) return;
    session.changes = sortChanges(changes);
    session.comments = [...comments];
    session.syncedAt = Date.now();
  }

  /** 追加一批 AI 改动（按 `batchId` 归组，左栏能把它们显示成一条指令的产物）。 */
  recordBatch(batch: PendingChangeBatch): void {
    const session = this.sessions.get(batch.filePath);
    if (session === undefined) return;
    // 同一批次重复上报 = 幂等覆盖（AI 重试不应产生双份条目）。
    const previous = this.batches.get(batch.batchId);
    if (previous !== undefined) {
      const ids = new Set(previous);
      session.changes = session.changes.filter((change) => !ids.has(change.id));
    }
    session.changes = sortChanges([...session.changes, ...batch.changes]);
    this.batches.set(batch.batchId, batch.changes.map((change) => change.id));
  }

  /**
   * 执行一次接受/拒绝 —— **派发给编辑器，不自己算**。
   *
   * 为什么要这个方法而不是让调用方直接改缓存：接受/拒绝有两个必须原子的动作
   * （① 让编辑器真的应用/还原 ② 把条目从缓存里摘掉）。只做 ② 会让左栏显示
   * "处理完了"而正文没变 —— 那是最坏的一种不一致。
   *
   * `decider` 由装配层注入：它知道当前开着这个文档的编辑器在哪个 webContents 上、
   * 怎么把决定送过去（docs 走 ProseMirror 的 revisions 函数，markdown 走自建实现）。
   * **没装 decider 时显式失败**，不假装成功。
   */
  async decide(
    filePath: string,
    action: "accept" | "reject",
    ids: readonly string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const session = this.sessions.get(filePath);
    if (session === undefined) return { ok: false, reason: `这个文档没有修订会话：${filePath}` };
    const decider = this.decider;
    if (decider === null) {
      return { ok: false, reason: "宿主没有配置修订执行器，无法接受/拒绝改动" };
    }
    const targets = session.changes.filter((change) => ids.includes(change.id));
    if (targets.length === 0) return { ok: false, reason: "这些改动已经不在待审列表里了" };
    // 只读的改动要显式拒绝，而不是跳过 —— 跳过会让"批量接受"看起来成功却没做全。
    const blocked = targets.filter((change) =>
      action === "accept" ? change.capabilities?.accept === false : change.capabilities?.reject === false);
    if (blocked.length > 0) {
      return {
        ok: false,
        reason: `${blocked.length} 处改动不支持${action === "accept" ? "接受" : "拒绝"}：` +
          `${blocked[0]!.capabilities?.readOnlyReason ?? "它是只读的"}`,
      };
    }
    const applied = await decider({ filePath, editor: session.editor, action, ids: targets.map((c) => c.id) });
    if (!applied.ok) return applied;
    this.dropHandled(filePath, targets.map((change) => change.id));
    return { ok: true };
  }

  /** 装配期注入修订执行器（每个编辑器一个实现）。 */
  setDecider(decider: RevisionDecider | null): void {
    this.decider = decider;
  }

  /** 某个文档的完整复核状态（左栏的数据源）。 */
  stateOf(filePath: string): RevisionState | null {
    const session = this.sessions.get(filePath);
    if (session === undefined) return null;
    return {
      editor: session.editor,
      filePath: session.filePath,
      mode: session.mode,
      changes: [...session.changes],
      comments: [...session.comments],
    };
  }

  /** 所有有未处理改动的文档（决定左栏显不显示）。 */
  filesWithPendingWork(): string[] {
    return [...this.sessions.values()]
      .filter((session) => session.changes.length > 0 || openComments(session.comments).length > 0)
      .map((session) => session.filePath);
  }

  /**
   * 接受/拒绝之后，从缓存里摘掉这些条目。
   *
   * **只摘缓存**：真正的作用已经由编辑器执行了（见文件头"宿主不自己存改动内容"）。
   * 如果调用方忘了先让编辑器执行，这里会把条目摘掉但文字没变 —— 所以这个方法
   * 只应由"派发成功之后"的路径调用。
   */
  dropHandled(filePath: string, ids: readonly string[]): void {
    const session = this.sessions.get(filePath);
    if (session === undefined) return;
    const drop = new Set(ids);
    session.changes = session.changes.filter((change) => !drop.has(change.id));
    session.syncedAt = Date.now();
  }

  /** 评论：新增 / 编辑 / 回复 / resolve。 */
  addComment(comment: RevisionComment): boolean {
    const session = this.sessions.get(comment.filePath);
    if (session === undefined) return false;
    session.comments = [...session.comments, comment];
    return true;
  }

  editComment(filePath: string, commentId: string, text: string): boolean {
    const session = this.sessions.get(filePath);
    if (session === undefined) return false;
    const index = session.comments.findIndex((comment) => comment.id === commentId);
    if (index < 0) return false;
    session.comments[index] = { ...session.comments[index]!, text };
    return true;
  }

  replyToComment(filePath: string, commentId: string, reply: RevisionComment["replies"][number]): boolean {
    const session = this.sessions.get(filePath);
    if (session === undefined) return false;
    const index = session.comments.findIndex((comment) => comment.id === commentId);
    if (index < 0) return false;
    const comment = session.comments[index]!;
    session.comments[index] = { ...comment, replies: [...comment.replies, reply] };
    return true;
  }

  /** resolve / 取消 resolve。**resolve 不是删除**（Overleaf 的行为）。 */
  setCommentResolved(filePath: string, commentId: string, resolved: boolean): boolean {
    const session = this.sessions.get(filePath);
    if (session === undefined) return false;
    const index = session.comments.findIndex((comment) => comment.id === commentId);
    if (index < 0) return false;
    session.comments[index] = { ...session.comments[index]!, resolved };
    return true;
  }

  /** 左栏主列表要显示的评论（未 resolve）。 */
  openCommentsOf(filePath: string): RevisionComment[] {
    const session = this.sessions.get(filePath);
    return session === undefined ? [] : openComments(session.comments);
  }

  /** 已 resolve 的评论（左上角入口里）。 */
  resolvedCommentsOf(filePath: string): RevisionComment[] {
    const session = this.sessions.get(filePath);
    return session === undefined ? [] : resolvedComments(session.comments);
  }

  /** 退出/测试用。 */
  reset(): void {
    this.sessions.clear();
    this.batches.clear();
  }
}

/** 生产单例。 */
export const revisionSessions = new RevisionSessions();
