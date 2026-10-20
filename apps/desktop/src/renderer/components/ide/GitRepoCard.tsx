import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { browserUuid } from "@renderer/lib/uuid.js";
import type { GitRepo, GitStatusResult, GitBranchInfo, GitBranchListResult, GitMergePreviewResult } from "@contracts/ipc";
import { EMPTY_TURN_FILES, useSessionStore } from "@renderer/stores/sessionStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import { MergeConflictResolveDialog } from "@renderer/components/ide/MergeConflictResolveDialog.js";
// 子组件从 `GitRepoCardParts.tsx` 拆出（纯搬迁，见那边文件头）。
import { CommitBox, BranchGroup, ActionButton, OperationLog, FileGroup } from "@renderer/components/ide/GitRepoCardParts.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
  IconGitCommit,
  IconArrowUp,
  IconArrowDown,
  IconRefresh,
  IconLoader2,
  IconAlertTriangle,
  IconCheck,
  IconTrash,
  IconPlus,
  IconSparkles,
  IconTag,
  IconGitMerge,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** A single git operation log entry - one per pull/push/commit/sync/etc. */
export type GitOpLogEntry = {
  id: string;
  op: "pull" | "push" | "commit" | "sync" | "stage" | "unstage" | "discard" | "merge" | "mergeAbort" | "deleteBranch" | "checkout";
  /** "success" for ok results, "failure" for !ok results or thrown exceptions. */
  status: "success" | "failure";
  /** Full error message (only for failures). Omitted for successes. */
  message?: string;
  /** Epoch milliseconds (`Date.now()`). */
  timestamp: number;
};

/** Max number of log entries kept per repo. Older entries are dropped. */
export const MAX_LOG_ENTRIES = 20;

/** Monotonic counter for log entry ids (avoids Date.now() collisions when
 *  multiple entries are written within the same millisecond, e.g. sync). */
let logIdSeq = 0;

/**
 * One git repository's card in the Git panel. Layout (top to bottom):
 *
 *   Header: repo name + branch + ahead/behind + Pull/Push/Refresh
 *   已暂存 (staged) group  - [全部取消]
 *   Commit message input   - [提交 ▾] (commit / commit+push / commit+sync)
 *   更改 (unstaged) group   - [全部放弃] [全部暂存]
 *   操作日志 (operation log) - collapsible, recent N ops with full errors
 *
 * Clicking a file opens it in the CENTER editor's diff view (not inline).
 * Right-clicking a file shows a context menu (view source / discard changes).
 * Each file row shows a +/- diff tally badge (loaded async).
 *
 * All state is local to this card - multiple cards operate independently.
 */
export function GitRepoCard({ repo }: { repo: GitRepo }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<GitOpLogEntry[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<"push" | "pull" | "commit" | "merge" | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<string[] | null>(null);
  // Merge-conflict state: when a merge/pull produces conflicts we surface a
  // dialog offering AI resolution or aborting the merge. `conflictFiles`
  // doubles as the dialog's open trigger (null = closed). `conflictSource` /
  // `conflictBranch` describe where the conflicts came from so the dialog can
  // word itself correctly ("合并 feature-x 时…" vs "拉取后…").
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const [conflictSource, setConflictSource] = useState<"pull" | "merge" | "state">("pull");
  const [conflictBranch, setConflictBranch] = useState<string | null>(null);
  // Branch picker state: the grouped branch/tag list (fetched on menu open),
  // a search filter, the in-flight checkout, and the "new branch" dialog.
  // The menu is CONTROLLED so the merge action can close it before opening
  // the confirm dialog (two stacked overlays would be confusing).
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchListResult | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [checkingOut, setCheckingOut] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  // Branch-delete state: `pendingDelete` is the local branch picked for
  // deletion (non-null opens the confirm dialog); `deleteError` surfaces
  // git's own message (e.g. "not fully merged") inside the dialog, and
  // `deleteNeedsForce` flips the confirm button into a force `-D` retry.
  const [pendingDelete, setPendingDelete] = useState<GitBranchInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNeedsForce, setDeleteNeedsForce] = useState(false);
  // Branch-merge state: `mergeTarget` is the branch picked in the picker (a
  // non-null value opens the confirm dialog); `mergePreviewData` holds the
  // read-only preview (incoming commits / fast-forward / up-to-date) fetched
  // when the dialog opens, so the user knows what the merge will do BEFORE
  // confirming; `merging` is the in-flight merge itself.
  const [mergeTarget, setMergeTarget] = useState<GitBranchInfo | null>(null);
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const [mergePreviewData, setMergePreviewData] = useState<GitMergePreviewResult | null>(null);
  const [merging, setMerging] = useState(false);
  const collapsedGitRepos = useSessionStore((s) => s.collapsedGitRepos);
  const toggleCollapsedGitRepo = useSessionStore((s) => s.toggleCollapsedGitRepo);
  const collapsed = !!collapsedGitRepos[repo.path];

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { status } = await api.git.status({ repoPath: repo.path });
      setStatus(status);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [repo.path]);

  // Auto-refresh when the agent finishes a turn that touched files. The
  // model's Write/Edit may have created/modified files on disk, so the
  // working-tree status — and the "更改 (N)" / "已暂存 (N)" tallies — go
  // stale. `turn.files` fires once per turn and only when files.length > 0,
  // so this re-runs `git status` at most once per turn (no refresh storm).
  //
  // We track the last observed (sessionId, files) pair: a first observation
  // (mount, or a session switch) only seeds the tracker, and a refresh fires
  // only when the SAME active session's turnFiles reference changes — a fresh
  // turn.files payload, or the rewind that clears it. Session switches never
  // trigger a refresh (the card stays mounted across same-project sessions).
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const turnFiles = useSessionStore((s) =>
    activeSessionId ? (s.turnFilesBySession[activeSessionId] ?? EMPTY_TURN_FILES) : EMPTY_TURN_FILES,
  );
  const prevObserved = useRef<{ sessionId: string | null; files: TurnFileEntry[] | null | undefined }>({
    sessionId: null,
    files: undefined,
  });
  useEffect(() => {
    const prev = prevObserved.current;
    prevObserved.current = { sessionId: activeSessionId, files: turnFiles };
    if (prev.files === undefined) return; // first observation -> seed only
    if (prev.sessionId !== activeSessionId) return; // session switch -> seed only
    if (turnFiles !== prev.files) void refresh();
  }, [activeSessionId, turnFiles, refresh]);

  /** Prepend a log entry (newest first) and cap to MAX_LOG_ENTRIES. */
  const prependLog = useCallback(
    (entry: Omit<GitOpLogEntry, "id" | "timestamp">) => {
      const full: GitOpLogEntry = {
        ...entry,
        id: `log-${Date.now()}-${logIdSeq++}`,
        timestamp: Date.now(),
      };
      setLogs((prev) => [full, ...prev].slice(0, MAX_LOG_ENTRIES));
    },
    [],
  );

  /** Fetch the grouped branch/tag list for the picker. Called on menu open. */
  const loadBranches = useCallback(async () => {
    setBranchesLoading(true);
    setBranchQuery("");
    try {
      const { branches: list } = await api.git.listBranches({ repoPath: repo.path });
      setBranches(list);
    } catch {
      setBranches(null);
    } finally {
      setBranchesLoading(false);
    }
  }, [repo.path]);

  /** Check out a ref, then refresh. `newBranch` (when set) creates a local
   *  branch from the target first (tracking branch / new branch). */
  const handleCheckout = useCallback(
    async (branch: string, newBranch?: string) => {
      setCheckingOut(true);
      try {
        const res = await api.git.checkout({ repoPath: repo.path, branch, newBranch });
        // ⚠️ 先 `refresh()` 再挂错误:`refresh` 开头会 `setError(null)`(给"上次的错误
        // 别黏住"用的)。顺序反了就把**这一次**的失败横幅一起清掉 —— 切分支被 git 拒了
        // (本地有未提交改动会被覆盖),菜单关了、分支没变、屏幕上一个字没有。同一族
        // 缺陷见 McpPanel 的 toggle/delete。
        await refresh();
        if (!res.ok) {
          setError(res.error ?? t("ide.git.checkoutFailed"));
          prependLog({ op: "checkout", status: "failure", message: res.error });
        } else {
          prependLog({ op: "checkout", status: "success" });
        }
      } catch (err) {
        const msg = (err as Error).message ?? t("ide.git.checkoutFailed");
        setError(msg);
        prependLog({ op: "checkout", status: "failure", message: msg });
      } finally {
        setCheckingOut(false);
      }
    },
    [repo.path, refresh, prependLog, t],
  );

  /** Create a new branch from HEAD and switch to it. */
  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setNewBranchOpen(false);
    setNewBranchName("");
    await handleCheckout("HEAD", name);
  }, [newBranchName, handleCheckout]);

  /** Open the merge confirm dialog for a branch (hover action in the branch
   *  picker). Closes the picker first so only one overlay is up, then fetches
   *  the read-only preview so the dialog can state what will happen. */
  const openMergeDialog = useCallback(
    (b: GitBranchInfo) => {
      setBranchMenuOpen(false);
      setMergeTarget(b);
      setMergePreviewLoading(true);
      setMergePreviewData(null);
      api.git
        .mergePreview({ repoPath: repo.path, source: b.name })
        .then((data) => setMergePreviewData(data))
        .catch(() => setMergePreviewData(null))
        .finally(() => setMergePreviewLoading(false));
    },
    [repo.path],
  );

  /** Open the delete confirm dialog for a local branch (hover action in the
   *  branch picker). Closes the picker first so only one overlay is up. */
  const openDeleteDialog = useCallback((b: GitBranchInfo) => {
    setBranchMenuOpen(false);
    setPendingDelete(b);
    setDeleteError(null);
    setDeleteNeedsForce(false);
  }, []);

  /** Delete `pendingDelete`. A plain `-d` refuses to drop branches with
   *  unmerged commits — when git says "not fully merged" the dialog switches
   *  to offering a force `-D` retry instead. */
  const handleDeleteBranch = async (force: boolean) => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await api.git.deleteBranch({ repoPath: repo.path, branch: pendingDelete.name, force });
      if (!res.ok) {
        const msg = res.error ?? t("ide.git.deleteBranchFailed");
        setDeleteError(msg);
        if (/not fully merged|未完全合并/i.test(msg)) setDeleteNeedsForce(true);
        return;
      }
      prependLog({ op: "deleteBranch", status: "success" });
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.deleteBranchFailed");
      setDeleteError(msg);
      prependLog({ op: "deleteBranch", status: "failure", message: msg });
    } finally {
      setDeleting(false);
    }
  };

  /** Merge `mergeTarget` into the current branch. Conflicts route into the
   *  same AI-resolution dialog pull uses (with an added "abort merge" escape
   *  hatch); success is logged and the card refreshed. */
  const handleMerge = async () => {
    if (!mergeTarget || merging) return;
    setMerging(true);
    setBusy("merge");
    setError(null);
    try {
      const res = await api.git.merge({ repoPath: repo.path, source: mergeTarget.name });
      setMergeTarget(null);
      // 同 checkout:错误横幅必须在 `refresh()` 之后挂 —— refresh 开头的 `setError(null)`
      // 会把刚写上的失败一起清掉。
      await refresh();
      if (!res.ok) {
        setError(res.error ?? t("ide.git.mergeFailed"));
        prependLog({ op: "merge", status: "failure", message: res.error });
      } else if (res.conflict && res.conflictedFiles && res.conflictedFiles.length > 0) {
        setConflictSource("merge");
        setConflictBranch(mergeTarget.name);
        setConflictFiles(res.conflictedFiles);
      } else {
        prependLog({ op: "merge", status: "success" });
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.mergeFailed");
      setError(msg);
      prependLog({ op: "merge", status: "failure", message: msg });
    } finally {
      setMerging(false);
      setBusy(null);
    }
  };

  /** Filtered branch groups for the search box (matches name or commit subject). */
  const filteredBranches = useMemo(() => {
    if (!branches) return null;
    const q = branchQuery.trim().toLowerCase();
    if (!q) return branches;
    const match = (b: GitBranchInfo) =>
      b.name.toLowerCase().includes(q) || b.label.toLowerCase().includes(q);
    return {
      current: branches.current,
      detached: branches.detached,
      local: branches.local.filter(match),
      remote: branches.remote.filter(match),
      tags: branches.tags.filter(match),
    };
  }, [branches, branchQuery]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cross-client auto-refresh: the host broadcasts `git.changed` after ANY
  // client's git mutation (a paired phone's commit/pull, another repo card),
  // bumping this per-repo version in the store. Own mutations echo back too
  // — an idempotent extra refresh.
  const gitChangeVersion = useSessionStore(
    (s) => s.gitChangeVersionByRepo[repo.path] ?? 0,
  );
  useEffect(() => {
    void refresh();
  }, [gitChangeVersion, refresh]);

  // Split files into staged and unstaged groups.
  const staged = useMemo(
    () => status?.files.filter((f) => f.index !== "unmodified" && f.index !== "untracked") ?? [],
    [status],
  );
  const unstaged = useMemo(
    () => status?.files.filter((f) => f.workingTree !== "unmodified" || f.index === "untracked") ?? [],
    [status],
  );
  const hasStaged = staged.length > 0;
  const hasUnstaged = unstaged.length > 0;

  // Persistent merge-conflict probe: porcelain "UU" entries surface as
  // "unmerged" codes in status.files. Non-empty means the repo is mid-merge
  // with unresolved conflicts — possibly long after the transient dialog that
  // announced them was dismissed (or after an app restart). The banner below
  // keeps an AI-resolution entry available for as long as the state lasts.
  const conflictedPaths = useMemo(
    () =>
      status?.files
        .filter((f) => f.index === "unmerged" || f.workingTree === "unmerged")
        .map((f) => f.path) ?? [],
    [status],
  );

  /* ── operations ── */

  const handleStageAll = async () => {
    if (unstaged.length === 0) return;
    setBusy("commit");
    try {
      const res = await api.git.stage({
        repoPath: repo.path,
        filePaths: unstaged.map((f) => f.path),
      });
      // 同 checkout:先 refresh 再挂错误(refresh 开头 setError(null) 会清掉这次的失败。
      await refresh();
      if (!res.ok) {
        setError(res.error ?? t("ide.git.stageFailed"));
        prependLog({ op: "stage", status: "failure", message: res.error });
      } else {
        prependLog({ op: "stage", status: "success" });
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.stageFailed");
      setError(msg);
      prependLog({ op: "stage", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleUnstageAll = async () => {
    if (staged.length === 0) return;
    setBusy("commit");
    try {
      const res = await api.git.unstage({
        repoPath: repo.path,
        filePaths: staged.map((f) => f.path),
      });
      // 同 checkout:先 refresh 再挂错误。
      await refresh();
      if (!res.ok) {
        setError(res.error ?? t("ide.git.unstageFailed"));
        prependLog({ op: "unstage", status: "failure", message: res.error });
      } else {
        prependLog({ op: "unstage", status: "success" });
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.unstageFailed");
      setError(msg);
      prependLog({ op: "unstage", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleSingleStage = async (filePath: string) => {
    setBusy("commit");
    try {
      const res = await api.git.stage({ repoPath: repo.path, filePaths: [filePath] });
      // 同 checkout:先 refresh 再挂错误。
      await refresh();
      if (!res.ok) {
        setError(res.error ?? t("ide.git.stageFailed"));
        prependLog({ op: "stage", status: "failure", message: res.error });
      } else {
        prependLog({ op: "stage", status: "success" });
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.stageFailed");
      setError(msg);
      prependLog({ op: "stage", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleSingleUnstage = async (filePath: string) => {
    setBusy("commit");
    try {
      const res = await api.git.unstage({ repoPath: repo.path, filePaths: [filePath] });
      // 同 checkout:先 refresh 再挂错误。
      await refresh();
      if (!res.ok) {
        setError(res.error ?? t("ide.git.unstageFailed"));
        prependLog({ op: "unstage", status: "failure", message: res.error });
      } else {
        prependLog({ op: "unstage", status: "success" });
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.unstageFailed");
      setError(msg);
      prependLog({ op: "unstage", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleCommit = async (mode: "commit" | "push" | "sync") => {
    const msg = commitMsg.trim();
    if (!msg) return;
    setBusy("commit");
    setError(null);
    try {
      const res = await api.git.commit({ repoPath: repo.path, message: msg });
      if (!res.ok) {
        // commit 失败时不再 refresh,错误横幅本就在(这条 return 不会经过 setError(null))。
        setError(res.error ?? t("ide.git.commitFailed"));
        prependLog({ op: "commit", status: "failure", message: res.error });
        return;
      }
      prependLog({ op: "commit", status: "success" });
      setCommitMsg("");
      // ⚠️ 提交后的 push/sync 子步骤会失败,但它们后面跟着 `await refresh()`,而 refresh
      // 开头会 `setError(null)` —— 把错误攒在这里、refresh 之后再挂,否则"提交成功但推送
      // 失败"的那句话会被刷新清掉(用户以为推上去了)。同 checkout 那一族。
      let subError: string | null = null;
      if (mode === "push") {
        const pushRes = await api.git.push({ repoPath: repo.path });
        if (!pushRes.ok) {
          subError = pushRes.error ?? t("ide.git.pushFailed");
          prependLog({ op: "push", status: "failure", message: pushRes.error });
        } else {
          prependLog({ op: "push", status: "success" });
        }
      } else if (mode === "sync") {
        const pullRes = await api.git.pull({ repoPath: repo.path });
        if (!pullRes.ok) {
          subError = pullRes.error ?? t("ide.git.pullFailed");
          prependLog({ op: "sync", status: "failure", message: pullRes.error });
        } else {
          const pushRes = await api.git.push({ repoPath: repo.path });
          if (!pushRes.ok) {
            subError = pushRes.error ?? t("ide.git.pushFailed");
            prependLog({ op: "push", status: "failure", message: pushRes.error });
          } else {
            prependLog({ op: "push", status: "success" });
          }
        }
      }
      await refresh();
      if (subError) setError(subError);
    } catch (err) {
      const errMsg = (err as Error).message ?? t("ide.git.commitFailed");
      setError(errMsg);
      prependLog({ op: "commit", status: "failure", message: errMsg });
    } finally {
      setBusy(null);
    }
  };

  const handlePush = async () => {
    setBusy("push");
    setError(null);
    try {
      const res = await api.git.push({ repoPath: repo.path });
      // 同 checkout:先 refresh 再挂错误(refresh 开头的 setError(null) 会清掉这次的失败)。
      await refresh();
      if (!res.ok) {
        setError(res.error ?? t("ide.git.pushFailed"));
        prependLog({ op: "push", status: "failure", message: res.error });
      } else {
        prependLog({ op: "push", status: "success" });
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.pushFailed");
      setError(msg);
      prependLog({ op: "push", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handlePull = async () => {
    setBusy("pull");
    setError(null);
    try {
      const res = await api.git.pull({ repoPath: repo.path });
      // 同 checkout:先 refresh 再挂错误。conflict 分支设的是独立状态(conflictFiles),
      // 不受 refresh 影响,但也一并放到 refresh 之后,保持四条分支同一时序。
      await refresh();
      if (!res.ok) {
        setError(res.error ?? t("ide.git.pullFailed"));
        prependLog({ op: "pull", status: "failure", message: res.error });
      } else if (res.conflict && res.conflictedFiles && res.conflictedFiles.length > 0) {
        // Pull succeeded but left a merge conflict. Offer AI resolution via a
        // confirmation dialog instead of just a red banner.
        setConflictSource("pull");
        setConflictBranch(null);
        setConflictFiles(res.conflictedFiles);
      } else {
        prependLog({ op: "pull", status: "success" });
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.pullFailed");
      setError(msg);
      prependLog({ op: "pull", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleDiscard = async () => {
    if (!pendingDiscard) return;
    setBusy("commit");
    try {
      const res = await api.git.discard({
        repoPath: repo.path,
        filePaths: pendingDiscard,
      });
      setPendingDiscard(null);
      // 同 checkout:先 refresh 再挂错误(refresh 开头的 setError(null) 会清掉这次的失败)。
      await refresh();
      if (!res.ok) {
        setError(res.error ?? t("ide.git.discardFailed"));
        prependLog({ op: "discard", status: "failure", message: res.error });
      } else {
        prependLog({ op: "discard", status: "success" });
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.discardFailed");
      setError(msg);
      prependLog({ op: "discard", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-edge bg-surface">
      {/* ── Header ── */}
      <div className="flex flex-col gap-1 border-b border-edge px-2.5 py-1.5">
        {/* Row 1: repo name (gets the full row width so long names aren't
            squeezed off by the branch badge + remote actions) + collapse
            toggle. Splitting name and branch onto separate rows keeps long
            repo names readable. */}
        <div className="flex items-center gap-2">
          <IconGitBranch size={13} className="shrink-0 text-content-subtle" />
          <span
            className="min-w-0 flex-1 truncate [font-size:var(--right-panel-font-size)] font-medium text-content"
            title={repo.path}
          >
            {repo.name}
          </span>
          <ActionButton
            onClick={() => toggleCollapsedGitRepo(repo.path)}
            title={collapsed ? t("ide.tree.expand") : t("ide.git.collapseCard")}
          >
            {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
          </ActionButton>
        </div>
        {/* Row 2: branch + ahead/behind + remote actions. */}
        <div className="flex items-center gap-1.5">
          <Menu.Root
            open={branchMenuOpen}
            onOpenChange={(open) => {
              setBranchMenuOpen(open);
              if (open) void loadBranches();
            }}
          >
            <Menu.Trigger
              className={cn(
                "flex shrink-0 items-center gap-0.5 rounded bg-surface-muted px-1.5 py-0.5 font-mono [font-size:var(--rp-fs-xxs)] text-content-muted transition-colors",
                "hover:bg-surface-hover hover:text-content",
              )}
              title={t("ide.git.switchBranch")}
            >
              <IconGitBranch size={10} className="shrink-0 opacity-80" />
              <span className="truncate max-w-[120px]">{status?.branch || "HEAD"}</span>
              <IconChevronDown size={9} className="shrink-0 opacity-60" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={4}>
                <Menu.Popup
                  className={cn(
                    "z-50 flex max-h-[360px] w-[300px] max-w-[320px] min-w-[260px] flex-col rounded-md border border-edge bg-surface py-1 shadow-2xl",
                    "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                    "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                    "transition-[transform,opacity] duration-100",
                  )}
                >
                  {/* Search + "new branch" header (non-menu-item, so it doesn't
                      steal keyboard navigation from the branch list below). */}
                  <div className="flex items-center gap-1 px-2 pb-1">
                    <input
                      value={branchQuery}
                      onChange={(e) => setBranchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        // Prevent the Menu from interpreting arrow/Home/End as
                        // item navigation while typing in the filter box.
                        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
                          e.stopPropagation();
                        }
                      }}
                      placeholder={t("ide.git.searchBranches")}
                      className="min-w-0 flex-1 rounded border border-edge bg-surface px-1.5 py-0.5 text-[11px] text-content outline-none placeholder:text-content-subtle focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setNewBranchOpen(true)}
                      title={t("ide.git.newBranch")}
                      className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-content-muted transition-colors hover:bg-surface-muted hover:text-accent"
                    >
                      <IconPlus size={11} />
                    </button>
                  </div>

                  {/* Scrollable grouped list. */}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {branchesLoading ? (
                      <div className="flex items-center justify-center gap-1.5 px-3 py-4 text-[11px] text-content-subtle">
                        <IconLoader2 size={12} className="animate-spin" />
                        {t("common.loading")}
                      </div>
                    ) : !filteredBranches ? (
                      <div className="px-3 py-4 text-center text-[11px] text-content-subtle">
                        {t("ide.git.cannotReadBranches")}
                      </div>
                    ) : (
                      <>
                        {checkingOut && (
                          <div className="flex items-center justify-center gap-1.5 border-b border-edge px-3 py-1 text-[11px] text-content-subtle">
                            <IconLoader2 size={12} className="animate-spin" />
                            {t("ide.git.switching")}
                          </div>
                        )}
                        {filteredBranches.local.length === 0 &&
                          filteredBranches.remote.length === 0 &&
                          filteredBranches.tags.length === 0 && (
                            <div className="px-3 py-3 text-center text-[11px] text-content-subtle">
                              {branchQuery ? t("ide.git.noMatch") : t("ide.git.noBranches")}
                            </div>
                          )}
                        {filteredBranches.local.length > 0 && (
                          <BranchGroup
                            label={t("ide.git.localBranches")}
                            items={filteredBranches.local}
                            localNames={new Set(filteredBranches.local.map((b) => b.name))}
                            onCheckout={handleCheckout}
                            onMerge={openMergeDialog}
                            onDelete={openDeleteDialog}
                          />
                        )}
                        {filteredBranches.remote.length > 0 && (
                          <BranchGroup
                            label={t("ide.git.remoteBranches")}
                            items={filteredBranches.remote}
                            localNames={new Set(filteredBranches.local.map((b) => b.name))}
                            onCheckout={handleCheckout}
                            onMerge={openMergeDialog}
                          />
                        )}
                        {filteredBranches.tags.length > 0 && (
                          <BranchGroup
                            label={t("ide.git.tags")}
                            items={filteredBranches.tags}
                            localNames={new Set(filteredBranches.local.map((b) => b.name))}
                            onCheckout={handleCheckout}
                            icon={<IconTag size={11} />}
                          />
                        )}
                      </>
                    )}
                  </div>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          {status && status.ahead > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 [font-size:var(--rp-fs-xxs)] text-accent" title={t("ide.git.aheadOfUpstream")}>
              <IconArrowUp size={10} />
              {status.ahead}
            </span>
          )}
          {status && status.behind > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 [font-size:var(--rp-fs-xxs)] text-info" title={t("ide.git.behindUpstream")}>
              <IconArrowDown size={10} />
              {status.behind}
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <ActionButton onClick={handlePull} disabled={busy !== null || loading} busy={busy === "pull"} title={t("ide.git.pullFull")}>
              <IconArrowDown size={12} />
            </ActionButton>
            <ActionButton onClick={handlePush} disabled={busy !== null || loading} busy={busy === "push"} title={t("ide.git.pushFull")}>
              <IconArrowUp size={12} />
            </ActionButton>
            <ActionButton onClick={refresh} disabled={busy !== null} title={t("ide.git.refreshStatus")}>
              <IconRefresh size={12} />
            </ActionButton>
          </div>
        </div>
      </div>

      {/* ── Error banner ── */}
      {!collapsed && error && (
        <div className="flex items-start gap-1.5 border-b border-danger/30 bg-danger/10 px-2.5 py-1.5 [font-size:var(--right-panel-font-size)] text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* ── Merge-in-progress banner ──
          Persistent trigger for the AI-resolution window: shown whenever the
          repo holds unresolved conflicts and the transient dialog is closed
          (dismissed via "handle later", app restart, conflict caused
          externally). One click re-opens the shared dialog. */}
      {!collapsed && conflictFiles === null && conflictedPaths.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-warning/30 bg-warning/10 px-2.5 py-1.5 [font-size:var(--right-panel-font-size)] text-warning">
          <IconAlertTriangle size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {t("ide.git.mergeStateBanner", { n: conflictedPaths.length })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setConflictSource("state");
              setConflictBranch(null);
              setConflictFiles(conflictedPaths);
            }}
          >
            <IconSparkles size={12} />
            {t("ide.git.resolveWithAi")}
          </Button>
        </div>
      )}

      {/* ── Body ── */}
      {!collapsed && (
        <div className="p-2">
          {loading && !status ? (
            <div className="flex items-center gap-1.5 py-2 [font-size:var(--right-panel-font-size)] text-content-subtle">
              <IconLoader2 size={12} className="animate-spin" />
              {t("ide.git.readingStatus")}
            </div>
          ) : !status || (status.files.length === 0) ? (
            <div className="flex items-center gap-1.5 py-2 [font-size:var(--right-panel-font-size)] text-content-subtle">
              <IconCheck size={12} className="text-accent" />
              {t("ide.git.workingTreeClean")}
            </div>
          ) : (
            <>
              {/* Commit box (above staged, so the user writes the message first
                  then reviews what's staged before committing). */}
              {hasStaged && (
                <CommitBox
                  repoPath={repo.path}
                  value={commitMsg}
                  onChange={setCommitMsg}
                  disabled={busy !== null}
                  busy={busy === "commit"}
                  onCommit={handleCommit}
                />
              )}

              {/* 已暂存 group */}
              {hasStaged && (
                <FileGroup
                  labelKey="ide.git.staged"
                  files={staged}
                  repoPath={repo.path}
                  staged
                  onBulkAction={handleUnstageAll}
                  bulkActionLabel={t("ide.git.unstageAll")}
                  busy={busy !== null}
                  onSingleUnstage={(path) => void handleSingleUnstage(path)}
                  onSingleDiscard={undefined}
                />
              )}

              {/* 更改 group */}
              {hasUnstaged && (
                <div className={hasStaged ? "mt-2" : ""}>
                  <FileGroup
                    labelKey="ide.git.changes"
                    files={unstaged}
                    repoPath={repo.path}
                    onBulkAction={handleStageAll}
                    bulkActionLabel={t("ide.git.stageAll")}
                    busy={busy !== null}
                    onDiscard={(paths) => setPendingDiscard(paths)}
                    onDiscardAll={() => setPendingDiscard(unstaged.map((f) => f.path))}
                    onSingleStage={(path) => void handleSingleStage(path)}
                    onSingleDiscard={(path) => setPendingDiscard([path])}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Operation log ── */}
      {!collapsed && logs.length > 0 && (
        <OperationLog logs={logs} onClear={() => setLogs([])} />
      )}

      {/* ── Discard confirmation dialog ── */}
      <Dialog.Root open={pendingDiscard !== null} onOpenChange={(open) => { if (!open) setPendingDiscard(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
            <div className="flex items-start gap-3 pr-6">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <IconAlertTriangle size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title>{t("ide.git.discardQ")}</Dialog.Title>
                <Dialog.Description className="mt-1">
                  {t("ide.git.discardDesc", { n: pendingDiscard?.length ?? 0 })}
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingDiscard(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" size="sm" onClick={handleDiscard} disabled={busy !== null}>
                {busy === "commit" ? <IconLoader2 size={12} className="animate-spin" /> : <IconTrash size={12} />}
                {t("ide.git.discard")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Delete branch confirmation dialog ──
          Plain `-d` first; when git refuses (unmerged commits) the dialog
          surfaces the error and flips to a force `-D` retry button. */}
      <Dialog.Root
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
            <div className="flex items-start gap-3 pr-6">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <IconAlertTriangle size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title>{t("ide.git.deleteBranchQ")}</Dialog.Title>
                <Dialog.Description className="mt-1 break-all">
                  {t("ide.git.deleteBranchDesc", { branch: pendingDelete?.name ?? "" })}
                </Dialog.Description>
              </div>
            </div>
            {deleteError && (
              <div className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
                {deleteError}
              </div>
            )}
            {deleteError && deleteNeedsForce && (
              <div className="mt-2 text-[11px] text-content-muted">
                {t("ide.git.deleteBranchUnmerged")}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleDeleteBranch(deleteNeedsForce)}
                disabled={deleting}
              >
                {deleting ? <IconLoader2 size={12} className="animate-spin" /> : <IconTrash size={12} />}
                {deleteNeedsForce ? t("ide.git.deleteBranchForce") : t("common.delete")}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Merge-conflict: AI resolution dialog (shared with the worktree
          merge-back dialog) ── */}
      <MergeConflictResolveDialog
        open={conflictFiles !== null}
        onOpenChange={(o) => {
          if (!o) setConflictFiles(null);
        }}
        repoPath={repo.path}
        conflictedFiles={conflictFiles ?? []}
        source={conflictSource}
        branch={conflictBranch}
        onKickoff={() => {
          setError(null);
          void refresh();
        }}
        onAborted={() => {
          prependLog({ op: "mergeAbort", status: "success" });
          setConflictFiles(null);
          void refresh();
        }}
        onAbortError={(msg) => {
          setError(msg);
          prependLog({ op: "mergeAbort", status: "failure", message: msg });
        }}
      />

      {/* ── New branch dialog ──
          Creates a local branch from HEAD and switches to it. */}
      <Dialog.Root open={newBranchOpen} onOpenChange={setNewBranchOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
            <Dialog.Title>{t("ide.git.newBranch")}</Dialog.Title>
            <Dialog.Description className="mt-1">
              {t("ide.git.newBranchDesc")}
            </Dialog.Description>
            <input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                // 中文/日文输入法按 Enter 是"确认候选词",不是提交;组词期间 React
                // 的 keydown 仍会以 `key === "Enter"` 到达,漏了这条守卫就会用半截
                // 的拼音去建分支。兄弟处理器(FileTree/SearchDialog)都带这一条。
                if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) && newBranchName.trim()) void handleCreateBranch();
              }}
              autoFocus
              placeholder={t("ide.git.branchNamePlaceholder")}
              className="mt-3 w-full rounded-md border border-edge-input bg-surface px-2.5 py-1.5 text-xs text-content outline-none placeholder:text-content-subtle focus:border-accent"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setNewBranchOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleCreateBranch} disabled={!newBranchName.trim() || checkingOut}>
                {checkingOut ? <IconLoader2 size={12} className="animate-spin" /> : <IconPlus size={12} />}
                {t("ide.git.createAndSwitch")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Merge-branch confirm dialog ──
          Direction is FIXED (source → current branch) and stated in plain
          words — the classic merge usability trap is getting the direction
          backwards. The preview fetched on open tells the user what will
          happen (incoming commits / fast-forward / nothing to do) BEFORE the
          button becomes worth clicking. */}
      <Dialog.Root
        open={mergeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !merging) setMergeTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[400px] max-w-[90vw] p-4">
            <div className="flex items-start gap-3 pr-6">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                <IconGitMerge size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title>{t("ide.git.mergeBranch")}</Dialog.Title>
                <Dialog.Description className="mt-1">
                  {t("ide.git.mergeDesc", {
                    source: mergeTarget?.name ?? "",
                    target: status?.branch || "HEAD",
                  })}
                </Dialog.Description>
                <div className="mt-2 space-y-1 text-[11px]">
                  {mergePreviewLoading ? (
                    <div className="flex items-center gap-1.5 text-content-subtle">
                      <IconLoader2 size={12} className="animate-spin" />
                      {t("common.loading")}
                    </div>
                  ) : mergePreviewData?.ok ? (
                    mergePreviewData.upToDate ? (
                      <div className="flex items-center gap-1.5 text-content-subtle">
                        <IconCheck size={12} className="shrink-0 text-accent" />
                        {t("ide.git.mergeUpToDate")}
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5 text-content-muted">
                          <IconGitCommit size={12} className="shrink-0 text-content-subtle" />
                          {t("ide.git.mergeIncoming", { n: mergePreviewData.incomingCommits })}
                        </div>
                        {mergePreviewData.fastForward && (
                          <div className="flex items-center gap-1.5 text-content-muted">
                            <IconChevronDown size={12} className="shrink-0 text-info" />
                            {t("ide.git.mergeFastForward")}
                          </div>
                        )}
                      </>
                    )
                  ) : (
                    <div className="flex items-start gap-1.5 text-danger">
                      <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span className="break-words">
                        {mergePreviewData?.error ?? t("ide.git.mergePreviewFailed")}
                      </span>
                    </div>
                  )}
                  {/* Dirty working tree: git may refuse the merge (or mix in
                      uncommitted content). Warn loudly but don't block —
                      git itself rejects unsafe merges. */}
                  {(status?.files.length ?? 0) > 0 && (
                    <div className="flex items-start gap-1.5 text-warning">
                      <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                      {t("ide.git.mergeDirty")}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMergeTarget(null)} disabled={merging}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={handleMerge}
                disabled={merging || mergePreviewLoading || !mergePreviewData?.ok || mergePreviewData.upToDate}
              >
                {merging ? <IconLoader2 size={12} className="animate-spin" /> : <IconGitMerge size={12} />}
                {t("ide.git.merge")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
