/** Per-target workflow leases. No Electron/DB dependencies.
 * Different sessions run concurrently. A detached injection returns immediately,
 * but its lease lasts until the accepted provider turn actually settles.
 */
interface Waiter { grant(release: () => void): void; }
interface Slot { held: boolean; waiters: Waiter[]; }
function aborted(): Error { return new DOMException("Conversation wait cancelled", "AbortError"); }

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const finish = (): void => { signal.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, 25);
    const cancel = (): void => { clearTimeout(timer); reject(aborted()); };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export class ConversationQueue {
  private slots = new Map<string, Slot>();

  private acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(aborted());
    let slot = this.slots.get(key);
    if (!slot) { slot = { held: false, waiters: [] }; this.slots.set(key, slot); }
    const current = slot;
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        const at = current.waiters.indexOf(waiter);
        if (at >= 0) current.waiters.splice(at, 1);
        reject(aborted());
        this.drain(key, current);
      };
      const waiter: Waiter = { grant: (release) => {
        signal.removeEventListener("abort", cancel);
        resolve(release);
      } };
      current.waiters.push(waiter);
      signal.addEventListener("abort", cancel, { once: true });
      this.drain(key, current);
    });
  }

  private drain(key: string, slot: Slot): void {
    if (slot.held) return;
    const next = slot.waiters.shift();
    if (!next) { if (this.slots.get(key) === slot) this.slots.delete(key); return; }
    slot.held = true;
    let released = false;
    next.grant(() => {
      if (released) return;
      released = true;
      slot.held = false;
      this.drain(key, slot);
    });
  }

  async run<T>(
    key: string,
    signal: AbortSignal,
    isBusy: () => boolean,
    task: (holdUntil: (settled: Promise<unknown>) => void) => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(key, signal);
    let detached: Promise<unknown> | undefined;
    try {
      // Includes turns started outside this queue (user/agent mail).
      // The caller must include its provider-starting phase in isBusy.
      while (!signal.aborted && isBusy()) await pause(signal);
      if (signal.aborted) throw aborted();
      return await task((settled) => { detached = settled; });
    } finally {
      // An already accepted auto-injection belongs to the target conversation,
      // not to the cancelled workflow. Never release its slot prematurely.
      if (detached) void detached.then(release, release);
      else release();
    }
  }
}

/** Shared across workflow runs, not one queue per graph. */
export const conversationQueue = new ConversationQueue();
