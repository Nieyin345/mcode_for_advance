/** `@renderer/lib/markdownFileWrites.js` 替身 —— 本套不读写文件；`FileEditor` 只在
 *  `MarkdownPreviewPane` / `EditPane` 里用到它的 `textFileWrites`，而那些 pane 在本套
 *  里是惰性桩。 */
export const textFileWrites = {
  waitForPending: (): Promise<void> => Promise.resolve(),
  write: (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true }),
};
export const markdownFileWrites = textFileWrites;
export class FileConflictError extends Error {}
