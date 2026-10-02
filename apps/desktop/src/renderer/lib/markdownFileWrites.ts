import { api } from "@renderer/lib/api.js";
import { SerializedFileWrites } from "./serializedFileWrites.js";

/**
 * 保存时发现磁盘上的内容**既不是**编辑器上次读到/写下的,**也不是**这次要写的 ——
 * 别人(多半是 AI 的工具调用)在这期间改过它。直接写就会把那次修改整篇冲掉,所以
 * 拒绝写入,把磁盘上的新内容带回去让界面问用户:载入新版本,还是用自己的覆盖。
 */
export class FileConflictError extends Error {
  constructor(readonly disk: string) {
    super("文件已被外部修改");
    this.name = "FileConflictError";
  }
}

/** 这个进程里每个路径最后一次**成功写下**的内容 —— 两个面板开着同一份文件时,
 *  另一个面板刚存的那版不算\"外部修改\"。 */
const lastWritten = new Map<string, string>();

/** Shared by Markdown panes and the Monaco source save path, including across
 * file switches / unmounts. Both modes must use the SAME queue for each path. */
export const textFileWrites = new SerializedFileWrites(async (filePath, content, expected) => {
  if (expected !== undefined) {
    let disk: string | null = null;
    try {
      disk = (await api.file.readFile({ filePath })).content;
    } catch {
      disk = null; // 读不到(被删/被移走):没有可被冲掉的东西,照常写
    }
    if (disk !== null && disk !== expected && disk !== content && disk !== lastWritten.get(filePath)) {
      throw new FileConflictError(disk);
    }
  }
  const result = await api.file.writeFile({ filePath, content });
  if (!result.ok) throw new Error("文件写入失败");
  lastWritten.set(filePath, content);
});

export const markdownFileWrites = textFileWrites;
