/** Serialize settings writes per workflow identity. Rapid changes to multiple
 * criteria may arrive before React renders, and concurrent setting.set calls
 * can finish out of order. The last selection must be the last persisted
 * snapshot. Unrelated workflows maintain independent queues.
 *
 * The queue recovers after a rejected write, but callers still receive the
 * rejection and may surface an error toast. Completed keys are released.
 */
export function queueCriteriaPreferenceSave(
  pending: Map<string, Promise<void>>,
  key: string,
  value: string,
  persist: (key: string, value: string) => Promise<unknown>,
): Promise<void> {
  const before = pending.get(key);
  const task = (before ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => persist(key, value))
    .then(() => undefined);
  pending.set(key, task);
  void task.finally(() => {
    if (pending.get(key) === task) pending.delete(key);
  }).catch(() => undefined);
  return task;
}

export function nextCriteriaSelection(
  current: Readonly<Record<string, string>>,
  name: string,
  value: string,
): Record<string, string> {
  return { ...current, [name]: value };
}
