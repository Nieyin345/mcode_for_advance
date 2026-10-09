// 记名 toast 替身:`customUiStore.setToolbarCollapsed` 落盘失败那条路要用它断言,其余场景
// (save 的失败 toast)也会经过它 —— 所以不能像从前那样是个纯 no-op,否则"静默失败"根本
// 观测不到。`reset()` 在每个回归段之间清一次,避免不同段互相串。
export interface RecordedToast { kind: string; title: string; body?: string; }
const pushed: RecordedToast[] = [];
export const useToastStore = {
  getState: () => ({
    push: (t: RecordedToast) => {
      pushed.push(t);
    },
  }),
};
/** 测试用:取已记录的 toast、清空。 */
export const __toasts = pushed;
export const resetToasts = (): void => {
  pushed.length = 0;
};
export type ToastKind = string;
