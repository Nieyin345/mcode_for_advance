/** Prevent a stale deferred DB read from overwriting live drag/dock edits
 * made while the application was still finishing asynchronous initialization.
 */
export function mayApplyPaneHydration(startRevision: number, currentRevision: number): boolean {
  return startRevision === currentRevision;
}

/** Deferred layout hydration should still restore untouched pane dimensions.
 * Example: user docks LEFT while settings load; keep that live choice, but
 * retain the previously saved editor/terminal widths instead of dropping
 * the entire settings blob merely because one dimension changed.
 */
export function withoutLocallyEditedPaneFields<T extends object>(
  hydrated: T,
  localEdits: ReadonlySet<keyof T>,
): Partial<T> {
  const patch: Partial<T> = { ...hydrated };
  for (const key of localEdits) delete patch[key];
  return patch;
}

/** Single-flight coalescing write queue for UI pane layout snapshots.
 *
 * A 400ms debounce reduces writes during one drag, but doesn't protect against
 * two *different* drags when an earlier IPC/database write is still pending:
 * whichever asynchronous write finishes last wins. This queue never overlaps
 * writes, and while one is in flight it coalesces all newer snapshots into
 * exactly one latest write.
 */
export function createCoalescedPaneWriter<T>(
  snapshot: () => T,
  write: (value: T) => Promise<unknown>,
  onError: (error: unknown) => void,
): { request: () => Promise<void> } {
  let dirty = false;
  let inFlight: Promise<void> | null = null;
  return {
    request() {
      dirty = true;
      if (!inFlight) {
        inFlight = (async () => {
          while (dirty) {
            dirty = false;
            const value = snapshot();
            try { await write(value); }
            catch (err) { onError(err); }
          }
        })().finally(() => { inFlight = null; });
      }
      return inFlight;
    },
  };
}
