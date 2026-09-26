import { useEffect, useSyncExternalStore } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";

/** Renderer-lifetime drafts: navigation must not cancel a pending edit/save.
 * No timers or writes in effects. Only an explicit Apply mutates settings. */
export function createPolicyDraft<T>() {
  let state: { value: T | null; baseline: T | null; dirty: boolean; saving: boolean; error: string | null } =
    { value: null, baseline: null, dirty: false, saving: false, error: null };
  let epoch = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<typeof state>) => {
    epoch++;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    getEpoch: () => epoch,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    hydrate(value: T, readEpoch: number) { if (epoch === readEpoch && !state.dirty && !state.saving) update({ value, baseline: value }); },
    edit(value: T) { update({ value, dirty: JSON.stringify(value) !== JSON.stringify(state.baseline), error: null }); },
    discard() { if (!state.saving) update({ value: state.baseline, dirty: false, error: null }); },
    async save(key: string, payload: string): Promise<void> {
      if (state.saving || !state.dirty || state.value === null) return;
      const submitted = state.value;
      update({ saving: true, error: null });
      try {
        await api.setting.set({ key, value: payload });
        // A user may have edited again (even in a newly mounted panel).
        update({ baseline: submitted, dirty: JSON.stringify(state.value) !== JSON.stringify(submitted) });
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        update({ saving: false });
      }
    },
  };
}

export function usePolicyDraft<T>(key: string, store: ReturnType<typeof createPolicyDraft<T>>, decode: (value: string | null) => T) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const read = useRpc(async () => {
    const epoch = store.getEpoch();
    const value = decode((await api.setting.get({ key })).value);
    return { value, epoch };
  }, [key], { toastOnError: false });
  useEffect(() => {
    if (read.data !== undefined) store.hydrate(read.data.value, read.data.epoch);
  }, [read.data, store]);
  return { state, read };
}
