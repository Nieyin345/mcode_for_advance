/**
 * Debounced editor writes may finish out of order. Serialize every write of
 * the same file, including writes queued by a pane that has already unmounted.
 * A failed request must NOT poison the chain: the newer content still writes.
 * Different files remain independent. No React state lives in this queue.
 */
export class SerializedFileWrites {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly write: (filePath: string, content: string) => Promise<void>) {}

  enqueue(filePath: string, content: string): Promise<void> {
    const previous = this.tails.get(filePath) ?? Promise.resolve();
    const current = previous.then(() => this.write(filePath, content));
    // The return value retains failure for its caller to display. Only the
    // *tail* swallows failure, so a later save can still run.
    const settled = current.then(() => undefined, () => undefined);
    this.tails.set(filePath, settled);
    void settled.then(() => {
      if (this.tails.get(filePath) === settled) this.tails.delete(filePath);
    });
    return current;
  }

  /** A newly mounted view must not read the old disk content while a previous
   * pane's close/save is still queued. This waits for writes already enqueued
   * when called (without propagating their errors to an unrelated reader). */
  waitForPending(filePath: string): Promise<void> {
    return this.tails.get(filePath) ?? Promise.resolve();
  }

  hasPending(filePath: string): boolean {
    return this.tails.has(filePath);
  }
}

/** MDXEditor normalizes content on mount without a user input event. */
export function shouldAutosave(userTouched: boolean, markdown: string, baseline: string | null): boolean {
  return userTouched && baseline !== markdown;
}

/** A navigation/selection key is NOT an edit. Marking every keydown as an
 * edit lets a later asynchronous MDX normalization rewrite an untouched file.
 * beforeinput/paste/cut/drop handle IME and clipboard edits separately. */
export function isEditingKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  const key = event.key;
  if (key === "Backspace" || key === "Delete" || key === "Enter" || key === "Tab") return true;
  if (event.ctrlKey || event.metaKey) return ["z", "y", "b", "i", "u"].includes(key.toLowerCase());
  return !event.altKey && key.length === 1;
}
