/** English mirror of `zh/memory.ts`. */
export const en = {
  // The six category names (rules/project/preferences/experiences/failures/decisions)
  // are data and shown verbatim — these keys only cover the UI actions.
  "memory.pickHint": "Pick a file on the left to view it.",
  "memory.categoryEmpty": "No files in this category yet.",
  "memory.newFile": "New file",
  "memory.fileNamePlaceholder": "File name (no extension)",
  "memory.fileNameInvalid": "The name can't be empty or contain slashes.",
  // Status line at the top of the right pane: clean / dirty / result.
  "memory.dirty": "Unsaved changes",
  "memory.saved": "Saved",
  "memory.saveFailed": "Failed to save: {error}",
  "memory.deleteFailed": "Failed to delete: {error}",
  "memory.readFailed": "Failed to read: {error}",
  "memory.loadFailed": "Failed to load memory files: {error}",
  // Delete confirmation (ConfirmDialog title and description).
  "memory.deleteTitle": "Delete “{name}”?",
  "memory.deleteDesc": "This memory file will be removed from disk. This can't be undone.",
  // A newly created file is a draft until saved — it isn't in the list yet.
  "memory.draft": "(unsaved)",
} as const;
