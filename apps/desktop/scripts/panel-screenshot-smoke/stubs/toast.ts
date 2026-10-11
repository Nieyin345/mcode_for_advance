/** `@renderer/stores/toastStore.js` 的替身 —— 本套不弹提示,给一个空 push 就够。 */
export const useToastStore = {
  getState: (): { push: (...args: unknown[]) => void } => ({ push: () => {} }),
};
