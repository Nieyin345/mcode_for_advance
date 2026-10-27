/**
 * 【Office 深度集成】**带修订左栏的编辑器容器**。
 *
 * ## 为什么单独一个组件
 *
 * `FileEditor.tsx` 已经 2700 行。把"左栏 + 编辑器并排"的逻辑塞进去，会让那个文件
 * 再长 100 行，而且修订是**可选的**（没待处理事项时不显示）—— 用一个包装组件，
 * `FileEditor` 只需要在渲染处套一层。
 *
 * ## 布局
 *
 * ```
 * ┌──────────┬────────────────────────┐
 * │ 修订左栏  │      编辑器            │   ← 有改动时左栏才出现
 * │ (300px)  │                        │
 * └──────────┴────────────────────────┘
 * ```
 *
 * 产品决定：修订在**左**，AI 对话在**右**（`RightPanel`）。左栏**只在有待处理
 * 事项时出现**，没有就整栏收起 —— 常驻空栏在笔记本上会白吃宽度。
 *
 * ## 数据
 *
 * 每次挂载拉一次 `revisionState`，之后由面板自己的操作触发刷新。
 * **没有实时推送**：修订变化频率低（AI 改完一次、用户处理一次），
 * 2 秒轮询在这个场景是过度设计；显式刷新更省。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconPencil } from "@renderer/lib/icons.js";
import type { DocRevisionState, DocPendingChange } from "@contracts/ipc";
import { RevisionPanel, hasPendingWork } from "./RevisionPanel.js";
import { genofficeAppForPath } from "@contracts/genofficeFileRoute";

export interface EditorWithRevisionsProps {
  filePath: string;
  children: ReactNode;
}

export function EditorWithRevisions({ filePath, children }: EditorWithRevisionsProps) {
  const [state, setState] = useState<DocRevisionState | null>(null);
  /** 跳转失败的原因（没有锚点 / 页面没接通道）。**显示出来**，不静默。 */
  const [jumpError, setJumpError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void api.documentView.revisionState({ filePath }).then(
      (result) => setState(result.ok ? (result.state ?? null) : null),
      () => setState(null), // 读不到就当没有修订会话，不影响编辑
    );
  }, [filePath]);

  useEffect(() => {
    refresh();
    // 切文件时先清空，避免上一个文档的条目闪现在新文档上。
    return () => setState(null);
  }, [refresh]);

  const focusLocation = useCallback((change: DocPendingChange) => {
    /* 【EDIT-06】点条目 → 让编辑器滚到那一处。
     *
     * 锚点由页面上报时带来（`location.anchor`），语义各家不同：
     *   - docs / markdown → `block`（第 N 个顶层块）
     *    - sheets → `cell`（表 + 单元格地址）
     *    - slides → `element`（第 N 页 + 元素 id）
     *    - html   → `range`（行号）
     *
     * **宿主不解释锚点**（那需要认识五种编辑器的内部结构），只负责送过去 ——
     * 页面才知道怎么换算成滚动位置。见 `ipc/documentView.ts` 的 `onRevisionFocus`。 */
    const anchor = change.location?.anchor;
    if (anchor !== undefined) {
      void api.documentView.revisionFocus({ filePath, anchor }).then(
        (result) => {
          // 送不到时**如实提示**，不假装跳成功（跳到错地方比不跳更让人困惑）。
          if (!result.ok) setJumpError(result.reason);
          else setJumpError(null);
        },
        () => setJumpError(null),
      );
      return;
    }
    // 没有锚点（老数据 / 页面没给）：退回"至少把焦点送回编辑器"，不假装能定位。
    void import("./documentViewIdentity.js").then((mod) => {
      void api.documentView.focus({ docId: mod.stableDocId(filePath) }).catch(() => {});
    }).catch(() => {});
  }, [filePath]);

  const show = hasPendingWork(state);

  return (
    <div className="flex h-full min-h-0">
      {show && state !== null && (
        <div className="flex h-full min-h-0 flex-col">
          <RevisionPanel state={state} onFocusLocation={focusLocation} onRefresh={refresh} />
          {jumpError !== null && (
            <div
              data-revision-jump-error=""
              className="shrink-0 border-t border-edge bg-warning/10 px-2 py-1 text-[10px] text-warning"
              title={jumpError}
            >
              {jumpError}
            </div>
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * 工具条上的「修订 / 直接改」开关。
 *
 * ## 为什么它自己拉状态，而不是由 `EditorWithRevisions` 传下来
 *
 * 按钮在**工具条**上，修订面板在**视图区**里 —— 两者是兄弟节点（`FileEditor`
 * 里工具条在视口上方），中间没有共同的父组件持有这个状态。按钮自己拉一次
 * `revisionState`、切完再拉一次，比为了共享一个布尔值把状态提升到 2700 行的
 * `FileEditor` 里干净。
 *
 * ## 为什么只在这五家出现，PDF 不给
 *
 * 修订需要编辑器有"把改动记录成条目"的能力，而**这五家各有自己的记录点**：
 * docs 是原厂 ProseMirror 的 `ins`/`del`；markdown 是自建 TipTap mark；
 * sheets 拦 `applyOps` 的 `ChangePlan`（单元格级 before/after）；slides 比对
 * deck 前后差异（`partPath` 定位页、`durableId` 定位元素）；html 是源码行级 diff。
 *
 * **PDF 不做**：它的"改动"不是文本流上的编辑 —— 加批注/表单/涂黑/签名是
 * **叠加标注**，不是对原文的增删改。把「拒绝」实现成"删掉标注"和把「拒绝」
 * 实现成"还原被改的文字"是两件事，混用会让左栏的语义骗人。PDF 的标注走它
 * 自己的面板（`annotations.ts` / `NoteMargin`），不套这套。
 *
 * 给一个按下去什么也不发生的按钮，比不画更坏（同 `FileEditor` 里 PDF 不给
 * "切到 Monaco"那个判断）。
 */
export function RevisionModeButton({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"edit" | "review" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = useMemo(() => {
    const host = genofficeAppForPath(filePath);
    // 【EDIT-06】五家有修订桥，PDF 没有（理由见组件头「为什么只在这五家出现」）。
    return host === "docs" || host === "markdown" || host === "sheets"
      || host === "slides" || host === "html";
  }, [filePath]);

  useEffect(() => {
    if (!supported) { setMode(null); return; }
    let alive = true;
    void api.documentView.revisionState({ filePath }).then(
      (result) => { if (alive) setMode(result.ok ? (result.state?.mode ?? "edit") : "edit"); },
      () => { if (alive) setMode("edit"); },
    );
    return () => { alive = false; };
  }, [filePath, supported]);

  if (!supported || mode === null) return null;
  const next = mode === "review" ? "edit" : "review";

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        data-revision-mode={mode}
        aria-pressed={mode === "review"}
        disabled={busy}
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
          "cds-hover-ghost",
          mode === "review" ? "text-accent" : "text-content-muted hover:text-content",
          busy && "opacity-60",
        )}
        title={mode === "review" ? t("revision.switchToEdit") : t("revision.switchToReview")}
        onClick={() => {
          setBusy(true);
          setError(null);
          void api.documentView.revisionMode({ filePath, mode: next }).then(
            (result) => {
              setBusy(false);
              if (result.ok) setMode(next);
              else setError(result.reason);
            },
            (err: unknown) => {
              setBusy(false);
              setError(err instanceof Error ? err.message : String(err));
            },
          );
        }}
      >
        <IconPencil size={12} />
        {t(mode === "review" ? "revision.modeReview" : "revision.modeEdit")}
      </button>
      {error !== null && (
        <span data-revision-mode-error="" className="max-w-[180px] truncate text-[10px] text-warning" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
