/** Git diff UI and per-project transient snapshot state. */
import { create } from "zustand";
import type { SessionState } from "./sessionStoreTypes.js";
import { api } from "@renderer/lib/api.js";
import { UI_GIT_DIFF_OPEN_MODE_SETTING_KEY, UI_GIT_COLLAPSED_REPOS_SETTING_KEY } from "@contracts/ipc";

type GitKeys =
  | "gitDiffOpenMode" | "gitDiffDialogTabs" | "gitDiffDialogActiveId"
  | "gitDiffDialogOpen" | "gitDiffDialogViewMode" | "gitDiffByProject"
  | "collapsedGitRepos" | "setGitDiffOpenMode" | "openGitDiffDialogTab"
  | "closeGitDiffDialogTab" | "setGitDiffDialogActive" | "setGitDiffDialogOpen"
  | "setGitDiffDialogViewMode" | "setGitDiffBefore" | "setGitDiffPair"
  | "clearGitDiffBefore" | "toggleCollapsedGitRepo";
export type GitState = Pick<SessionState, GitKeys>;

// Lazily wired, so neither store needs to import the other (no cycle).
let activeProject: () => string | null = () => null;
export function bindGitActiveProject(resolver: () => string | null): void {
  activeProject = resolver;
}

export const useGitStore = create<GitState>((set, get) => ({
  gitDiffOpenMode: "center",
  gitDiffDialogTabs: [],
  gitDiffDialogActiveId: null,
  gitDiffDialogOpen: false,
  gitDiffDialogViewMode: "single",
  gitDiffByProject: {},
  collapsedGitRepos: {},

  setGitDiffOpenMode: (mode) => {
    set({ gitDiffOpenMode: mode });
    void api.setting
      .set({ key: UI_GIT_DIFF_OPEN_MODE_SETTING_KEY, value: mode })
      .catch((err) => console.error("setting.set(gitDiffOpenMode) failed:", err));
  },
  openGitDiffDialogTab: (tab) => {
    set((s) => {
      const existing = s.gitDiffDialogTabs.find((t) => t.id === tab.id);
      const tabs = existing
        ? s.gitDiffDialogTabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
        : [...s.gitDiffDialogTabs, tab];
      return {
        gitDiffDialogTabs: tabs,
        gitDiffDialogActiveId: tab.id,
        gitDiffDialogOpen: true,
      };
    });
  },
  closeGitDiffDialogTab: (id) => {
    set((s) => {
      const idx = s.gitDiffDialogTabs.findIndex((t) => t.id === id);
      if (idx === -1) return {};
      const tabs = s.gitDiffDialogTabs.filter((t) => t.id !== id);
      let activeId = s.gitDiffDialogActiveId;
      let open = s.gitDiffDialogOpen;
      if (activeId === id) {
        activeId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? null;
        open = tabs.length > 0;
      }
      return { gitDiffDialogTabs: tabs, gitDiffDialogActiveId: activeId, gitDiffDialogOpen: open };
    });
  },
  setGitDiffDialogActive: (id) => set({ gitDiffDialogActiveId: id }),
  setGitDiffDialogOpen: (open) => set({ gitDiffDialogOpen: open }),
  setGitDiffDialogViewMode: (mode) => set({ gitDiffDialogViewMode: mode }),
  setGitDiffBefore: (filePath, before) => get().setGitDiffPair(filePath, { before }),
  setGitDiffPair: (filePath, pair) => {
    const pid = activeProject();
    if (!pid) return;
    set((s) => ({
      gitDiffByProject: {
        ...s.gitDiffByProject,
        [pid]: { ...(s.gitDiffByProject[pid] ?? {}), [filePath]: pair },
      },
    }));
  },
  clearGitDiffBefore: (filePath) => {
    const pid = activeProject();
    if (!pid) return;
    set((s) => {
      const projMap = s.gitDiffByProject[pid];
      if (!projMap || !(filePath in projMap)) return {};
      const next = { ...projMap };
      delete next[filePath];
      return { gitDiffByProject: { ...s.gitDiffByProject, [pid]: next } };
    });
  },
  toggleCollapsedGitRepo: (repoPath) => {
    set((s) => {
      const next = { ...s.collapsedGitRepos };
      if (next[repoPath]) delete next[repoPath];
      else next[repoPath] = true;
      void api.setting
        .set({ key: UI_GIT_COLLAPSED_REPOS_SETTING_KEY, value: JSON.stringify(next) })
        .catch((err) => console.error("setting.set(gitCollapsedRepos) failed:", err));
      return { collapsedGitRepos: next };
    });
  },
}));
