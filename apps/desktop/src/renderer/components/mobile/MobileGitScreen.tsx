/**
 * MobileGitScreen — the mobile git panel (bottom-nav page of the web shell).
 *
 * A focused, mobile-first take on the desktop GitRepoCard: discover repos under
 * the active project, switch branches (bottom-sheet picker with search /
 * remote-tracking / new-branch flows), show changed/staged files with stage
 * toggles, edit a commit message (with AI generation), commit /
 * commit-and-push, and sync with the remote. Actions live in two contextual
 * zones instead of one button soup: the branch bar hosts the remote ops
 * (拉取 / 推送 / 同步, next to the ahead/behind counts they resolve), and the
 * commit box hosts the staging ops (提交 / 提交并推送). The operations map 1:1
 * to the `git:*` mobile RPC whitelist, which reuses the desktop git module's
 * helpers (same path guard, same simple-git loader, same LLM commit-message
 * core) — behavior is identical, only the transport differs.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { cn } from "@renderer/lib/cn.js";
import { Segmented } from "@renderer/components/ui/cds/Segmented.js";
import type { GitRepo, GitStatusResult, GitStatusCode, GitBranchInfo, GitBranchListResult } from "@contracts/ipc";
import {
  IconGitBranch,
  IconRefresh,
  IconX,
  IconLoader2,
  IconArrowDown,
  IconArrowUp,
  IconArrowsExchange,
  IconCheck,
  IconSparkles,
  IconFile,
  IconCopy,
  IconChevronDown,
  IconTag,
  IconPlus,
} from "@renderer/lib/icons.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { browserUuid } from "@renderer/lib/uuid.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { parsePatch, PatchRows } from "./PatchView.js";
import { BranchSheet, ErrorBanner, DiffOverlay } from "./MobileGitScreenParts.js";
export { DiffOverlay } from "./MobileGitScreenParts.js";

/** Compact per-status glyphs for the file-list badges. A KEY map, not resolved
 *  text — this table is module-level, so it has no access to the locale hook. */
const STATUS_LABEL: Record<GitStatusCode, MessageId> = {
  modified: "mobile.git.status.modified",
  added: "mobile.git.status.added",
  deleted: "mobile.git.status.deleted",
  renamed: "mobile.git.status.renamed",
  copied: "mobile.git.status.copied",
  unmerged: "mobile.git.status.unmerged",
  untracked: "mobile.git.status.untracked",
  ignored: "mobile.git.status.ignored",
  unmodified: "mobile.git.status.unmodified",
};

const STATUS_COLOR: Record<string, string> = {
  deleted: "bg-danger/15 text-danger",
  added: "bg-accent/15 text-accent",
  unmerged: "bg-warning/15 text-warning",
  untracked: "bg-surface-hover text-content-muted",
  modified: "bg-surface-hover text-content-muted",
  renamed: "bg-surface-hover text-content-muted",
  copied: "bg-surface-hover text-content-muted",
};

export function MobileGitScreen() {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  // True while repo discovery is in flight — distinguishes "still looking"
  // from "looked and found none" (the latter shows the no-repo empty state).
  const [reposLoading, setReposLoading] = useState(true);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [tab, setTab] = useState<"changes" | "staged">("changes");
  const [message, setMessage] = useState("");
  // Commit message textarea: 1 row by default, auto-grows with the content up
  // to ~4 rows (keeps the bottom bar compact; mirrors the desktop CommitBox).
  const msgRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = msgRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.style.height = `${Math.max(Math.min(ta.scrollHeight, lineHeight * 4), 44)}px`;
  }, [message]);
  const [busy, setBusy] = useState<string | null>(null);
  const [genLoading, setGenLoading] = useState(false);
  // Set when the user stops an in-flight generation: the aborted call's
  // result/error must NOT overwrite the commit message box (mirrors the
  // desktop GitRepoCard CommitBox).
  const genCancelledRef = useRef(false);
  const genRequestIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<{ path: string; staged: boolean } | null>(null);
  // Branch-switcher bottom sheet (opened by tapping the branch in the status
  // bar). The heavy lifting (list / search / checkout / create) lives in
  // BranchSheet; the parent only refreshes after a successful switch.
  const [branchSheetOpen, setBranchSheetOpen] = useState(false);

  // Discover repos when the project changes.
  //
  // The seq guard is not optional here. The phone talks to the desktop over
  // the LAN, and discovery walks the project tree — hundreds of milliseconds
  // is normal, so switching projects while one is in flight is the common
  // case, and the two replies can land in either order. Without the guard the
  // late reply of the OLD project wins: repos/repoPath (and the status that
  // follows them) come from the project the user already left. Same pattern
  // the children already use (BranchSheet / DiffOverlay / FileViewer use a
  // `cancelled` flag); these two top-level loaders were the hole.
  const discoverSeq = useRef(0);
  const discover = useCallback(async () => {
    const seq = ++discoverSeq.current;
    const fresh = () => discoverSeq.current === seq;
    if (!project) {
      setReposLoading(false);
      return;
    }
    setReposLoading(true);
    try {
      const res = await api.git.discoverRepos({ projectPath: project.path });
      if (!fresh()) return;
      setRepos(res.repos);
      if (res.repos.length > 0) setRepoPath(res.repos[0].path);
    } catch (err) {
      if (fresh()) setError((err as Error).message);
    } finally {
      if (fresh()) setReposLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setRepoPath(null);
    setStatus(null);
    void discover();
  }, [discover]);

  // Refresh status whenever repoPath changes (and expose a manual refresh).
  //
  // Same guard, and this one is the one that bites: `status` drives the file
  // list, while 暂存 / 提交 send the CURRENT `repoPath`. A late reply from the
  // repo the user just left leaves the two disagreeing — tapping 暂存 on a
  // listed file then sends the old repo's path to the new repo. Last request
  // wins (the manual refresh button and the `git.changed` broadcast funnel
  // through here too, so "latest" is the only correct winner).
  const statusSeq = useRef(0);
  const refresh = useCallback(async () => {
    if (!repoPath) return;
    const seq = ++statusSeq.current;
    try {
      const res = await api.git.status({ repoPath });
      if (statusSeq.current !== seq) return;
      setStatus(res.status);
    } catch (err) {
      if (statusSeq.current === seq) setError((err as Error).message);
    }
  }, [repoPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cross-client auto-refresh: the host broadcasts `git.changed` after ANY
  // client's git mutation (desktop panel, another phone), which bumps this
  // per-repo version in the store. Re-running status keeps this screen fresh
  // when, say, the agent (or the PC) commits while the phone sits on the Git
  // tab. Own mutations echo back too — idempotent extra refresh.
  const gitChangeVersion = useSessionStore(
    (s) => (repoPath ? s.gitChangeVersionByRepo[repoPath] ?? 0 : 0),
  );
  useEffect(() => {
    void refresh();
  }, [gitChangeVersion, refresh]);

  // Same staged/unstaged split as the desktop GitRepoCard.
  const staged = useMemo(
    () => status?.files.filter((f) => f.index !== "unmodified" && f.index !== "untracked") ?? [],
    [status],
  );
  const unstaged = useMemo(
    () => status?.files.filter((f) => f.workingTree !== "unmodified" || f.index === "untracked") ?? [],
    [status],
  );
  const list = tab === "changes" ? unstaged : staged;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Lightweight success feedback for remote/commit ops (3s toast). Errors
  // still go through the inline ErrorBanner for full detail + copy.
  const toast = (title: string) =>
    useToastStore.getState().push({ kind: "info", title, duration: 3000 });

  const stage = (path: string) =>
    run("stage", () => api.git.stage({ repoPath: repoPath!, filePaths: [path] }));
  const unstage = (path: string) =>
    run("unstage", () => api.git.unstage({ repoPath: repoPath!, filePaths: [path] }));

  const commit = (andPush: boolean) =>
    run(andPush ? "commit+push" : "commit", async () => {
      if (!message.trim()) {
        setError(t("mobile.git.commitMsgRequired"));
        return;
      }
      const res = await api.git.commit({ repoPath: repoPath!, message: message.trim() });
      if (!res.ok) throw new Error(res.error ?? t("ide.git.commitFailed"));
      setMessage("");
      toast(t("mobile.git.committed"));
      if (andPush) {
        const pushRes = await api.git.push({ repoPath: repoPath! });
        if (!pushRes.ok) throw new Error(pushRes.error ?? t("ide.git.pushFailed"));
        toast(t("mobile.git.pushed"));
      }
    });

  /** Pull only — never pushes. A merge conflict surfaces as an error banner
   *  and stops there (nothing is auto-committed past a conflict). */
  const pull = () =>
    run("pull", async () => {
      const res = await api.git.pull({ repoPath: repoPath! });
      if (!res.ok) throw new Error(res.error ?? t("ide.git.pullFailed"));
      if (res.conflict) {
        setError(t("mobile.git.conflicts", { n: res.conflictedFiles?.length ?? 0 }));
        return;
      }
      toast(t("mobile.git.pulled"));
    });

  /** Push only — local commits to the remote. */
  const push = () =>
    run("push", async () => {
      const res = await api.git.push({ repoPath: repoPath! });
      if (!res.ok) throw new Error(res.error ?? t("ide.git.pushFailed"));
      toast(t("mobile.git.pushDone"));
    });

  /** Pull then push (desktop's "sync"). Never pushes past a merge conflict. */
  const sync = () =>
    run("sync", async () => {
      const pullRes = await api.git.pull({ repoPath: repoPath! });
      if (!pullRes.ok) throw new Error(pullRes.error ?? t("ide.git.pullFailed"));
      if (pullRes.conflict) {
        setError(t("mobile.git.conflicts", { n: pullRes.conflictedFiles?.length ?? 0 }));
        return;
      }
      const pushRes = await api.git.push({ repoPath: repoPath! });
      if (!pushRes.ok) throw new Error(pushRes.error ?? t("ide.git.pushFailed"));
      toast(t("mobile.git.synced"));
    });

  const generate = async () => {
    setGenLoading(true);
    genCancelledRef.current = false;
    setError(null);
    // browserUuid, not crypto.randomUUID: the mobile shell runs over plain
    // HTTP on the LAN where crypto.randomUUID is undefined (non-secure
    // context) and the direct call crashes with a TypeError.
    const requestId = browserUuid();
    genRequestIdRef.current = requestId;
    try {
      // commitGenModel is stored as "configId:roleKey" — split it back, same as
      // the desktop GitRepoCard. Null means no model is configured: the main-
      // process core would fall back to the built-in Claude binary, which on a
      // machine without a Claude login errors with "Not logged in · Please run
      // login" — so guard here with an actionable message instead.
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
      if (!customModelId) {
        setError(t("mobile.git.noGenModel"));
        return;
      }
      const res = await api.git.generateCommitMessage({
        repoPath: repoPath!,
        customModelId,
        customModelRole,
        prompt: commitGenPrompt,
        requestId,
      });
      if (genCancelledRef.current) return; // aborted by the user — keep the box as-is
      if (res.ok && res.message) setMessage(res.message);
      else if (!res.ok) setError(res.error ?? t("ide.git.genFailed"));
    } catch (err) {
      if (!genCancelledRef.current) setError((err as Error).message);
    } finally {
      genRequestIdRef.current = null;
      setGenLoading(false);
    }
  };

  /** Stop the in-flight generation (hover affordance on the generate button). */
  const stopGenerate = () => {
    genCancelledRef.current = true;
    const id = genRequestIdRef.current;
    if (id) void api.git.cancelGenerateCommitMessage({ requestId: id }).catch(() => {});
    setGenLoading(false);
  };

  return (
    <div className="flex h-full min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="text-body font-medium text-content">Git</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-btn-md)] text-content-muted active:bg-surface-muted"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >
          <IconRefresh size={15} />
        </button>
      </div>

      {!project ? (
        <div className="p-6 text-center text-code text-content-subtle">
          {t("browser.selectProjectFirst")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
          {/* repo selector */}
          {repos.length > 1 && (
            <select
              value={repoPath ?? ""}
              onChange={(e) => setRepoPath(e.target.value)}
              className="mb-2 min-h-11 w-full rounded-[var(--radius-btn-md)] border border-input-edge bg-surface px-2 py-1.5 text-code text-content outline-none"
            >
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
            </select>
          )}

          {/* Branch status + remote actions — one bar. The branch chip is a
              tappable button: it opens the branch-switcher sheet (chevron is
              the affordance). The ahead/behind counts sit OUTSIDE the button —
              they are read-only state, not part of the tap target. The three
              sync buttons dock right of the bar and reuse the ↑/↓ arrows so
              each button pairs with the count it resolves (push ↔ ↑ahead,
              pull ↔ ↓behind). */}
          {status && (
            <div className="mb-2 flex shrink-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1 text-code text-content-muted">
                <button
                  type="button"
                  onClick={() => setBranchSheetOpen(true)}
                  disabled={!!busy || !repoPath}
                  title={t("ide.git.switchBranch")}
                  className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-[var(--radius-btn-md)] py-1 pl-1 pr-1.5 active:bg-surface-hover disabled:opacity-50"
                >
                  <IconGitBranch size={13} className="shrink-0" />
                  <span className="min-w-0 max-w-[38vw] truncate font-mono text-content">
                    {status.branch || t("ide.git.noBranches")}
                  </span>
                  <IconChevronDown size={12} className="shrink-0 text-content-subtle" />
                </button>
                {status.ahead > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-accent"
                    title={t("mobile.git.aheadTitle", { n: status.ahead })}
                  >
                    <IconArrowUp size={11} /> {status.ahead}
                  </span>
                )}
                {status.behind > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-warning"
                    title={t("mobile.git.behindTitle", { n: status.behind })}
                  >
                    <IconArrowDown size={11} /> {status.behind}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void pull()}
                disabled={!!busy || !repoPath}
                title={t("mobile.git.pullHint")}
                className="flex h-11 shrink-0 items-center gap-1 rounded-[var(--radius-btn-md)] border border-edge px-2.5 text-code text-content-muted active:bg-surface-hover disabled:opacity-50"
              >
                {busy === "pull" ? (
                  <IconLoader2 size={12} className="animate-spin" />
                ) : (
                  <IconArrowDown size={12} />
                )}
                {t("ide.git.pull")}
              </button>
              <button
                type="button"
                onClick={() => void push()}
                disabled={!!busy || !repoPath}
                title={t("mobile.git.pushHint")}
                className="flex h-11 shrink-0 items-center gap-1 rounded-[var(--radius-btn-md)] border border-edge px-2.5 text-code text-content-muted active:bg-surface-hover disabled:opacity-50"
              >
                {busy === "push" ? (
                  <IconLoader2 size={12} className="animate-spin" />
                ) : (
                  <IconArrowUp size={12} />
                )}
                {t("ide.git.push")}
              </button>
              <button
                type="button"
                onClick={() => void sync()}
                disabled={!!busy || !repoPath}
                title={t("mobile.git.syncHint")}
                className="flex h-11 shrink-0 items-center gap-1 rounded-[var(--radius-btn-md)] border border-edge px-2.5 text-code text-content-muted active:bg-surface-hover disabled:opacity-50"
              >
                {busy === "sync" ? (
                  <IconLoader2 size={12} className="animate-spin" />
                ) : (
                  <IconArrowsExchange size={12} />
                )}
                {t("ide.git.sync")}
              </button>
            </div>
          )}

          {/* Discovery / no-repo empty states replace the whole working area —
              the tabs, file list, and commit box are meaningless without a
              repo. */}
          {reposLoading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-code text-content-subtle">
              {t("mobile.git.discovering")}
            </div>
          ) : repos.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-code text-content-subtle">
              {t("mobile.git.noRepos")}
            </div>
          ) : (
            <>
          {/* 【ARC-005 V2】二选一改用共享 CDS 分段控件，与配对/抽屉/侧栏同一套
              几何与磁吸物理。计数仍由 badge 承载。 */}
          <Segmented
            label={t("mobile.git.tabSwitch")}
            size="md"
            className="mb-2 h-11 shrink-0 [&_button]:min-h-11"
            value={tab}
            onChange={(v) => setTab(v as "changes" | "staged")}
            items={[
              {
                id: "changes",
                label: t("ide.git.changes"),
                badge: unstaged.length > 0 ? unstaged.length : undefined,
              },
              {
                id: "staged",
                label: t("ide.git.staged"),
                badge: staged.length > 0 ? staged.length : undefined,
              },
            ]}
          />

          {/* file list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.length === 0 ? (
              <div className="p-6 text-center text-code text-content-subtle">
                {tab === "changes" ? t("mobile.git.noUnstaged") : t("mobile.git.noStaged")}
              </div>
            ) : (
              list.map((f) => {
                const code = tab === "changes" ? f.workingTree : f.index;
                return (
                  <div key={f.path} className="flex items-center gap-2 border-b border-edge px-1 py-2">
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold",
                        STATUS_COLOR[code] ?? "bg-surface-hover text-content-muted",
                      )}
                    >
                      {t(STATUS_LABEL[code])}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDiffPath({ path: f.path, staged: tab === "staged" })}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 truncate text-left text-code text-content"
                      title={f.path}
                    >
                      <IconFile size={12} className="shrink-0 text-content-subtle" />
                      <span className="truncate">{f.path}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => (tab === "changes" ? void stage(f.path) : void unstage(f.path))}
                      disabled={!!busy}
                      className="h-11 shrink-0 rounded-[var(--radius-btn-md)] border border-edge px-3 text-[11px] text-content-muted active:bg-surface-hover disabled:opacity-50"
                    >
                      {tab === "changes" ? t("ide.git.stage") : t("common.cancel")}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Commit message — single-row textarea that auto-grows. The
              AI-generate action is a standalone full-width button BELOW the
              input (not an absolute-positioned overlay): the overlay variant
              sat inside the textarea's padding box, where phone browsers
              frequently swallowed the tap (IME/long-press selection). Same
              affordances as the desktop CommitBox — tap again to stop. */}
          <div className="shrink-0 border-t border-edge pt-2">
            <textarea
              ref={msgRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("mobile.git.commitPlaceholder")}
              rows={1}
              className="mb-2 min-h-11 w-full resize-none overflow-hidden rounded-[var(--radius-btn-md)] border border-input-edge bg-surface-muted px-2 py-1.5 text-code leading-relaxed text-content outline-none focus:border-accent"
            />
            {commitGenModel && (
              <button
                type="button"
                onClick={() => (genLoading ? stopGenerate() : void generate())}
                disabled={!repoPath || staged.length === 0}
                title={genLoading ? t("ide.git.stopGenerate") : t("ide.git.generateHint")}
                aria-label={genLoading ? t("ide.git.stopGenerate") : t("ide.git.generateHint")}
                className="mb-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[var(--radius-btn-md)] border border-edge px-2 py-1.5 text-code text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-40"
              >
                {genLoading ? (
                  <>
                    <IconLoader2 size={14} className="animate-spin" />
                    {t("ide.git.stopGenerate")}
                  </>
                ) : (
                  <>
                    <IconSparkles size={14} />
                    {t("mobile.git.generate")}
                  </>
                )}
              </button>
            )}
            {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void commit(false)}
                disabled={!!busy || staged.length === 0 || !message.trim()}
                className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-[var(--radius-btn-md)] border border-edge px-2 py-2.5 text-code text-content-muted active:bg-surface-hover disabled:opacity-50"
              >
                {busy === "commit" ? <IconLoader2 size={12} className="animate-spin" /> : <IconCheck size={12} />}
                {t("ide.git.commit")}
              </button>
              <button
                type="button"
                onClick={() => void commit(true)}
                disabled={!!busy || staged.length === 0 || !message.trim()}
                className="flex min-h-11 flex-[1.4] items-center justify-center gap-1 rounded-[var(--radius-btn-md)] bg-accent px-2 py-2.5 text-code font-semibold text-surface disabled:opacity-40"
              >
                {busy === "commit+push" ? <IconLoader2 size={12} className="animate-spin" /> : <IconCheck size={12} />}
                {t("ide.git.commitAndPush")}
              </button>
            </div>
          </div>
            </>
          )}
        </div>
      )}

      {branchSheetOpen && repoPath && (
        <BranchSheet
          repoPath={repoPath}
          onClose={() => setBranchSheetOpen(false)}
          onChanged={refresh}
        />
      )}

      {diffPath && repoPath && (
        <DiffOverlay repoPath={repoPath} file={diffPath} onClose={() => setDiffPath(null)} />
      )}
    </div>
  );
}
