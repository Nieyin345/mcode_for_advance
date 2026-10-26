/**
 * Dependency-free bridge between disk-writing document tools and the live
 * native-editor host. The document tool runtime must stay importable by headless
 * callers, so it reports committed mutations through this injected observer
 * instead of importing Electron/DocumentViewHost directly.
 */
export type DocumentMutationSource = "document-tool" | "markdown-edit" | "document-edit";

export interface DocumentMutationNotice {
  filePath: string;
  revision: string | null;
  source: DocumentMutationSource;
}

export type DocumentMutationObserver = (notice: DocumentMutationNotice) => void | Promise<void>;

let observer: DocumentMutationObserver | null = null;

/** Installed once by the production DocumentViewHost singleton. */
export function setDocumentMutationObserver(next: DocumentMutationObserver | null): void {
  observer = next;
}

/**
 * Fire-and-forget UI notification after a successful disk mutation. The write
 * has already committed, so a stale/closed view or observer error must not turn a
 * successful document operation into a reported failure or add view-refresh latency.
 */
export async function notifyDocumentMutation(notice: DocumentMutationNotice): Promise<void> {
  const current = observer;
  if (current === null) return;
  try {
    // Start the observer immediately, but never make a successful file write wait
    // for a revision read or a renderer refresh. The UI already polls host snapshots.
    void Promise.resolve(current(notice)).catch(() => {});
  } catch {
    // The document write is authoritative; the view notice is supplementary.
  }
}
