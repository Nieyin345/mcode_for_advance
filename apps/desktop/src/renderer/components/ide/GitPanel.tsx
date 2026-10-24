import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore, selectActiveEnvPath } from "@renderer/stores/sessionStore.js";
import type { GitRepo } from "@contracts/ipc";
import { GitRepoCard } from "./GitRepoCard.js";
import { GitHistoryView } from "./GitHistoryView.js";
import { WorktreeManagerPanel } from "./WorktreeManagerPanel.js";
import { IconGitBranch, IconGitCommit, IconGitFork, IconLoader2, IconRefresh } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { GitScanGeneration } from "./gitScanGeneration.js";
import { gitScanMatchesProject, nextGitTabIndex } from "./gitPanelUiRules.js";

type GitSubTab = "changes" | "history" | "worktrees";

/**
 * Git panel — the right-panel "Git" tab body.
 *
 * Discovers all git repositories under the active project's root (a project
 * folder may contain multiple repos: monorepo, submodules, nested projects).
 *
 * Sub-tabs:
 *   - 更改: working-tree status / stage / commit via {@link GitRepoCard}
 *   - 历史: commit log + per-commit file list via {@link GitHistoryView}
 *
 * The scan runs on mount and whenever the active project changes. A manual
 * refresh button re-scans (useful after cloning a new repo into the folder).
 */
export function GitPanel() {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<GitSubTab>("changes");
  const tabPanelId = useId();

  // Follows the active session's environment — a materialized worktree
  // session gets the worktree's OWN repo in this panel (its commits, its
  // status); local sessions see the project's repos as before.
  const projectPath = useSessionStore(selectActiveEnvPath);

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scannedPath, setScannedPath] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  /** 扫描请求序号 —— 过期响应不许写状态(见 `scan`)。 */
  const scanGeneration = useRef(new GitScanGeneration());

  const scan = async (path: string) => {
    // **请求序号:只有最新一次扫描能写状态。** 快速在项目 A→B 之间切换时,
    // scan(A) 的 discoverRepos 可能**后**回来,把 A 的仓库列表写进 B 的页面。
    const seq = scanGeneration.current.next();
    setLoading(true);
    setScanError(null);
    setScannedPath(null);
    try {
      const { repos } = await api.git.discoverRepos({ projectPath: path });
      if (!scanGeneration.current.isCurrent(seq)) return;
      setRepos(repos);
      setScannedPath(path);
    } catch (err) {
      if (!scanGeneration.current.isCurrent(seq)) return;
      setRepos([]);
      setScanError(err instanceof Error ? err.message : String(err));
      setScannedPath(path);
    } finally {
      if (scanGeneration.current.isCurrent(seq)) setLoading(false);
    }
  };

  useEffect(() => {
    if (!projectPath) {
      // A pending discoverRepos(A) must not repopulate the Git panel after
      // switching to "no project". Invalidate even without a successor scan.
      scanGeneration.current.invalidate();
      setRepos([]);
      setScannedPath(null);
      setScanError(null);
      setLoading(false);
      return;
    }
    void scan(projectPath);
    // Also invalidate on unmount and while changing to another project.
    return () => scanGeneration.current.invalidate();
  }, [projectPath]);

  if (!projectPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconGitBranch size={20} className="text-content-subtle" />
        <p className="[font-size:var(--right-panel-font-size)] text-content-muted">{t("ide.files.noProjectTitle")}</p>
        <p className="[font-size:var(--right-panel-font-size)] text-content-subtle">{t("ide.git.noProjectHint")}</p>
      </div>
    );
  }

  // Render-time path guard: the prior checkout must not flash even for one
  // React commit before the passive rescan effect runs after a tab switch.
  if (loading || !gitScanMatchesProject(scannedPath, projectPath)) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 [font-size:var(--right-panel-font-size)] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.git.scanning")}
      </div>
    );
  }

  if (scanError) {
    return (
      <div role="alert" className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-5 text-center">
        <IconGitBranch size={20} className="text-danger" />
        <p className="[font-size:var(--right-panel-font-size)] font-medium text-danger">{t("common.error")}</p>
        <p className="max-w-full break-words text-[11px] text-content-subtle">{scanError}</p>
        <button type="button" onClick={() => void scan(projectPath)}
          className="cds-hover-ghost inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius-btn-xs)] border border-edge px-3 text-content-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <IconRefresh size={13} /> {t("ide.git.rescan")}
        </button>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconGitBranch size={20} className="text-content-subtle" />
        <p className="[font-size:var(--right-panel-font-size)] text-content-muted">{t("ide.git.noRepos")}</p>
        <p className="[font-size:var(--right-panel-font-size)] text-content-subtle">
          {t("ide.git.noReposHint", { path: projectPath })}
        </p>
        <button
          type="button"
          onClick={() => void scan(projectPath)}
          className="cds-hover-ghost mt-1 flex min-h-8 items-center gap-1 rounded px-3 py-1 [font-size:var(--right-panel-font-size)] text-content-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <IconRefresh size={11} /> {t("ide.git.rescan")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sub-tab strip: 更改 | 历史 + rescan */}
      <div className="flex shrink-0 items-center border-b border-edge">
      <div role="tablist" aria-label={t("ide.git.changes")} onKeyDown={(e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
        if (!(e.target instanceof Element)) return;
        const current = e.target.closest<HTMLButtonElement>("button[data-git-subtab]");
        if (!current) return;
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-git-subtab]"));
        const next = nextGitTabIndex(e.key, buttons.indexOf(current), buttons.length);
        if (next === null) return;
        e.preventDefault();
        buttons[next]?.focus();
        buttons[next]?.click();
      }} className="flex min-w-0 items-center">
        <SubTabButton
          panelId={tabPanelId}
          active={subTab === "changes"}
          onClick={() => setSubTab("changes")}
          icon={<IconGitBranch size={12} />}
          label={t("ide.git.changes")}
        />
        <SubTabButton
          panelId={tabPanelId}
          active={subTab === "history"}
          onClick={() => setSubTab("history")}
          icon={<IconGitCommit size={12} />}
          label={t("ide.git.history")}
        />
        <SubTabButton
          panelId={tabPanelId}
          active={subTab === "worktrees"}
          onClick={() => setSubTab("worktrees")}
          icon={<IconGitFork size={12} />}
          label={t("ide.git.worktreeTab")}
        />
      </div>
        <div className="ml-auto flex items-center gap-1 px-1.5">
          <span className="[font-size:var(--rp-fs-xxs)] text-content-subtle">{t("ide.git.repoCount", { n: repos.length })}</span>
          <button
            type="button"
            onClick={() => void scan(projectPath)}
            className="cds-hover-ghost flex size-8 items-center justify-center rounded-[var(--radius-btn-xs)] [font-size:var(--right-panel-font-size)] text-content-muted transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            title={t("ide.git.rescanRepos")}
            aria-label={t("ide.git.rescanRepos")}
          >
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      <div id={tabPanelId} role="tabpanel" aria-label={subTab === "changes" ? t("ide.git.changes") : subTab === "history" ? t("ide.git.history") : t("ide.git.worktreeTab")} className="flex min-h-0 flex-1 flex-col">
      {subTab === "changes" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="space-y-2">
            {repos.map((repo) => (
              <GitRepoCard key={repo.path} repo={repo} />
            ))}
          </div>
        </div>
      ) : subTab === "worktrees" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorktreeManagerPanel repos={repos} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <GitHistoryView repos={repos} />
        </div>
      )}
      </div>
    </div>
  );
}

function SubTabButton({
  panelId,
  active,
  onClick,
  icon,
  label,
}: {
  panelId: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      data-git-subtab=""
      aria-selected={active}
      aria-controls={panelId}
      className={cn(
        "flex min-h-9 min-w-0 items-center gap-1 px-2 py-1.5 [font-size:var(--right-panel-font-size)] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        active
          ? "border-b-2 border-accent text-content"
          : "border-b-2 border-transparent text-content-subtle hover:text-content-muted",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
