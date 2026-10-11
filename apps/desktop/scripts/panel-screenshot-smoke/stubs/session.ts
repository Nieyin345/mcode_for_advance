/** `@renderer/stores/sessionStore.js` 的替身 —— 本套只走 `panel_rect` 分支(不碰会话),
 *  真那个 import 一大堆主进程/ IPC。给一个空 store 就够。 */
export const useSessionStore = {
  getState: (): Record<string, unknown> => ({}),
};
