/**
 * Browser tab and device emulation state. The session store exposes a legacy
 * compatibility facade, but this Zustand instance owns the browser fields.
 * The overlay/layout switch deliberately remains with the layout domain.
 */
import { create } from "zustand";
import type { SessionState, BrowserTab } from "./sessionStoreTypes.js";

type BrowserKeys =
  | "browserTabCount" | "browserDeviceToolbarOpen" | "browserTabs"
  | "browserActiveTabId" | "pendingBrowserUrl" | "browserViewSuppressed"
  | "setBrowserTabCount" | "setBrowserDeviceToolbarOpen" | "suppressBrowserView"
  | "setBrowserTabs" | "setBrowserActiveTabId" | "addBrowserTab"
  | "removeBrowserTab" | "patchBrowserTab" | "openUrlInBrowser"
  | "adoptAgentBrowserTab";
export type BrowserState = Pick<SessionState, BrowserKeys> & {
  /** URL queue consumption is an explicit action; used by the browser panel. */
  setPendingBrowserUrl: (url: string | null) => void;
};

// Inject the host layout transition rather than importing sessionStore at
// module load time (no browserStore -> sessionStore -> browserStore cycle).
let revealBrowserPane: (() => void) | null = null;
export function bindBrowserPaneReveal(reveal: () => void): void {
  revealBrowserPane = reveal;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  browserTabCount: 0,
  browserDeviceToolbarOpen: false,
  browserTabs: [],
  browserActiveTabId: null,
  pendingBrowserUrl: null,
  browserViewSuppressed: 0,

  setBrowserTabCount: (count) => set({ browserTabCount: Math.max(0, count) }),
  setBrowserDeviceToolbarOpen: (open) => set({ browserDeviceToolbarOpen: open }),
  suppressBrowserView: (suppressed) =>
    set((s) => ({ browserViewSuppressed: Math.max(0, s.browserViewSuppressed + (suppressed ? 1 : -1)) })),
  setBrowserTabs: (tabs) => set({ browserTabs: tabs }),
  setBrowserActiveTabId: (id) => set({ browserActiveTabId: id }),
  setPendingBrowserUrl: (url) => set({ pendingBrowserUrl: url }),
  addBrowserTab: (tab) => set((s) => ({ browserTabs: [...s.browserTabs, tab] })),
  removeBrowserTab: (id) =>
    set((s) => ({ browserTabs: s.browserTabs.filter((t) => t.id !== id) })),
  patchBrowserTab: (browserId, patch) =>
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => (t.browserId === browserId ? { ...t, ...patch } : t)),
    })),
  openUrlInBrowser: (url) => {
    // The right-panel tab preference is owned by the shell. The injected
    // transition retains the original setRightPanelTab + rightOpen behavior.
    revealBrowserPane?.();
    set({ pendingBrowserUrl: url });
  },
  adoptAgentBrowserTab: (browserId, info) => {
    const s = get();
    const existing = s.browserTabs.find((t) => t.browserId === browserId);
    if (existing) {
      // Never reset device emulation on an agent navigation.
      if (info.url || info.title) {
        set({
          browserTabs: s.browserTabs.map((t) =>
            t.browserId === browserId
              ? {
                  ...t,
                  ...(typeof info.url === "string" ? { url: info.url } : {}),
                  ...(typeof info.title === "string" ? { title: info.title } : {}),
                }
              : t,
          ),
        });
      }
      if (s.browserActiveTabId !== existing.id) set({ browserActiveTabId: existing.id });
      return false;
    }
    const tab: BrowserTab = {
      id: `agent-${browserId}`,
      browserId,
      url: info.url ?? "",
      title: info.title ?? "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pickMode: false,
      device: info.device ?? "desktop",
      orientation: info.orientation,
    };
    set({ browserTabs: [...s.browserTabs, tab], browserActiveTabId: tab.id });
    return true;
  },
}));
