/**
 * `@renderer/stores/libraryStore.js` 替身 —— 只够 `PreviewPanel` 读它需要的那几格。
 *
 * `PreviewPanel` 用 `useLibraryStore(selector)` 选 `activeItemId` / `previewWhich` /
 * 条目本体，并按 `useLibraryStore.getState().openPreview` 切回 PDF。真 zustand 在这里
 * 是多余的：这套没有 React 状态要驱动，直接对固定 state 跑 selector 即可。
 */
type OpenPreviewCall = { id: string; which?: "pdf" | "md" };

let state: Record<string, unknown> = {
  activeItemId: null,
  previewWhich: null,
  itemsByCollection: {},
  allItems: null,
};
let openPreviewCalls: OpenPreviewCall[] = [];

type Selector = (s: typeof state) => unknown;
type Store = ((selector?: Selector) => unknown) & {
  getState: () => Record<string, unknown> & {
    openPreview: (id: string, which?: "pdf" | "md") => void;
  };
};

export const useLibraryStore = ((selector?: Selector) =>
  selector ? selector(state) : state) as Store;

useLibraryStore.getState = () => ({
  ...state,
  openPreview: (id: string, which?: "pdf" | "md") => openPreviewCalls.push({ id, which }),
});

/** 测试侧:布置 state;传 `openPreviewCalls` 会顺带清空已记录的调用。 */
export function __setState(next: Partial<typeof state>): void {
  state = { ...state, ...next };
  if ("openPreviewCalls" in next) openPreviewCalls = [];
}

/** 测试侧:读 `openPreview` 的调用记录。 */
export function __openPreviewCalls(): OpenPreviewCall[] {
  return openPreviewCalls;
}

/** 测试侧:清空调用记录。 */
export function __resetCalls(): void {
  openPreviewCalls = [];
}
