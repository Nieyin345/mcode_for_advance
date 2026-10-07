/** 预览台用的最小 store 替身 —— WorkflowFlowMini 只从 sessionStore 取 locale。 */
type Listener = () => void;
const state = { locale: "zh" as const };
const listeners = new Set<Listener>();
export function useSessionStore<T>(sel: (s: typeof state) => T): T {
  void listeners;
  return sel(state);
}
useSessionStore.getState = () => state;
useSessionStore.setState = (patch: Partial<typeof state>) => { Object.assign(state, patch); };
