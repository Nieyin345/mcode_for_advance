/**
 * `libraryPreview` / `contentTag` / `sessionStoreHelpers` 的 store 依赖桩。
 *
 * 只记录副作用（`libraryAudit` / `sessionAudit`），不做任何数据读写 ——
 * 本套验的是"判据走哪条分支"，不是 store 本身。
 *
 * ⚠️ `sessionStoreHelpers` 在模块顶层 import 了会话 store 的**类型**（擦除）、
 * `fileViewStore`、`api`、`i18n` 等真模块。为了不把整个 store 图拉进 bundle，
 * run.sh 把 `@renderer/stores/sessionStore.js` / `@renderer/lib/api.js` 等
 * 换成直通桩（见那边的 alias 列表）。本文件提供库预览那一支需要的两个 store。
 */

export const libraryAudit: string[] = [];
export const sessionAudit: string[] = [];

export const useLibraryStore = {
  getState: () => ({
    setActiveItem: (id: string) => libraryAudit.push(`id:${id}`),
    setDetailTab: (tab: string) => libraryAudit.push(`tab:${tab}`),
  }),
};

export const useSessionStore = {
  getState: () => ({
    setRightPanelTab: (tab: string) => sessionAudit.push(`tab:${tab}`),
    setRightOpen: (open: boolean) => sessionAudit.push(`right:${open}`),
  }),
};
