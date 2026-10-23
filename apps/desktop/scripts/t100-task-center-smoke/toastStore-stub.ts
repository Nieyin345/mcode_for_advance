/**
 * `@renderer/stores/toastStore.js` 替身 —— 记录 push 过的 toast。
 *
 * 「写失败不吞」那条判据要看主进程的错误原话有没有真的传给用户，所以把
 * `getState().push` 记下来，断言直接查它。
 */
export interface ToastRecord {
  kind: string;
  title: string;
  body?: string;
}

export const toasts: ToastRecord[] = [];

export function __toasts(): ToastRecord[] {
  return toasts;
}
export function __resetToasts(): void {
  toasts.length = 0;
}

const state = {
  push(t: ToastRecord): void {
    toasts.push(t);
  },
};

export function useToastStore<T>(selector?: (s: typeof state) => T): T | typeof state {
  return selector ? selector(state) : state;
}
useToastStore.getState = () => state;
