const state = { gestureSettings: { enabled: true, trigger: "right", overrides: {} }, gestureRecording: null, locale: "en" };
function useSessionStore<T>(select: (s: typeof state) => T): T { return select(state); }
useSessionStore.getState = () => state;
export { useSessionStore };
