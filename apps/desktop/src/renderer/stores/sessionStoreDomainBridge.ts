/**
 * Temporary compatibility while callers migrate from the monolithic session
 * store. The three domain stores are the owners of these fields/actions.
 *
 * Two-way sync is required for pre-existing direct sessionStore.setState
 * writes (including initDeferred hydration). Patches are identity-guarded:
 * a domain action updates its own store, then legacy observers see the exact
 * same immutable field reference without echo/re-entry.
 *
 * This module imports no runtime sessionStore binding, so the dependency
 * graph is acyclic: sessionStore -> bridge -> domain stores.
 */
import type { StoreApi } from "zustand/vanilla";
import type { SessionState } from "./sessionStoreTypes.js";
import { useBrowserStore, bindBrowserPaneReveal } from "./browserStore.js";
import { useGitStore, bindGitActiveProject } from "./gitStore.js";
import { useCustomCommandsStore } from "./customCommandsStore.js";

const browserKeys = [
  "browserTabCount", "browserDeviceToolbarOpen", "browserTabs",
  "browserActiveTabId", "pendingBrowserUrl", "browserViewSuppressed",
] as const;
const gitKeys = [
  "gitDiffOpenMode", "gitDiffDialogTabs", "gitDiffDialogActiveId",
  "gitDiffDialogOpen", "gitDiffDialogViewMode", "gitDiffByProject",
  "collapsedGitRepos",
] as const;
const commandKeys = ["customCommandsByProject"] as const;

/** Narrow bridge, not a second reducer: copy only changed domain-owned fields. */
function mirror<T extends object>(
  main: StoreApi<SessionState>,
  domain: StoreApi<T>,
  keys: readonly string[],
): void {
  const diff = (target: object, source: object) => {
    const dest = target as Record<string, unknown>;
    const src = source as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const k of keys) if (!Object.is(dest[k], src[k])) changed[k] = src[k];
    return changed;
  };
  domain.subscribe((state) => {
    const patch = diff(main.getState(), state);
    if (Object.keys(patch).length > 0) main.setState(patch as Partial<SessionState>);
  });
  main.subscribe((state) => {
    const patch = diff(domain.getState(), state);
    if (Object.keys(patch).length > 0) domain.setState(patch as Partial<T>);
  });
}

export function connectSessionStoreDomains(main: StoreApi<SessionState>): void {
  // Both callbacks run only when an action is invoked, after all modules
  // have initialized. Browser navigation leaves layout/prefs in the shell.
  bindBrowserPaneReveal(() => {
    main.getState().setRightPanelTab("browser");
    main.setState({ rightOpen: true });
  });
  bindGitActiveProject(() => main.getState().activeProjectId);

  mirror(main, useBrowserStore, browserKeys);
  mirror(main, useGitStore, gitKeys);
  mirror(main, useCustomCommandsStore, commandKeys);
}
