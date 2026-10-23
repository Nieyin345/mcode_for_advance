/**
 * `@renderer/stores/sessionStore.js` 替身。
 *
 * 被测组件里唯一碰 store 的是 `useRpc`（它读 `locale` 给 toast 用）；本套把
 * `useRpc` 也换成了可驱动的桩（见 build.mjs 的 alias），但 `FileEditor` 的渲染
 * 测试段要跑**真** `FileEditor` —— 它直接读 `useSessionStore` 的多个 slice
 * （activeProjectId / ideFileViewModeByProject / ideEditorMode / nav 栈 / lsp 相位 /
 * shortcutOverrides / projects）以及 `getState()`（`restartLsp` 与 `useGitDiffPair`
 * 的兜底）。这里给一个**最小可编程 store**：selector 在 `state` 上跑，setter 真的
 * 改写 state，于是"点一下工具栏，偏好真的变了、下一次渲染切到了另一个 pane"这条
 * 链路是**真代码**走通的。
 *
 * ⚠️ `useI18n` 也被换成本文件的 `useI18n`（真词典 + 固定 locale），保证"未构建"
 * 这类判据立在**用户看到的那行字**上，而不是 key。
 */
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";

export interface SmokeState {
  activeProjectId: string | null;
  activeSessionId: string | null;
  turnFilesBySession: Record<string, Array<{ filePath: string; before?: string }>>;
  gitDiffByProject: Record<string, Record<string, { before: string; after?: string }>>;
  editorTheme: { dark: string; light: string };
  ideFileViewModeByProject: Record<string, Record<string, string>>;
  ideEditorMode: "tabs" | "replace";
  ideDiffBeforeByProject: Record<string, Record<string, string>>;
  navBackByProject: Record<string, unknown[]>;
  navForwardByProject: Record<string, unknown[]>;
  lspPhasesByWorkspace: Record<string, unknown>;
  shortcutOverrides: Record<string, string>;
  projects: Array<{ id: string; path: string }>;
  locale: "zh" | "en";
  setIdeFileViewMode: (filePath: string, mode: string) => void;
  setIdeEditorMode: (mode: "tabs" | "replace") => void;
  navigateBack: () => void;
  navigateForward: () => void;
}

export const state: SmokeState = {
  activeProjectId: "project-a",
  activeSessionId: null,
  turnFilesBySession: {},
  gitDiffByProject: {},
  editorTheme: { dark: "mcode-dark", light: "mcode-light" },
  ideFileViewModeByProject: { "project-a": {}, "project-b": {} },
  ideEditorMode: "tabs",
  ideDiffBeforeByProject: {},
  navBackByProject: {},
  navForwardByProject: {},
  lspPhasesByWorkspace: {},
  shortcutOverrides: {},
  projects: [],
  locale: "zh",
  setIdeFileViewMode(filePath, mode) {
    const pid = state.activeProjectId;
    if (!pid) return;
    const prev = state.ideFileViewModeByProject[pid] ?? {};
    state.ideFileViewModeByProject[pid] = { ...prev, [filePath]: mode };
  },
  setIdeEditorMode(mode) {
    state.ideEditorMode = mode;
  },
  navigateBack() {},
  navigateForward() {},
};

export function useSessionStore<T>(selector: (s: SmokeState) => T): T {
  return selector(state);
}
useSessionStore.getState = (): SmokeState => state;

export function selectActiveEnvPath(): string | undefined {
  return undefined;
}

/** 真词典 + 固定 locale —— 判据看汉字不看成 key。 */
export function useI18n() {
  return {
    locale: state.locale,
    t: (key: MessageId, params?: Record<string, string | number>) => translate(state.locale, key, params),
  };
}
