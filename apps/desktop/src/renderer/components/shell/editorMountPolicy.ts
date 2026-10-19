/** ARC-005: Monaco must not be destroyed merely because the unified
 * tab strip switches focus from a file to chat or a read-only preview.
 * A file still open in the project owns a persistent editor host.
 * Plan-only hosts render only while selected and non-wide; wide plans use
 * the shared WidePlanDialog, never a second invisible PlanViewer.
 */
export function shouldMountUnifiedEditorHost(
  activeFile: string | null,
  showEditor: boolean,
  wide: boolean,
): boolean {
  return activeFile !== null || (showEditor && !wide);
}
