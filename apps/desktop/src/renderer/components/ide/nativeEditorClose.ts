import { api } from "@renderer/lib/api.js";
import { ideDirtyTracker, type IdeCloseResult } from "@renderer/lib/ideDirty.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { genofficeAppForPath } from "@contracts/genofficeFileRoute";
import { stableDocId } from "./documentViewIdentity.js";

/**
 * Ask the native editor's own close guard before removing its Mcode tab.
 * The vendor owns save/discard/cancel semantics; Mcode must not duplicate them
 * or unmount the tab before the user's decision is known.
 *
 * Pass the project captured by the initiating UI action so a slow save prompt
 * cannot accidentally inspect another project's mode after a project switch.
 */
export async function closeNativeEditorBeforeTabRemoval(
  filePath: string,
  projectId: string | null = useSessionStore.getState().activeProjectId,
): Promise<boolean> {
  const state = useSessionStore.getState();
  const mode = projectId ? state.ideFileViewModeByProject[projectId]?.[filePath] : undefined;
  let nativeViewOpen = mode === "genoffice-view" || ideDirtyTracker.hasNativeOpen(filePath);
  if (!nativeViewOpen && genofficeAppForPath(filePath) !== undefined) {
    // A default native view need not have an explicit mode preference. Consult
    // the host's authoritative live-view list only for formats that can route there.
    try {
      const snapshot = await api.documentView.list();
      nativeViewOpen = snapshot.views.some((view) => view.docId === stableDocId(filePath));
    } catch {
      // The list endpoint is unavailable in non-desktop transports. Without a
      // native-mode preference there is no evidence of a live native editor.
      nativeViewOpen = false;
    }
  }
  if (!nativeViewOpen) {
    ideDirtyTracker.setNative(filePath, false);
    ideDirtyTracker.setNativeOpen(filePath, false);
    return true;
  }
  ideDirtyTracker.setNativeOpen(filePath, true);
  if (ideDirtyTracker.hasEditor(filePath)) {
    ideDirtyTracker.setNative(filePath, true);
    return false;
  }

  try {
    const result = await api.documentView.close({ docId: stableDocId(filePath) });
    ideDirtyTracker.setNative(filePath, !result.ok);
    ideDirtyTracker.setNativeOpen(filePath, !result.ok);
    return result.ok;
  } catch {
    // Fail closed: a rejected native close must never be treated as permission
    // to remove the tab and strand an editor with unsaved in-memory changes.
    ideDirtyTracker.setNative(filePath, true);
    ideDirtyTracker.setNativeOpen(filePath, true);
    return false;
  }
}

/** Close one file tab only after its native editor has accepted the close. */
export async function closeFileInIdeSafely(
  filePath: string,
  projectId: string | null = useSessionStore.getState().activeProjectId,
): Promise<IdeCloseResult> {
  if (!projectId || useSessionStore.getState().activeProjectId !== projectId) {
    return { closed: [], blocked: [filePath] };
  }
  if (!(await closeNativeEditorBeforeTabRemoval(filePath, projectId))) {
    return { closed: [], blocked: [filePath] };
  }
  const state = useSessionStore.getState();
  if (state.activeProjectId !== projectId) return { closed: [], blocked: [filePath] };
  return state.closeFileInIde(filePath);
}

/** Close other file tabs one by one, preserving any file whose close was cancelled. */
export async function closeOtherFilesInIdeSafely(
  keepFilePath: string,
  projectId: string | null = useSessionStore.getState().activeProjectId,
): Promise<IdeCloseResult> {
  if (!projectId) return { closed: [], blocked: [] };
  const initial = useSessionStore.getState();
  if (initial.activeProjectId !== projectId) return { closed: [], blocked: [] };
  const paths = initial.ideOpenFilesByProject[projectId] ?? [];
  if (!paths.includes(keepFilePath)) return { closed: [], blocked: [] };

  const closed: string[] = [];
  const blocked: string[] = [];
  for (const path of paths) {
    if (path === keepFilePath) continue;
    if (useSessionStore.getState().activeProjectId !== projectId) {
      blocked.push(...paths.filter((candidate) => candidate !== keepFilePath && !closed.includes(candidate) && !blocked.includes(candidate)));
      break;
    }
    const result = await closeFileInIdeSafely(path, projectId);
    closed.push(...result.closed);
    blocked.push(...result.blocked);
  }

  const current = useSessionStore.getState();
  if (current.activeProjectId === projectId && (current.ideOpenFilesByProject[projectId] ?? []).includes(keepFilePath)) {
    current.setIdeActiveFile(keepFilePath);
  }
  return { closed: [...new Set(closed)], blocked: [...new Set(blocked)] };
}

/** Close all file tabs one by one; each native editor gets its own save/discard/cancel decision. */
export async function closeAllFilesInIdeSafely(
  projectId: string | null = useSessionStore.getState().activeProjectId,
): Promise<IdeCloseResult> {
  if (!projectId) return { closed: [], blocked: [] };
  const initial = useSessionStore.getState();
  if (initial.activeProjectId !== projectId) return { closed: [], blocked: [] };
  const paths = [...(initial.ideOpenFilesByProject[projectId] ?? [])];
  const closed: string[] = [];
  const blocked: string[] = [];
  for (const path of paths) {
    if (useSessionStore.getState().activeProjectId !== projectId) {
      blocked.push(...paths.filter((candidate) => !closed.includes(candidate) && !blocked.includes(candidate)));
      break;
    }
    const result = await closeFileInIdeSafely(path, projectId);
    closed.push(...result.closed);
    blocked.push(...result.blocked);
  }
  return { closed: [...new Set(closed)], blocked: [...new Set(blocked)] };
}


export interface NativeEditorOperationPreflight {
  ok: boolean;
  /** Native views closed successfully and switched to a safe fallback. */
  closedPaths: string[];
  /** Path whose native close was rejected, if any. */
  blockedPath?: string;
}

/** Close native editors before a filesystem rename/delete, then detach them from the old path. */
export async function closeNativeEditorsForFileOperation(
  filePaths: readonly string[],
  projectId: string | null,
): Promise<NativeEditorOperationPreflight> {
  const uniquePaths = [...new Set(filePaths)];
  if (uniquePaths.length === 0) return { ok: true, closedPaths: [] };
  const initial = useSessionStore.getState();
  if (projectId && initial.activeProjectId !== projectId) {
    return { ok: false, closedPaths: [], blockedPath: uniquePaths[0] };
  }
  let liveDocIds = new Set<string>();
  const mayContainNativeView = uniquePaths.some((path) =>
    (projectId ? initial.ideFileViewModeByProject[projectId]?.[path] : undefined) === "genoffice-view" ||
    ideDirtyTracker.hasNativeOpen(path) || genofficeAppForPath(path) !== undefined,
  );
  if (mayContainNativeView) {
    try {
      const snapshot = await api.documentView.list();
      liveDocIds = new Set(snapshot.views.map((view) => view.docId));
    } catch {
      // Explicit mode preferences and the renderer's live-view registry below
      // remain authoritative if the host snapshot is temporarily unavailable.
    }
  }
  if (projectId && useSessionStore.getState().activeProjectId !== projectId) {
    return { ok: false, closedPaths: [], blockedPath: uniquePaths[0] };
  }
  const nativePaths = uniquePaths.filter(
    (path) => (projectId ? initial.ideFileViewModeByProject[projectId]?.[path] : undefined) === "genoffice-view" ||
      ideDirtyTracker.hasNativeOpen(path) || liveDocIds.has(stableDocId(path)),
  );
  const closedPaths: string[] = [];
  for (const path of nativePaths) {
    if (projectId && useSessionStore.getState().activeProjectId !== projectId) {
      return { ok: false, closedPaths, blockedPath: path };
    }
    if (!(await closeNativeEditorBeforeTabRemoval(path, projectId))) {
      return { ok: false, closedPaths, blockedPath: path };
    }
    const current = useSessionStore.getState();
    if (projectId && current.activeProjectId !== projectId) {
      return { ok: false, closedPaths: [...closedPaths, path], blockedPath: path };
    }
    // The native WebContentsView has been closed; switch to the structured
    // fallback so a failed filesystem operation never leaves a blank pane.
    if (projectId) current.setIdeFileViewMode(path, "genoffice");
    closedPaths.push(path);
  }
  if (projectId && useSessionStore.getState().activeProjectId !== projectId) {
    return { ok: false, closedPaths, blockedPath: closedPaths[closedPaths.length - 1] ?? uniquePaths[0] };
  }
  return { ok: true, closedPaths };
}

/** Restore the original native views after a cancelled/failed filesystem operation. */
export function restoreNativeEditorsAfterFileOperation(
  filePaths: readonly string[],
  projectId: string | null,
): void {
  if (!projectId) return;
  const state = useSessionStore.getState();
  if (state.activeProjectId !== projectId) return;
  const open = new Set(state.ideOpenFilesByProject[projectId] ?? []);
  for (const path of filePaths) {
    if (open.has(path)) state.setIdeFileViewMode(path, "genoffice-view");
  }
}
