/**
 * Minimal React stand-in for the workflow-live smoke. The module imports
 * `useSyncExternalStore` only for its `useWorkflowLive` hook; the foldable
 * logic under test is driven through `__applyWorkflowLiveEvent` /
 * `__resetWorkflowLive`, which never call it. Providing a stub keeps Monaco /
 * react-dom out of the headless bundle. (`react-stub.ts` is not a `.tsx` and
 * the smoke's tsconfig has `noUnused*` off, but these must still typecheck.)
 */
export function useSyncExternalStore<T>(
  _subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  _getServerSnapshot?: () => T,
): T {
  return getSnapshot();
}
