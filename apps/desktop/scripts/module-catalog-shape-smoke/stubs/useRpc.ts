/** 只借 `useRpc` 的 `Error` 类型；本套运行时不用这个 hook。 */
export interface UseRpcResult<T> { data: T | undefined; loading: boolean; error: Error | null; refetch: () => Promise<void>; }
export interface UseRpcOptions { enabled?: boolean; toastOnError?: boolean }
export function useRpc<T>(_call: () => Promise<T>, _deps: readonly unknown[], _opts: UseRpcOptions = {}): UseRpcResult<T> {
  return { data: undefined, loading: false, error: null, refetch: async () => {} };
}
