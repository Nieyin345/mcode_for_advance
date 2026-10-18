/**
 * `@renderer/hooks/useRpc.js` 替身 —— 可驱动的"读"。
 *
 * 真 `useRpc` 依赖 store 的 toast 与 effect 生命周期；这一套只需要**同一份形状**
 * （`{data, loading, error, refetch}`），且要能把"能力报告加载中 / 失败"精确摆出来。
 * 组件调 `useRpc(() => api.document.capabilities(), ...)` 时，桩**真的调用那个
 * callback**（也就是打到 api-stub 上），然后同步把结果填进 slot —— fakeReact 的
 * effect 每轮重跑，`__flush()` 之后 `data` 就位。
 *
 * `enabled:false` 与真实现同语义：不请求、`data` 留在 undefined、loading=false。
 */
import { useEffect, useRef, useState } from "react";

export interface UseRpcOptions {
  enabled?: boolean;
  toastOnError?: boolean;
}

export interface UseRpcResult<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useRpc<T>(
  call: () => Promise<T>,
  deps: readonly unknown[],
  opts: UseRpcOptions = {},
): UseRpcResult<T> {
  const { enabled = true } = opts;
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);
  const callRef = useRef(call);
  callRef.current = call;
  const seqRef = useRef(0);

  const run = (): Promise<void> => {
    const seq = ++seqRef.current;
    setLoading(true);
    return callRef.current().then(
      (result) => {
        if (seq !== seqRef.current) return;
        setData(result);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (seq !== seqRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    if (!enabled) {
      seqRef.current++;
      setLoading(false);
      return;
    }
    void run();
    return () => {
      seqRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { data, loading, error, refetch: run };
}
