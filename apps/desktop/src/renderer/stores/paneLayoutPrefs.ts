import { parsePaneDock, type PaneDock } from "@renderer/components/layout/paneDock.js";

/** Decoded pane preferences from the existing ui.paneWidths setting.
 * The reader never trusts arbitrary serialized values as layout dimensions.
 * Missing dock is the legacy format and intentionally maps to "right".
 * Actual viewport clamps stay in sessionStore so this parser is DOM-free.
 */
export interface SavedPaneLayout {
  dock: PaneDock;
  leftPct?: number;
  right?: number;
  bottomTerminal?: number;
  editor?: number;
}

export function parseSavedPaneLayout(raw: string | null | undefined): SavedPaneLayout | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const result: SavedPaneLayout = { dock: parsePaneDock(row.dock) };
  if (typeof row.leftPct === "number" && Number.isFinite(row.leftPct)) result.leftPct = row.leftPct;
  if (typeof row.right === "number" && Number.isFinite(row.right)) result.right = row.right;
  if (typeof row.bottomTerminal === "number" && Number.isFinite(row.bottomTerminal))
    result.bottomTerminal = row.bottomTerminal;
  if (typeof row.editor === "number" && Number.isFinite(row.editor)) result.editor = row.editor;
  return result;
}
