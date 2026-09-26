import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { translate } from "@renderer/lib/i18n/core.js";

/**
 * useRpc — the one way for NEW components to READ data over the IPC bridge.
 *
 * Why this exists: 429 call sites across 99 component files each hand-rolled
 * `await api.*` with their own loading flag, and 328 catch blocks each decide
 * on their own how to report failure (MCode-优化方向.md §3.6 三). This hook is
 * the middle layer that was missing: one call gives
 * `{ data, loading, error, refetch }`, and errors surface through the shared
 * toast by default instead of vanishing into a silent catch.
 *
 * House rule (CLAUDE.md 硬规矩 7): new components must not hand-roll
 * `await api.*` + loading/catch for reads. Existing call sites are
 * deliberately left alone — they migrate when a panel is next touched,
 * not in one big sweep (大重构前先补测试，硬规矩 1).
 *
 * Semantics worth knowing:
 * - Stale replies are dropped by sequence number — when deps change
 *   mid-flight, the earlier reply cannot overwrite the newer one.
 * - `data` keeps its previous value while a refetch is in flight (no flash
 *   of empty); `loading` says whether a request is running right now.
 * - `enabled: false` skips fetching entirely ("dialog not open yet").
 * - READS ONLY. Mutations stay as explicit `await api.*` in event handlers —
 *   a mutation hidden inside a hook re-run is how you double-fire it.
 *
 * @example
 *   const { data: hooks, loading, error, refetch } =
 *     useRpc(() => api.workflow.hooksList(), []);
 *
 * @example // dependent + conditional fetch, error rendered inline
 *   const { data } = useRpc(
 *     () => api.project.sessions({ projectId }),
 *     [projectId],
 *     { enabled: open, toastOnError: false },
 *   );
 */

export interface UseRpcOptions {
  /** When false the fetch is skipped (nothing in flight, `loading` false).
   *  Default true. */
  enabled?: boolean;
  /** Pop the shared error toast on failure. Default true — turn it off only
   *  when the component shows the error inline (e.g. via <ErrorNote>). */
  toastOnError?: boolean;
}

export interface UseRpcResult<T> {
  /** Last successful result. Stays put during a refetch; `undefined` until
   *  the first success. */
  data: T | undefined;
  loading: boolean;
  /** Last failure, or null. Cleared by the next successful fetch. */
  error: Error | null;
  /** Re-run the call with current deps. Resolves when settled (never throws —
   *  failures land in `error` / the toast, same as the automatic fetch). */
  refetch: () => Promise<void>;
}

export function useRpc<T>(
  call: () => Promise<T>,
  deps: readonly unknown[],
  opts: UseRpcOptions = {},
): UseRpcResult<T> {
  const { enabled = true, toastOnError = true } = opts;
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);

  // Latest callback without putting it in deps — callers pass inline arrows,
  // and re-fetching because a closure identity changed on every render is
  // exactly the footgun this hook exists to remove. Deps are explicit.
  const callRef = useRef(call);
  callRef.current = call;
  const toastRef = useRef(toastOnError);
  toastRef.current = toastOnError;

  // Monotonic sequence: only the newest in-flight request may write state.
  // Bumped on every run AND on disable/unmount-of-effect, so a late reply
  // from a dead request can't resurrect stale data.
  const seqRef = useRef(0);

  const run = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const result = await callRef.current();
      if (seq !== seqRef.current) return; // superseded by a newer request
      setData(result);
      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      if (toastRef.current) {
        // getState() on purpose: subscribing to locale here would re-render
        // every consumer of this hook whenever the user switches language.
        const { locale } = useSessionStore.getState();
        useToastStore.getState().push({
          kind: "error",
          title: translate(locale, "store.toast.errorOccurred"),
          body: err.message,
        });
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Invalidate anything in flight; don't clear `data` — a dialog that
      // closes and reopens shouldn't flash empty if deps didn't change.
      seqRef.current++;
      setLoading(false);
      return;
    }
    void run();
    // The caller's data deps are spread in; `run` itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps]);

  return { data, loading, error, refetch: run };
}
