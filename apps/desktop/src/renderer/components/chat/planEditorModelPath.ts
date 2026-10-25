/** Each chat session owns its own Monaco model. A single global
 * "__plan__.md" path reused the editor model (including undo/selection
 * state) across unrelated side/main conversations. This URI-like path is a
 * virtual in-memory model, not a workspace file and never written to disk. */
export function planEditorModelPath(sessionId: string): string {
  return `__mcode_plan__/${encodeURIComponent(sessionId)}.md`;
}
