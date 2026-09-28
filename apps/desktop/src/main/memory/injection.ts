/** Bounded, process-local diagnostics of automatic memory handed to a provider.
 * No database, file writes, user-prompt archive or provider-history reconstruction.
 * A submitted receipt does NOT assert that a remote model received/adopted it. */
import { randomUUID } from "node:crypto";
import type { Session } from "@contracts/session";
import type { MemoryInjectionReceipt, MemoryInjectionSection, MemoryInjectionTrace } from "@contracts/memory";
import { SessionRepo } from "@main/store/repositories.js";

export const MEMORY_RECEIPT_LIMIT = 128;
export const MEMORY_RECEIPT_VISIBLE_LIMIT = 20;
export const MEMORY_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const TEXT_CAP = 12000;
const receipts = new Map<string, MemoryInjectionReceipt>();

function prune(): void {
  const cutoff = Date.now() - MEMORY_RECEIPT_TTL_MS;
  for (const [id, receipt] of receipts) if (receipt.at < cutoff) receipts.delete(id);
  while (receipts.size > MEMORY_RECEIPT_LIMIT) receipts.delete(receipts.keys().next().value!);
}
function clone(receipt: MemoryInjectionReceipt): MemoryInjectionReceipt {
  return { ...receipt, sections: receipt.sections.map(section => ({ ...section })) };
}

/** Snapshot before invoking the provider. A failed/null start is never labelled
 * submitted. The callback runs exactly once; tracing neither retries nor sends. */
export async function traceMemoryTurn<T>(
  session: Session,
  turnNumber: number,
  sections: readonly MemoryInjectionSection[],
  request: { prompt: string; memoryPrompt?: string },
  start: () => Promise<T>,
  trace?: MemoryInjectionTrace,
): Promise<T> {
  const receipt: MemoryInjectionReceipt = {
    id: randomUUID(), sessionId: session.id, projectId: session.projectId,
    kind: session.kind, title: session.title.slice(0, 160), turnNumber, at: Date.now(), phase: "preparing",
    ...(trace?.nodeId ? { nodeId: trace.nodeId } : {}),
    ...(trace?.nodeTitle ? { nodeTitle: trace.nodeTitle.slice(0, 160) } : {}),
    ...(trace?.runId ? { runId: trace.runId } : {}),
    sections: sections.slice(0, 4).map(section => {
      // Diagnostic metadata must agree with the actual host request. Do not show
      // a generated-but-omitted fragment as if it was sent to the engine.
      if (section.state === "included" && (!section.text ||
          !request.prompt.includes(section.text) && !request.memoryPrompt?.includes(section.text))) {
        return { source: section.source, state: "unavailable", text: "" };
      }
      const tooLong = section.text.length > TEXT_CAP;
      return { ...section, text: section.text.slice(0, TEXT_CAP),
        ...(section.error ? { error: section.error.slice(0, 500) } : {}),
        ...(tooLong ? { previewTruncated: true } : {}) };
    }),
  };
  receipts.set(receipt.id, receipt);
  prune();
  try {
    const handle = await start();
    receipt.phase = handle == null ? "start-failed" : "submitted";
    return handle;
  } catch (error) {
    receipt.phase = "start-failed";
    throw error;
  }
}

/** A chat may inspect itself and its host-managed descendants, never peers or
 * another project. Resolve the current ancestry from SessionRepo, not caller
 * input or a model-supplied parent/project id. Deleted/reassigned rows disappear. */
export function memoryInjectionsFor(sessionId: string): MemoryInjectionReceipt[] {
  prune();
  const owner = SessionRepo.get(sessionId);
  if (!owner || (owner.kind !== "chat" && owner.kind !== "side")) return [];
  const belongs = (candidateId: string): boolean => {
    const seen = new Set<string>();
    let id: string | null | undefined = candidateId;
    while (id && !seen.has(id) && seen.size < 32) {
      seen.add(id);
      const current = SessionRepo.get(id);
      if (!current || current.projectId !== owner.projectId) return false;
      if (current.id === owner.id) return true;
      id = current.parentSessionId;
    }
    return false;
  };
  return [...receipts.values()].reverse()
    .filter(receipt => receipt.projectId === owner.projectId && belongs(receipt.sessionId))
    .slice(0, MEMORY_RECEIPT_VISIBLE_LIMIT).map(clone);
}
