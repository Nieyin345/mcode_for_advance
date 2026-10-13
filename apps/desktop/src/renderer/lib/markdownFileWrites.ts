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
  let expectedVersion: string | undefined;
  if (expected !== undefined) {
    let disk: string | null = null;
    try {
      const read = await api.file.readFile({ filePath });
      disk = read.content;
      // 【MC-097】记下**读到的那一版**的内容版本哈希 —— 写的时候带上它,让主进程在**提交点**
      // 再比一次 CAS。渲染端这次读之后、主进程写之前的那段窗口里若被别的 Agent/进程改过,
      // 主进程会拒绝写入(而不是静默覆盖别人的改动)。
      expectedVersion = read.version ?? undefined;
    } catch {
      disk = null; // 读不到(被删/被移走):没有可被冲掉的东西,照常写
    }    if (disk !== null && disk !== expected && disk !== content && disk !== lastWritten.get(filePath)) {
      throw new FileConflictError(disk);
    }
  }
  const result = await api.file.writeFile({
    filePath,
    content,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
  if (!result.ok) {
    // 【MC-097】主进程 CAS 冲突:磁盘在这次读之后又被改过。抛同一种冲突错,界面照旧问用户。
    if ((result as { conflict?: boolean }).conflict) {
      let disk = "";
      try { disk = (await api.file.readFile({ filePath })).content; } catch { /* 读不到就给空 */ }
      throw new FileConflictError(disk);
    }
    throw new Error("文件写入失败");
  }
  rememberWritten(filePath, content);
});

export const markdownFileWrites = textFileWrites;
