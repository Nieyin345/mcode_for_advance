/**
 * 【Office 深度集成】**修订与复核面板（左栏，Overleaf 式）**。
 *
 * ## 位置与出现时机
 *
 * 产品决定：待审改动与评论都在**左栏**（AI 对话在右栏）。**没有待处理事项时整栏隐藏** ——
 * 常驻一个空栏在笔记本上会白白吃掉横向空间。
 *
 * ## 它长什么样（照 Overleaf 的实际形态）
 *
 *   - 一条改动 = 一个卡片：作者色条 + 定位标签（「第 3 段」）+ 改动摘要 + 接受/拒绝按钮；
 *   - **点卡片 → 光标跳到正文对应位置**（Overleaf 的行为）；点正文改动 → 卡片高亮；
 *   - 顶部有批量操作：「全部接受」「全部拒绝」，**执行前确认**（Overleaf 也是确认的）；
 *   - 评论与改动在同一列表里，用图标区分（产品决定：用户关心"这段文字有什么待处理的事"，
 *     不关心"这是谁提的"）；
 *   - 已 resolve 的评论收到顶部入口，**不删除**。
 *
 * ## 颜色
 *
 * **人和 AI 走同一套机制，只是颜色不同**（产品决定）。所以这里只有两个色位：
 * `author.id === "ai"` 用 AI 色，其余用用户色。不在 UI 上区分"处理流程"。
 *
 * ## 它不做什么
 *
 * - **不自己应用改动**：接受/拒绝调 `documentView.revisionDecide`，由主进程派发给
 *   编辑器执行（编辑器是唯一事实源，见 `main/document/revisionSessions.ts` 文件头）。
 * - **不缓存**：数据每次从 `revisionState` 拉。左栏显示的是宿主索引，真正的改动在编辑器里。
 */
import { useCallback, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import { Button } from "@renderer/components/ui/index.js";
import { makeQuoteTag } from "@renderer/lib/contentTag.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconCheck,
  IconX,
  IconMessage,
  IconChevronRight,
  IconAlertTriangle,
  IconPencil,
} from "@renderer/lib/icons.js";
import type {
  DocPendingChange,
  DocRevisionComment,
  DocRevisionState,
} from "@contracts/ipc";

/** 作者色：只有两个色位（AI / 人），见文件头「颜色」。 */
function authorColor(authorId: string): string {
  return authorId === "ai"
    ? "var(--revision-author-ai, var(--accent))"
    : "var(--revision-author-user, var(--success))";
}

type Translate = ReturnType<typeof useI18n>["t"];

function kindLabel(t: Translate, kind: DocPendingChange["kind"]): string {
  switch (kind) {
    case "insert": return t("revision.kind.insert");
    case "delete": return t("revision.kind.delete");
    case "replace": return t("revision.kind.replace");
    case "format": return t("revision.kind.format");
    case "move": return t("revision.kind.move");
    default: return t("revision.kind.structural");
  }
}

/** 摘要文本最多显示这么多字符 —— 条目要能一眼扫过，不是读全文。 */
const SUMMARY_CHARS = 160;

function clip(text: string | undefined): string {
  if (text === undefined || text === "") return "";
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
}

/** 引用 tag 的展示名要的是文件名，不是整条路径（与 `makeFileTag` 一致）。 */
function fileNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export interface RevisionPanelProps {
  state: DocRevisionState;
  /** 点条目 → 请求编辑器跳到对应位置。 */
  onFocusLocation?: (change: DocPendingChange) => void;
  /** 数据变更后由父组件重新拉取。 */
  onRefresh?: () => void;
}

export function RevisionPanel({ state, onFocusLocation, onRefresh }: RevisionPanelProps) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState<"accept" | "reject" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  /* 【EDIT-08】「让 AI 改这段」与「加评论」共用同一个输入框与草稿，
   * 靠这个布尔区分提交到哪条通道 —— 两种操作互斥，不需要两份 state。 */
  const [rewriting, setRewriting] = useState(false);

  const open = useMemo(() => state.comments.filter((c) => !c.resolved), [state.comments]);
  const resolved = useMemo(() => state.comments.filter((c) => c.resolved), [state.comments]);
  const pending = state.changes.length + open.length;

  const decide = useCallback(async (action: "accept" | "reject", ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.documentView.revisionDecide({
        filePath: state.filePath, action, ids,
      });
      if (!result.ok) setError(result.reason);
      else onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }, [state.filePath, onRefresh]);

  const submitComment = useCallback(async () => {
    const text = draft.trim();
    if (text === "") return;
    setBusy(true);
    setError(null);
    try {
      // **锚点由页面算**（选区只在编辑器里）。宿主收到回执后才在左栏建条目，
      // 所以这里成功后只刷新；没选中文字时页面会拒，错误会走下面那条。
      const result = await api.documentView.commentCreate({
        filePath: state.filePath, text,
      });
      if (!result.ok) setError(result.reason);
      else { setDraft(""); setComposing(false); onRefresh?.(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, state.filePath, onRefresh]);

  /**
   * 把「一段原文 + 一句指令」放进对话草稿。**只备草稿，不发送。**
   *
   * ## 为什么抽成函数
   *
   * 两个入口共用它：「让 AI 改这段」（EDIT-08，指令由用户打）与
   * 「把这条评论交给 AI」（EDIT-11，指令就是评论文本）。产品要求
   * 「人和 AI 走同一套机制」，那两个入口也必须走同一条落地路径 ——
   * 各写一份会在下次改动时分叉（一处加了"不覆盖已有草稿"、另一处忘了）。
   *
   * ## 为什么只备草稿
   *
   * 自动开跑会让用户在一次点击里付出一轮模型费用，而他可能只是想先看看草稿长什么样。
   * 与 EDIT-04 的「交给 Mcode AI」完全同一个取向。
   *
   * ## 返回 false 时错误已经写进 `error`
   */
  const stageRewriteDraft = useCallback((selectedText: string, instruction: string): boolean => {
    const sessionId = useSessionStore.getState().activeSessionId;
    if (!sessionId) {
      // 没有活动会话时不能静默成功：草稿无处可放，用户会以为万事俱备。
      setError(t("revision.rewriteNoSession"));
      return false;
    }
    /* 一次写完：引用 tag + 指令正文。
     *
     * ⚠️ **不要拆成两次 store 调用**（`quoteIntoComposer` 再加 `deliverComposerDraft`）：
     * 那两个方法各自「读草稿 → 写回」，中间只要有一次渲染，
     * 第二次读到的就是旧值，第一次加的 tag 会被冲掉。这里一次拼好整份草稿。
     *
     * **不覆盖已有草稿**：用户可能已经写了一半，冲掉他的话比不填更坏 ——
     * 指令追加在后面，空行分隔。 */
    const store = useSessionStore.getState();
    const current = store.composerDraftBySession[sessionId];
    const existing = current?.text ?? "";
    store.deliverComposerDraft(sessionId, {
      text: existing === "" ? instruction : `${existing}\n\n${instruction}`,
      html: current?.html ?? "",
      tags: [
        ...(current?.tags ?? []),
        makeQuoteTag({
          text: selectedText,
          origin: { kind: "file", filePath: state.filePath, name: fileNameOf(state.filePath) },
        }),
      ],
    });
    return true;
  }, [state.filePath, t]);

  /**
   * 【EDIT-08】把这段指令交给 AI 改写**当前选区**。
   *
   * 选区只在编辑器里（左栏看不到），所以先问主进程要一段**确定的选区文字**；
   * 拿到之后交给 `stageRewriteDraft` 备好草稿。**不发送。**
   *
   * ## 修复前它是什么样
   *
   * 它调 `revisionRewrite` 拿到 `ok: true` 就把草稿清空 —— 而那条 RPC 当时
   * 只是"把命令发给了页面"，五家桥没有一家认识 `action: 'rewrite'`。于是
   * **点一下、面板显示成功、什么都没发生**，用户等一整天也不会有改写。
   * 现在：拿不到选区就报失败（带原因），拿到了就一定有草稿。
   */
  const submitRewrite = useCallback(async () => {
    const instruction = draft.trim();
    if (instruction === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.documentView.revisionRewrite({
        filePath: state.filePath, instruction,
      });
      if (!result.ok) { setError(result.reason); return; }
      if (!stageRewriteDraft(result.selectedText, instruction)) return;
      setComposing(false); setRewriting(false); setDraft("");
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, state.filePath, onRefresh, stageRewriteDraft]);

  /**
   * 【EDIT-11】把一条评论交给 AI —— 让它按评论说的改文档。
   *
   * ## 评论文本就是指令
   *
   * 评论说的是「这里的数据是 2023 年的，换成最新的」—— 那已经是一句可执行的指令，
   * 不需要再让用户把它抄进输入框。所以这里直接把 `comment.text` 当指令用。
   *
   * ## 为什么还要去要一次选区
   *
   * 评论锚在文档的某个范围上，但**那个范围在页面里**（`location.anchor` 的语义各家
   * 不同）。宿主不去解释锚点，所以走与改写同一条路：让页面把**当前选区**报回来。
   * 因此用户的操作是「选中那段 → 点评论上的『交给 AI』」；没选就如实报「先选中」，
   * 不猜一段给模型（猜错会让 AI 改到别处，而他看不出来）。
   */
  const sendCommentToAi = useCallback(async (comment: DocRevisionComment) => {
    const instruction = comment.text.trim();
    if (instruction === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.documentView.revisionRewrite({
        filePath: state.filePath, instruction,
      });
      if (!result.ok) { setError(result.reason); return; }
      if (!stageRewriteDraft(result.selectedText, instruction)) return;
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [state.filePath, onRefresh, stageRewriteDraft]);

  if (pending === 0 && resolved.length === 0) return null;

  return (
    <aside
      data-cds="RevisionPanel"
      data-revision-file={state.filePath}
      className="flex h-full min-h-0 w-[300px] shrink-0 flex-col border-r border-edge bg-surface"
      aria-label={t("revision.panelLabel")}
    >
      {/* 顶部：标题 + 批量操作。批量操作要确认，与 Overleaf 一致。 */}
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-edge px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[length:var(--chat-fs-xs)] font-semibold text-content">
            {t("revision.title")}
          </span>
          <span className="text-[length:var(--chat-fs-xs)] text-content-muted">
            {t("revision.pendingCount", { count: String(pending) })}
          </span>
          {resolved.length > 0 && (
            <button
              type="button"
              className="ml-auto rounded-[var(--cds-radius-btn-xs)] px-1.5 py-0.5 text-[length:var(--chat-fs-xs)] text-content-muted hover:bg-surface-hover active:bg-surface-active"
              onClick={() => setShowResolved((v) => !v)}
            >
              {t("revision.resolvedEntry", { count: String(resolved.length) })}
            </button>
          )}
        </div>
        {state.changes.length > 0 && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => setConfirming("accept")}>
              {t("revision.acceptAll")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => setConfirming("reject")}>
              {t("revision.rejectAll")}
            </Button>
          </div>
        )}
        {confirming !== null && (
          <div data-revision-confirm="" className="flex flex-col gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-1.5">
            <span className="text-[length:var(--chat-fs-xs)] text-content">
              {confirming === "accept" ? t("revision.confirmAccept") : t("revision.confirmReject")}
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy}
                onClick={() => void decide(confirming, [])}>
                {t("common.confirm")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy}
                onClick={() => setConfirming(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
        {/* 对选中文字加评论：左栏发起，锚点在页面算（见 EditorWithRevisions 的说明）。 */}
        <div className="flex flex-col gap-1">
          {composing ? (
            <>
              <textarea
                data-revision-comment-draft=""
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("revision.commentPlaceholder")}
                rows={2}
                className="w-full resize-none rounded border border-edge bg-surface px-1.5 py-1 text-[length:var(--chat-fs-xs)] text-content outline-none focus:border-accent"
              />
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" disabled={busy || draft.trim() === ""}
                  onClick={() => void submitComment()}>
                  {t("revision.commentSubmit")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy}
                  onClick={() => { setComposing(false); setRewriting(false); setDraft(""); }}>
                  {t("common.cancel")}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-1">
              <button type="button" data-revision-comment-new=""
                className="flex items-center gap-1 self-start rounded-[var(--cds-radius-btn-xs)] px-1.5 py-0.5 text-[length:var(--chat-fs-xs)] text-content-muted hover:bg-surface-hover active:bg-surface-active hover:text-content"
                onClick={() => { setComposing(true); setRewriting(false); }}>
                <IconMessage size={12} />{t("revision.commentNew")}
              </button>
              {/* 【EDIT-08】让 AI 改这段 —— 与加评论同一个入口位置，
                  因为用户对「选中的这一段」能做的事就是这两件。
                  指令框与评论区共用 `draft`/`composing`：两种操作互斥，
                  分开两套 state 会让"刚写完评论又点了改写"留下残稿。 */}
              <button type="button" data-revision-rewrite-new=""
                className="flex items-center gap-1 self-start rounded-[var(--cds-radius-btn-xs)] px-1.5 py-0.5 text-[length:var(--chat-fs-xs)] text-content-muted hover:bg-surface-hover active:bg-surface-active hover:text-content"
                onClick={() => { setComposing(true); setRewriting(true); }}>
                <IconPencil size={12} />{t("revision.rewriteNew")}
              </button>
            </div>
          )}
          {rewriting && (
            <button type="button" data-revision-rewrite-submit=""
              className="flex items-center gap-1 self-start rounded-[var(--cds-radius-btn-xs)] border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[length:var(--chat-fs-xs)] text-accent"
              disabled={busy || draft.trim() === ""}
              onClick={() => void submitRewrite()}>
              {t("revision.rewriteSubmit")}
            </button>
          )}
        </div>
        {error !== null && (
          <div data-revision-error="" className="flex items-start gap-1 text-[length:var(--chat-fs-xs)] text-warning">
            <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {showResolved && resolved.length > 0 && (
          <section data-revision-resolved="" className="border-b border-edge px-2.5 py-2">
            <div className="mb-1 text-[length:var(--chat-fs-xs)] font-medium text-content-muted">
              {t("revision.resolvedTitle")}
            </div>
            {resolved.map((comment) => (
              <div key={comment.id} className="mb-1 rounded border border-edge px-2 py-1 text-[length:var(--chat-fs-xs)] text-content-muted">
                <div className="line-clamp-2">{comment.text}</div>
                <button type="button" className="mt-1 text-accent hover:underline"
                  onClick={() => {
                    void api.documentView.commentMutate({
                      op: "resolve", filePath: state.filePath,
                      commentId: comment.id, resolved: false,
                    }).then(() => onRefresh?.());
                  }}>
                  {t("revision.reopen")}
                </button>
              </div>
            ))}
          </section>
        )}

        {state.changes.map((change) => (
          <article
            key={change.id}
            data-revision-change={change.id}
            data-revision-kind={change.kind}
            className="border-b border-edge/60 px-2.5 py-2 hover:bg-surface-hover active:bg-surface-active"
          >
            <div className="flex items-center gap-1.5">
              {/* 作者色条：人和 AI 只差颜色，流程一样。 */}
              <span aria-hidden className="size-1.5 shrink-0 rounded-full"
                style={{ background: authorColor(change.author.id) }} />
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-0.5 text-left"
                title={t("revision.jumpHint")}
                onClick={() => onFocusLocation?.(change)}
              >
                <span className="truncate text-[length:var(--chat-fs-xs)] font-medium text-content">
                  {change.location.label}
                </span>
                <IconChevronRight size={11} className="shrink-0 text-content-muted" />
              </button>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-content-muted">
                {kindLabel(t, change.kind)}
              </span>
            </div>

            {change.before !== undefined && change.before !== "" && (
              <div data-revision-before="" className="mt-1 break-words text-[length:var(--chat-fs-xs)] text-content-muted line-through">
                {clip(change.before)}
              </div>
            )}
            {change.after !== undefined && change.after !== "" && (
              <div data-revision-after="" className="mt-0.5 break-words text-[length:var(--chat-fs-xs)] text-content">
                {clip(change.after)}
              </div>
            )}

            {change.readOnlyReason !== undefined ? (
              <div className="mt-1 text-[10px] text-content-muted">{change.readOnlyReason}</div>
            ) : (
              <div className="mt-1.5 flex items-center gap-1">
                <button type="button" data-revision-accept=""
                  className="flex items-center gap-0.5 rounded-[var(--cds-radius-btn-xs)] border border-edge px-1.5 py-0.5 text-[10px] text-content hover:bg-surface-hover active:bg-surface-active"
                  onClick={() => void decide("accept", [change.id])}>
                  <IconCheck size={11} />{t("revision.accept")}
                </button>
                <button type="button" data-revision-reject=""
                  className="flex items-center gap-0.5 rounded-[var(--cds-radius-btn-xs)] border border-edge px-1.5 py-0.5 text-[10px] text-content hover:bg-surface-hover active:bg-surface-active"
                  onClick={() => void decide("reject", [change.id])}>
                  <IconX size={11} />{t("revision.reject")}
                </button>
              </div>
            )}
          </article>
        ))}

        {open.map((comment) => (
          <article
            key={comment.id}
            data-revision-comment={comment.id}
            className="border-b border-edge/60 px-2.5 py-2 hover:bg-surface-hover active:bg-surface-active"
          >
            <div className="flex items-center gap-1.5">
              <IconMessage size={12} className="shrink-0 text-content-muted" />
              <span className="min-w-0 flex-1 truncate text-[length:var(--chat-fs-xs)] font-medium text-content">
                {comment.location.label}
              </span>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full"
                style={{ background: authorColor(comment.author.id) }} />
            </div>
            <div className="mt-1 break-words text-[length:var(--chat-fs-xs)] text-content">
              {comment.text}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <button type="button" data-revision-resolve=""
                className="text-[10px] text-accent hover:underline"
                onClick={() => {
                  void api.documentView.commentMutate({
                    op: "resolve", filePath: state.filePath,
                    commentId: comment.id, resolved: true,
                  }).then(() => onRefresh?.());
                }}>
                {t("revision.resolve")}
              </button>
              {/* 【EDIT-11】把这条评论交给 AI 改文档。
                  走与「让 AI 改这段」同一条路：只备草稿、不发送。
                  评论本身的内容就是指令（「这里数据不对，换成 2024 年的」），
                  所以不需要再让用户打一遍 —— 直接把评论文本当指令。 */}
              <button type="button" data-revision-comment-to-ai=""
                className="text-[10px] text-accent hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={() => void sendCommentToAi(comment)}>
                {t("revision.commentToAi")}
              </button>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}

/** 编辑 / 复核模式切换按钮 —— 放在文档工具栏上（产品决定：人用界面按钮切换）。 */
export function RevisionModeToggle({
  filePath, mode, onChange,
}: { filePath: string; mode: "edit" | "review"; onChange?: (next: "edit" | "review") => void }) {
  const { t } = useI18n();
  const next = mode === "review" ? "edit" : "review";
  return (
    <button
      type="button"
      data-revision-mode={mode}
      title={mode === "review" ? t("revision.switchToEdit") : t("revision.switchToReview")}
      className={cn(
        "rounded-[var(--cds-radius-btn-xs)] border px-2 py-[3px] text-[length:var(--chat-fs-xs)] font-medium transition-colors",
        mode === "review"
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-edge text-content hover:bg-surface-hover active:bg-surface-active",
      )}
      onClick={() => {
        void api.documentView.revisionMode({ filePath, mode: next })
          .then((result) => { if (result.ok) onChange?.(next); });
      }}
    >
      {mode === "review" ? t("revision.modeReview") : t("revision.modeEdit")}
    </button>
  );
}

/** 是不是有待处理事项（决定左栏显不显示）。 */
export function hasPendingWork(state: DocRevisionState | null): boolean {
  if (state === null) return false;
  return state.changes.length > 0 || state.comments.some((c) => !c.resolved);
}
