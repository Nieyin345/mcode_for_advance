/**
 * `@renderer/lib/markdownFileWrites.js` 替身。只提供 `EditPane` 会碰的两个成员:
 * `textFileWrites`(warm-start 判据读 `hasPending`;post-swap 核对读 `waitForPending`)
 * 与 `FileConflictError`(类型)。写盘在这套里不发生 —— 没起服务、不写盘。
 */
export const textFileWrites = {
  hasPending: (_filePath: string): boolean => false,
  waitForPending: (_filePath: string): Promise<void> => Promise.resolve(),
  enqueue: (_filePath: string, _content: string): Promise<void> => Promise.resolve(),
};
export class FileConflictError extends Error {
  constructor(readonly disk: string) {
    super("文件已被外部修改");
    this.name = "FileConflictError";
  }
}
export const markdownFileWrites = textFileWrites;
