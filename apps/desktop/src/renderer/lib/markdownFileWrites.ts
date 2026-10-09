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
 *  另一个面板刚存的那版不算\"外部修改\"。
 *
 *  ⚠️ **有上限的 MRU。** 值是**整份文件正文**,而键是"这个进程里被编辑过的每个路径"
 *  —— 不加封顶,翻一遍大仓库、每份都存一次,就是几百份正文常驻内存、只涨不落。它只被
 *  下面那条"两个面板开同一份文件"的判据读,真正需要的永远是最近那几个;被挤掉的代价
 *  只是那个路径下一次"另一个面板刚存过"的判定退回"去读盘比对"(读出来的内容与
 *  `expected` 一致仍会放行,行为不退化)。 */
const lastWritten = new Map<string, string>();
const LAST_WRITTEN_MAX = 200;

function rememberWritten(filePath: string, content: string): void {
  lastWritten.delete(filePath); // 挪到队尾(Map 按插入序,队头即最久未用)
  lastWritten.set(filePath, content);
  while (lastWritten.size > LAST_WRITTEN_MAX) {
    const oldest = lastWritten.keys().next().value;
    if (oldest === undefined) break;
    lastWritten.delete(oldest);
  }
}

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
  rememberWritten(filePath, content);
});

export const markdownFileWrites = textFileWrites;
