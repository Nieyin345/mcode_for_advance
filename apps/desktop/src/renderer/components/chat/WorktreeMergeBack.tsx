/**
 * Worktree merge-back UI, shared by its two entry points:
 *
 *  - `WorktreeMergeToolbarButton` — the top-toolbar (Titlebar) button for the
 *    ACTIVE session. Shown ONLY while the session runs in a materialized
 *    worktree AND that worktree has unmerged work (dirty files or commits
 *    not yet contained in the local branch) — a clean, fully-merged worktree
 *    renders nothing. State is re-probed on session/worktree change, on a
 *    slow interval (12s — cheap porcelain + status calls), and whenever the
 *    dialog closes (a merge/removal may have just cleared the work).
 *
 *  - `WorktreeMergeBackDialog` — the preview → confirm → merge flow, also
 *    mounted by the left bar's worktree group context menu (all sessions of
 *    a directory share ONE checkout, so a single merge covers every thread
 *    in the group).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { normWorktreeKey } from "@renderer/lib/worktree.js";
import type { GitMergePreviewResult, GitWorktreeInfo } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import {
  IconGitMerge,
  IconGitBranch,
  IconGitCommit,
  IconLoader2,
  IconAlertTriangle,
  IconCheck,
  IconTrash,
  IconSparkles,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { MergeConflictResolveDialog } from "@renderer/components/ide/MergeConflictResolveDialog.js";
import { WorktreeRemoveDialog, WorktreeMergeBackDialog } from "./WorktreeMergeBackParts.js";
export { WorktreeRemoveDialog, WorktreeMergeBackDialog };

/* ───────────────────────── toolbar button ───────────────────────── */

export function WorktreeMergeToolbarButton() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  // The ACTIVE session (Titlebar scope — one button, foreground thread).
  const session = useSessionStore((s) => {
    const id = s.activeSessionId;
    if (!id) return undefined;
    return (
      s.sessions.find((x) => x.id === id) ??
      s.pinnedSessions.find((x) => x.id === id) ??
      (() => {
        for (const list of Object.values(s.sessionsByProject)) {
          const hit = list?.find((x) => x.id === id);
          if (hit) return hit;
        }
        return undefined;
      })()
    );
  });

  const worktreePath = session?.worktreePath ?? null;
  const repoPath = projects.find((p) => p.id === session?.projectId)?.path ?? null;

  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);
  const [hasChanges, setHasChanges] = useState(false);
  /** 请求序号:只有最新一次 `refresh` 的响应能写 `hasChanges`。对话框是同一个实例、
   *  只换 prop(worktreePath/repoPath),切到另一个工作树时旧回包不许把新的判定盖掉
   *  (与 `ProjectBranchIndicator` / `GitPanel` / `GitHistoryView` 同一类守卫)。 */
  const changesSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++changesSeqRef.current;
    if (!repoPath || !worktreePath) {
      setHasChanges(false);
      return;
    }
    try {
      // Single-tree probe (worktreeStatus), NOT worktreeList: the list
      // enriches EVERY linked tree with its own `git status` child process,
      // and this runs on a 12s interval — the poller must only ever pay for
      // the one tree it cares about.
      const { status } = await api.git.worktreeStatus({ repoPath, worktreePath });
      if (seq !== changesSeqRef.current) return; // superseded (worktree switched)
      // "Has work" = uncommitted files OR commits not contained in the main
      // HEAD (worktreeStatus's `merged` flag is the ancestor probe).
      setHasChanges(!!status && (status.dirty || !status.merged));
    } catch {
      if (seq !== changesSeqRef.current) return;
      setHasChanges(false);
    }
  }, [repoPath, worktreePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!worktreePath) return;
    const timer = setInterval(() => {
      if (document.hidden) return; // no git probing while the window is hidden
      void refresh();
    }, 12_000);
    return () => clearInterval(timer);
  }, [worktreePath, refresh]);

  if (!repoPath || !worktreePath || !hasChanges) return null;

  return (
    <>
      {/* Square icon button — same geometry as the terminal/panel toggles it
          sits between (rounded p-1.5, 18px icon). Accent tint signals "this
          session has work waiting to land"; the full explanation lives in
          the tooltip. */}
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "flex shrink-0 items-center justify-center rounded p-1.5 transition-colors",
          "text-accent hover:bg-surface-hover",
        )}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        title={t("chat.worktree.mergeBackTitle")}
      >
        <IconGitMerge size={18} className="shrink-0" />
      </button>
      <WorktreeMergeBackDialog
        open={open}
        onOpenChange={(o) => {
          if (!o) void refresh(); // a merge/removal may have cleared the work
          setOpen(o);
        }}
        sessionId={session?.id ?? null}
        worktreePath={worktreePath}
        repoPath={repoPath}
      />
    </>
  );
}

/* ───────────────────────── remove dialog ───────────────────────── */
