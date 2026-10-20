/**
 * `GitRepoCard` 的**子组件与工具**（从 `GitRepoCard.tsx` 拆出）。
 *
 * ## 为什么拆
 *
 * `GitRepoCard.tsx` 原本是一个 1997 行的文件：一个 1034 行的主组件 `GitRepoCard`，
 * 后面跟着 5 个子组件（提交框 / 分支组 / 操作日志 / 文件组 / 文件行）与 3 个纯辅助
 * （状态码图标 / 行内动作图标 / patch 解析）。**它们是各自独立的渲染单元**（AST 实测
 * 各块之间零闭包捕获），挤在一个文件里只是历史堆积。
 *
 * ## 判据：拆出去的东西**只依赖自己的 props 与模块级 import**
 *
 * 这 5 个子组件在拆分前**已经**只吃 props（没有一个捕获主组件的局部变量）—— 所以这是
 * **纯搬迁**，不改变任何行为。主组件通过 `import` 拿回它渲染用的那 5 个；其余 4 个叶子
 * （`FileRow` / `RowActionIcon` / `StatusCodeIcon` / `parsePatchToBeforeAfter`）只在
 * 本文件内部互相引用，不对外 export。
 *
 * ## 网
 *
 * `scripts/ide-ime-smoke/` 真挂载 `GitRepoCard` 并断言**每个子组件画出来的元素节点**
 * （带哪些 props、哪些文件进了哪个 FileGroup）—— 拆坏一处它就红（已变异验证）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { ContextMenu } from "@base-ui/react/context-menu";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { joinPath, basename } from "@renderer/lib/path.js";
import { checkoutArgsFor } from "@renderer/lib/branchRef.js";
import { formatRelativeTime, formatFullTime } from "@renderer/lib/time.js";
import { browserUuid } from "@renderer/lib/uuid.js";
import type { GitFileStatus, GitBranchInfo } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
  IconGitCommit,
  IconLoader2,
  IconPlayerStop,
  IconCheck,
  IconTrash,
  IconEye,
  IconPlus,
  IconMinus,
  IconSparkles,
  IconMaximize,
  IconList,
  IconCircleCheck,
  IconCircleXFilled,
  IconX,
  IconGitMerge,
} from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { GitOpLogEntry } from "@renderer/components/ide/GitRepoCard.js";

/** Message ids for each operation type, shown in the log list (rendered via
 *  `t()` so the label follows the UI locale). 搬自 `GitRepoCard.tsx` —— 只有
 *  `OperationLog` 用得到它。 */
const OP_LABEL_KEYS: Record<GitOpLogEntry["op"], MessageId> = {
  pull: "ide.git.pull",
  push: "ide.git.push",
  commit: "ide.git.commit",
  sync: "ide.git.sync",
  stage: "ide.git.stage",
  unstage: "ide.git.unstage",
  discard: "ide.git.discard",
  merge: "ide.git.merge",
  mergeAbort: "ide.git.mergeAbort",
  deleteBranch: "ide.git.deleteBranch",
  checkout: "ide.git.switchBranch",
};

export function CommitBox({
  repoPath,
  value,
  onChange,
  disabled,
  busy,
  onCommit,
}: {
  repoPath: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  busy: boolean;
  onCommit: (mode: "commit" | "push" | "sync") => void;
}) {
  const { t } = useI18n();
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);
  const [generating, setGenerating] = useState(false);
  // Set when the user stops an in-flight generation: the aborted call's
  // result/error must NOT overwrite the commit message box.
  const cancelledRef = useRef(false);
  // Cancellation key of the in-flight generation (main aborts the SDK query
  // via git.cancelGenerateCommitMessage).
  const genRequestIdRef = useRef<string | null>(null);
  // Maximize/preview panel - opened when the commit message overflows the
  // 3-row cap, so the user can edit the full text comfortably.
  const [previewOpen, setPreviewOpen] = useState(false);

  // ── Auto-grow textarea: 1 row by default, up to MAX_ROWS, then cap and
  //    surface a "maximize" affordance. Measured from scrollHeight so soft-
  //    wraps count as visual rows, not just explicit newlines. ──
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [overflowed, setOverflowed] = useState(false);
  const MAX_ROWS = 3;
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    // Reset to auto so scrollHeight reflects the full content height.
    ta.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const contentRows = Math.round(ta.scrollHeight / lineHeight);
    const visibleRows = Math.min(Math.max(contentRows, 1), MAX_ROWS);
    // Floor at the 36px base height so single-line never collapses below it.
    ta.style.height = `${Math.max(visibleRows * lineHeight, 36)}px`;
    setOverflowed(contentRows > MAX_ROWS);
  }, [value]);

  const handleGenerate = async () => {
    if (generating || disabled) return;
    // commitGenModel is stored as "configId:roleKey" - split it back.
    let customModelId: string | null = null;
    let customModelRole: string | null = null;
    if (commitGenModel) {
      const colonIdx = commitGenModel.lastIndexOf(":");
      if (colonIdx > 0) {
        customModelId = commitGenModel.slice(0, colonIdx);
        customModelRole = commitGenModel.slice(colonIdx + 1);
      } else {
        customModelId = commitGenModel;
      }
    }
    if (!customModelId) return; // no model configured - no-op

    setGenerating(true);
    cancelledRef.current = false;
    const requestId = browserUuid();
    genRequestIdRef.current = requestId;
    try {
      const res = await api.git.generateCommitMessage({
        repoPath,
        customModelId,
        customModelRole,
        prompt: commitGenPrompt,
        requestId,
      });
      if (cancelledRef.current) return; // aborted by the user — keep the box as-is
      if (res.ok && res.message) {
        onChange(res.message);
      } else {
        onChange(res.error ?? t("ide.git.genFailed"));
      }
    } catch {
      if (!cancelledRef.current) onChange(t("ide.git.genFailed"));
    } finally {
      genRequestIdRef.current = null;
      setGenerating(false);
    }
  };

  /** Stop the in-flight generation (hover affordance on the generate button). */
  const handleCancelGenerate = () => {
    cancelledRef.current = true;
    const id = genRequestIdRef.current;
    if (id) void api.git.cancelGenerateCommitMessage({ requestId: id });
    setGenerating(false);
  };

  // Ctrl/Cmd+Enter commits (Enter itself inserts a newline, as expected in a
  // multi-line field). Shared by the inline textarea and the preview panel.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && value.trim() && !disabled) {
      e.preventDefault();
      onCommit("commit");
    }
  };

  return (
    <div className="my-2 space-y-1.5">
      {/* Textarea with inline generate + maximize icons at the top-right. */}
      <div className="relative">
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("ide.git.commitPlaceholder")}
          disabled={disabled || generating}
          className="w-full resize-none rounded-md border border-edge-input bg-surface py-1 pl-2 pr-14 [font-size:var(--right-panel-font-size)] leading-relaxed text-content outline-none focus:border-accent disabled:opacity-50 min-h-[36px]"
        />
        {/* Top-right icon row: AI generate (when configured) + maximize
            (when the content overflows the 3-row cap). Horizontal so a single
            row still fits both icons without overflowing. */}
        <div className="absolute right-1 top-1 flex items-center gap-0.5">
          {commitGenModel && (
            <button
              type="button"
              onClick={() => (generating ? handleCancelGenerate() : handleGenerate())}
              disabled={disabled}
              title={generating ? t("ide.git.stopGenerate") : t("ide.git.generateHint")}
              className={cn(
                "group/generate flex h-5 w-5 items-center justify-center rounded text-content-subtle transition-colors",
                "hover:bg-surface-hover hover:text-accent disabled:opacity-40",
              )}
            >
              {generating ? (
                <>
                  <IconLoader2 size={12} className="animate-spin group-hover/generate:hidden" />
                  <IconPlayerStop size={12} className="hidden group-hover/generate:block" />
                </>
              ) : (
                <IconSparkles size={12} />
              )}
            </button>
          )}
          {overflowed && (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              title={t("ide.git.expandEdit")}
              className="flex h-5 w-5 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
            >
              <IconMaximize size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Commit split button - main "提交" fills the row, with the dropdown
          trigger spliced on the right (shared rounded corners). Main action
          stays a raw button so the two pieces visually fuse; the Menu
          interaction is unchanged. */}
      <div className="flex overflow-hidden rounded-md">
        <button
          type="button"
          onClick={() => onCommit("commit")}
          disabled={!value.trim() || disabled}
          className="flex flex-1 items-center justify-center gap-1 bg-accent px-2 py-1 [font-size:var(--right-panel-font-size)] text-surface transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle"
        >
          {busy ? <IconLoader2 size={11} className="animate-spin" /> : <IconGitCommit size={11} />}
          {t("ide.git.commit")}
        </button>
        <Menu.Root>
          <Menu.Trigger
            disabled={!value.trim() || disabled}
            className="flex items-center bg-accent px-1.5 text-surface transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle"
          >
            <IconChevronDown size={12} />
          </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="top" align="end" sideOffset={4}>
                <Menu.Popup
                  className={cn(
                    "z-50 min-w-[160px] rounded-[var(--radius-btn-xs)] border border-edge bg-surface py-1 shadow-[var(--shadow-popover)]",
                    "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                    "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                    "transition-[transform,opacity] duration-100",
                  )}
                >
                  <Menu.Item
                    onClick={() => onCommit("commit")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                  >
                    {t("ide.git.commit")}
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => onCommit("push")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                  >
                    {t("ide.git.commitAndPush")}
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => onCommit("sync")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                  >
                    {t("ide.git.commitAndSync")}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>

      {/* ── Maximize / preview panel ──
          A lightweight Dialog with a large editable textarea bound to the same
          `value`/`onChange`, so edits sync back to the inline field on close. */}
      <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[480px] max-w-[90vw] p-4">
            <Dialog.Title>{t("ide.git.editCommitTitle")}</Dialog.Title>
            <Dialog.Description className="mt-1">
              {t("ide.git.editCommitDesc")}
            </Dialog.Description>
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={10}
              autoFocus
              className="mt-3 w-full resize-y rounded-md border border-edge-input bg-surface px-2.5 py-1.5 text-xs leading-relaxed text-content outline-none focus:border-accent"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPreviewOpen(false)}>
                {t("ide.git.done")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!value.trim() || disabled}
                onClick={() => {
                  setPreviewOpen(false);
                  onCommit("commit");
                }}
              >
                <IconGitCommit size={12} />
                {t("ide.git.commit")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/* ─────────────────── branch picker group ─────────────────── */

/** A labeled group of refs (local branches / remote branches / tags) inside
 *  the branch picker. Each row checks out its ref when clicked.
 *
 *  - Local branches: `git checkout <name>`.
 *  - Remote branches: if a local branch of the same short name exists, switch
 *    to it; otherwise create a tracking branch (`git checkout -b <name> <origin/name>`).
 *  - Tags: `git checkout <tag>` (detached HEAD). */
export function BranchGroup({
  label,
  items,
  localNames,
  onCheckout,
  onMerge,
  onDelete,
  icon,
}: {
  label: string;
  items: GitBranchInfo[];
  /** Short names of local branches - used to decide tracking-branch creation
   *  for remote refs. */
  localNames: Set<string>;
  onCheckout: (branch: string, newBranch?: string) => void;
  /** When provided, non-current local/remote rows get a hover "merge into
   *  current branch" action. Tags are excluded (merging a tag is rare and
   *  would clutter the row). */
  onMerge?: (b: GitBranchInfo) => void;
  /** When provided, non-current LOCAL rows get a hover "delete branch"
   *  action. Remote rows are excluded — deleting one means pushing a ref
   *  deletion to the remote, which the picker deliberately doesn't offer. */
  onDelete?: (b: GitBranchInfo) => void;
  icon?: React.ReactNode;
}) {
  const { t } = useI18n();
  const handleClick = (b: GitBranchInfo) => {
    // 判据走共享的 checkoutArgsFor(与 ProjectBranchIndicator 的切换器同一条规则)。
    const args = checkoutArgsFor(b, localNames);
    if (args) onCheckout(args.branch, args.newBranch);
  };
  return (
    <div className="py-0.5">
      <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-content-subtle">
        {label}
      </div>
      {items.map((b) => (
        <Menu.Item
          key={`${b.type}/${b.name}`}
          onClick={() => handleClick(b)}
          className={cn(
            "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] outline-none select-none",
            "data-[highlighted]:bg-surface-muted",
            b.current ? "text-accent" : "text-content-muted",
          )}
        >
          <span className="shrink-0 opacity-80">{icon ?? <IconGitBranch size={11} />}</span>
          <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
          {b.label && (
            <span
              className="min-w-0 max-w-[120px] truncate text-[10px] text-content-subtle group-hover:opacity-0"
              title={b.label}
            >
              {b.label}
            </span>
          )}
          {/* Hover "merge into current branch" — fades in where the subject
              label was. stopPropagation keeps the click from also activating
              the surrounding checkout menu item. */}
          {!b.current && b.type !== "tag" && onMerge && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMerge(b);
              }}
              title={t("ide.git.mergeIntoBranch")}
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-subtle transition-opacity",
                "opacity-0 hover:bg-surface-hover hover:text-accent group-hover:opacity-100",
              )}
            >
              <IconGitMerge size={11} />
            </button>
          )}
          {/* Hover "delete branch" (local rows only) — same fade-in pattern as
              the merge action; stopPropagation keeps checkout from firing. */}
          {!b.current && b.type === "local" && onDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(b);
              }}
              title={t("ide.git.deleteBranch")}
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-subtle transition-opacity",
                "opacity-0 hover:bg-surface-hover hover:text-danger group-hover:opacity-100",
              )}
            >
              <IconTrash size={11} />
            </button>
          )}
          {b.current && <IconCheck size={11} className="shrink-0" />}
        </Menu.Item>
      ))}
    </div>
  );
}

/* ───────────────────────── action button ───────────────────────── */

export function ActionButton({
  children,
  onClick,
  disabled,
  busy,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded text-content-muted transition-colors",
        "hover:bg-surface-hover hover:text-content disabled:opacity-40",
      )}
    >
      {busy ? <IconLoader2 size={12} className="animate-spin" /> : children}
    </button>
  );
}

/* ───────────────────────── operation log ───────────────────────── */

/**
 * Collapsible operation log shown at the bottom of a repo card. Lists the most
 * recent pull/push/commit/etc. operations (newest first), each as one line with
 * a status icon, op label, and relative time. Failed entries expand on click to
 * reveal the full error message - the key surface for diagnosing network/auth
 * failures that would otherwise be lost.
 */
export function OperationLog({
  logs,
  onClear,
}: {
  logs: GitOpLogEntry[];
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="border-t border-edge">
      {/* Header row: collapse toggle + clear-all */}
      <div className="flex items-center gap-1 px-2.5 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 [font-size:var(--rp-fs-xxs)] font-medium uppercase tracking-wide text-content-subtle transition-colors hover:text-content-muted"
        >
          {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
          <IconList size={11} />
          {t("ide.git.opLog", { n: logs.length })}
        </button>
        <button
          type="button"
          onClick={onClear}
          title={t("ide.git.clearLog")}
          className="ml-auto flex h-5 w-5 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
        >
          <IconX size={12} />
        </button>
      </div>
      {/* List */}
      {!collapsed && (
        <div className="max-h-[160px] overflow-y-auto px-2.5 pb-1.5">
          {logs.map((entry) => {
            const isFailure = entry.status === "failure";
            const expanded = expandedId === entry.id;
            const hasMessage = isFailure && !!entry.message;
            return (
              <div key={entry.id} className="border-b border-edge/50 last:border-b-0">
                <button
                  type="button"
                  disabled={!hasMessage}
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 py-1 text-left [font-size:var(--right-panel-font-size)]",
                    hasMessage ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  {isFailure ? (
                    <IconCircleXFilled size={11} className="shrink-0 text-danger" />
                  ) : (
                    <IconCircleCheck size={11} className="shrink-0 text-accent" />
                  )}
                  <span
                    className={cn(
                      "shrink-0",
                      isFailure ? "text-danger" : "text-content-muted",
                    )}
                  >
                    {t(OP_LABEL_KEYS[entry.op])}
                  </span>
                  <span
                    className="ml-auto shrink-0 [font-size:var(--rp-fs-xxs)] text-content-subtle"
                    title={formatFullTime(entry.timestamp)}
                  >
                    {formatRelativeTime(entry.timestamp)}
                  </span>
                </button>
                {expanded && hasMessage && (
                  <div className="break-words whitespace-pre-wrap pb-1.5 pl-5 [font-size:var(--rp-fs-xxs)] leading-relaxed text-danger">
                    {entry.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── file group ───────────────────────── */

export function FileGroup({
  labelKey,
  files,
  repoPath,
  staged,
  onBulkAction,
  bulkActionLabel,
  busy,
  onDiscard,
  onDiscardAll,
  onSingleStage,
  onSingleUnstage,
  onSingleDiscard,
}: {
  labelKey: MessageId;
  files: GitFileStatus[];
  repoPath: string;
  staged?: boolean;
  onBulkAction: () => void;
  bulkActionLabel: string;
  busy: boolean;
  onDiscard?: (paths: string[]) => void;
  /** Discard every file in this group at once (opens the same confirmation
   *  dialog as a single-file discard). Only wired for the unstaged group. */
  onDiscardAll?: () => void;
  onSingleStage?: (filePath: string) => void;
  onSingleUnstage?: (filePath: string) => void;
  onSingleDiscard?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const label = t(labelKey);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div>
      <div className="group mb-1 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 [font-size:var(--rp-fs-xxs)] font-medium uppercase tracking-wide text-content-subtle"
        >
          {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
          {label} ({files.length})
        </button>
        <div className="ml-auto flex items-center gap-1">
          {onDiscardAll && (
            <button
              type="button"
              onClick={onDiscardAll}
              disabled={busy}
              title={t("ide.git.discardAllHint", { group: label })}
              aria-label={t("ide.git.discardAllHint", { group: label })}
              className="rounded p-0.5 text-content-subtle opacity-0 transition-all hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
            >
              <IconTrash size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onBulkAction}
            disabled={busy}
            className="rounded px-1.5 py-0.5 [font-size:var(--rp-fs-xxs)] text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-40"
          >
            {bulkActionLabel}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="space-y-0.5">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              repoPath={repoPath}
              staged={staged}
              onDiscard={onDiscard}
              onSingleStage={onSingleStage}
              onSingleUnstage={onSingleUnstage}
              onSingleDiscard={onSingleDiscard}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── file row ───────────────────────── */

function FileRow({
  file,
  repoPath,
  staged,
  onDiscard,
  onSingleStage,
  onSingleUnstage,
  onSingleDiscard,
}: {
  file: GitFileStatus;
  repoPath: string;
  staged?: boolean;
  onDiscard?: (paths: string[]) => void;
  onSingleStage?: (filePath: string) => void;
  onSingleUnstage?: (filePath: string) => void;
  onSingleDiscard?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const openFileInIde = useSessionStore((s) => s.openFileInIde);
  const setGitDiffPair = useSessionStore((s) => s.setGitDiffPair);
  const gitDiffOpenMode = useSessionStore((s) => s.gitDiffOpenMode);
  const openGitDiffDialogTab = useSessionStore((s) => s.openGitDiffDialogTab);
  const [diffTally, setDiffTally] = useState<{ adds: number; dels: number } | null>(null);

  const absPath = joinPath(repoPath, file.path);
  const code = staged ? file.index : file.workingTree;

  // Async-load the +/- tally for this file. For staged files we diff against
  // HEAD (what will be committed); for unstaged we diff the working tree.
  useEffect(() => {
    if (code === "untracked" || code === "unmodified") {
      setDiffTally(null);
      return;
    }
    let cancelled = false;
    api.git
      .diff({ repoPath, filePath: file.path, staged: !!staged })
      .then(({ patch }) => {
        if (cancelled || !patch) return;
        const { before, after } = parsePatchToBeforeAfter(patch);
        const diff = lineDiff(before, after);
        setDiffTally(diffSummary(diff));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, file.path, code, staged]);

  // Click → open in center editor with diff. Fetches the appropriate diff
  // (staged vs HEAD for staged files, working tree for unstaged), stashes
  // the diff pair, and opens the file in diff mode.
  const handleClick = async () => {
    // Wide-panel (3:7) mode has no center editor column — a center-mode open
    // would be invisible, so the floating dialog takes it there as well.
    if (gitDiffOpenMode === "dialog" || useSessionStore.getState().widePanelOpen) {
      // Dialog open-mode: compact patch-scoped diff — both sides are
      // reconstructed from the patch (changed regions ± context). Staged
      // diffs always supply `after` from the patch (index blob); unstaged
      // may omit it so DiffPane reads the live working tree from disk.
      let before = "";
      let after: string | undefined;
      try {
        const { patch } = await api.git.diff({ repoPath, filePath: file.path, staged: !!staged });
        if (patch) {
          const parsed = parsePatchToBeforeAfter(patch);
          before = parsed.before;
          after = parsed.after;
        }
      } catch {
        // fall through with empty before
      }
      openGitDiffDialogTab({
        id: `${absPath}::${staged ? "staged" : "work"}`,
        filePath: absPath,
        before,
        after: staged ? (after ?? "") : after,
        title: basename(file.path),
        repoPath,
        source: "working",
        staged: !!staged,
      });
      return;
    }
    // Center open-mode: full-file diff. The old side comes from the git
    // object database — index snapshot for unstaged, HEAD for staged — never
    // from a patch reconstruction, which only covers changed regions and
    // would paint the rest of the file as additions. The new side is the
    // live working tree (DiffPane reads it from disk when `after` is
    // omitted); a staged file pins both sides to blobs so the view shows
    // exactly what staging changed, independent of later working-tree edits.
    try {
      if (staged) {
        const [head, index] = await Promise.all([
          api.git.fileBlob({ repoPath, filePath: file.path, side: "HEAD" }),
          api.git.fileBlob({ repoPath, filePath: file.path, side: "index" }),
        ]);
        setGitDiffPair(absPath, { before: head.content, after: index.content });
      } else {
        const { content } = await api.git.fileBlob({ repoPath, filePath: file.path, side: "index" });
        setGitDiffPair(absPath, { before: content });
      }
    } catch {
      // fall through — without a stashed pair FileEditor opens in edit mode
    }
    openFileInIde(absPath, { diff: true });
  };

  return (
    <ContextMenu.Root>
        <ContextMenu.Trigger
        render={
          <div className="group relative flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-hover/40" />
        }
      >
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={absPath}
        >
          <StatusCodeIcon code={code} />
          <span className="truncate font-mono [font-size:var(--right-panel-font-size)] text-content-muted">{basename(file.path)}</span>
        </button>
        {/* +/- tally badge — hidden on hover so the action buttons have room. */}
        {diffTally && (diffTally.adds > 0 || diffTally.dels > 0) && (
          <span className="flex shrink-0 items-center gap-0.5 font-mono [font-size:var(--rp-fs-xxs)] tabular-nums group-hover:opacity-0">
            {diffTally.adds > 0 && <span className="text-success">+{diffTally.adds}</span>}
            {diffTally.dels > 0 && <span className="text-danger">−{diffTally.dels}</span>}
          </span>
        )}
        {/* Hover action buttons — absolutely positioned so the +/- tally badge
            can sit flush right; this layer fades in over the badge on hover. */}
        <div className="absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {/* Staged files: unstage button. Unstaged: stage button. */}
          {staged ? (
            <RowActionIcon
              icon={<IconMinus size={11} />}
              title={t("ide.git.unstage")}
              onClick={(e) => {
                e.stopPropagation();
                onSingleUnstage?.(file.path);
              }}
            />
          ) : (
            <RowActionIcon
              icon={<IconPlus size={11} />}
              title={t("ide.git.stage")}
              onClick={(e) => {
                e.stopPropagation();
                onSingleStage?.(file.path);
              }}
            />
          )}
          {/* Discard — only for unstaged files (staged files can be unstaged first). */}
          {!staged && onSingleDiscard && (
            <RowActionIcon
              icon={<IconTrash size={11} />}
              title={t("ide.git.discard")}
              danger
              onClick={(e) => {
                e.stopPropagation();
                onSingleDiscard(file.path);
              }}
            />
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup
            className={cn(
              "z-50 min-w-[140px] rounded-[var(--radius-btn-xs)] border border-edge bg-surface py-1 shadow-[var(--shadow-popover)]",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <ContextMenu.Item
              onClick={handleClick}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
            >
              <IconEye size={12} />
              {t("ide.git.viewDiff")}
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={() => openFileInIde(absPath)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
            >
              <IconGitCommit size={12} />
              {t("ide.git.viewSource")}
            </ContextMenu.Item>
            {!staged && onDiscard && (
              <ContextMenu.Item
                onClick={() => onDiscard([file.path])}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-danger outline-none select-none data-[highlighted]:bg-danger/10"
              >
                <IconTrash size={12} />
                {t("ide.git.discardEllipsis")}
              </ContextMenu.Item>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A tiny icon button shown on file-row hover. */
function RowActionIcon({
  icon,
  title,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-content-subtle transition-colors",
        "hover:bg-surface-hover",
        danger ? "hover:text-danger" : "hover:text-content",
      )}
    >
      {icon}
    </button>
  );
}

/* ───────────────────────── status code icon ───────────────────────── */

function StatusCodeIcon({ code }: { code: GitFileStatus["index"] }) {
  const label =
    code === "unmerged" ? "U" :
    code === "modified" ? "M" :
    code === "added" ? "A" :
    code === "deleted" ? "D" :
    code === "untracked" ? "?" :
    code === "renamed" ? "R" :
    code === "copied" ? "C" : "·";
  const color =
    code === "unmerged" ? "text-danger" :
    code === "added" || code === "untracked" ? "text-accent" :
    code === "modified" || code === "renamed" || code === "copied" ? "text-warning" :
    code === "deleted" ? "text-danger" : "text-content-subtle";
  return (
    <span className={cn("w-3 shrink-0 text-center font-mono [font-size:var(--rp-fs-xxs)] font-bold", color)} title={code}>
      {label}
    </span>
  );
}

/* ───────────────────────── patch parser ───────────────────────── */

/** Parse a unified diff patch into before/after text for line-based diffing. */
function parsePatchToBeforeAfter(patch: string): { before: string; after: string } {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const lines = patch.split("\n");
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      afterLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      beforeLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      beforeLines.push(line.slice(1));
      afterLines.push(line.slice(1));
    } else if (line === "") {
      beforeLines.push("");
      afterLines.push("");
    }
  }
  return { before: beforeLines.join("\n"), after: afterLines.join("\n") };
}
