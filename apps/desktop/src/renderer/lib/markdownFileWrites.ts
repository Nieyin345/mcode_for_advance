import { api } from "@renderer/lib/api.js";
import { SerializedFileWrites } from "./serializedFileWrites.js";

/**
 * 保存时发现磁盘上的内容**既不是**编辑器上次读到/写下的,**也不是**这次要写的 ——
 * 别人(多半是 AI 的工具调用)在这期间改过它。直接写就会把那次修改整篇冲掉,所以
 * 拒绝写入,把磁盘上的新内容带回去让界面问用户:载入新版本,还是用自己的覆盖。
 */
export class FileConflictError extends Error {
  /** 【MC-024】主进程把**这次要写的内容**另存到的冲突副本（同目录
   *  `<name>.conflict-<时间戳><ext>`）。界面据此告诉用户"你的版本没丢，在这里"。
   *  缺省 = 副本没能落盘（写副本失败），此时只有冲突事实可报。 */
  constructor(readonly disk: string, readonly conflictPath?: string) {
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
// The cache stores whole file bodies, so a count-only bound can retain
// hundreds of megabytes of recently saved Markdown. Use a conservative
// UTF-16 upper bound (two bytes/code unit) with a total and per-file cap.
const LAST_WRITTEN_MAX_BYTES = 8 * 1024 * 1024;
const LAST_WRITTEN_MAX_ENTRY_BYTES = 1 * 1024 * 1024;
let lastWrittenBytes = 0;

function forgetWritten(filePath: string): void {
  const previous = lastWritten.get(filePath);
  if (previous === undefined) return;
  lastWrittenBytes -= previous.length * 2;
  lastWritten.delete(filePath);
}

function rememberWritten(filePath: string, content: string): void {
  forgetWritten(filePath);
  const size = content.length * 2;
  // Large files still save normally; only this optional same-pane conflict
  // shortcut is disabled. A stale editor will then fail closed with conflict.
  if (size > LAST_WRITTEN_MAX_ENTRY_BYTES) return;
  lastWritten.set(filePath, content);
  lastWrittenBytes += size;
  while (lastWritten.size > LAST_WRITTEN_MAX || lastWrittenBytes > LAST_WRITTEN_MAX_BYTES) {
    const oldest = lastWritten.keys().next().value;
    if (oldest === undefined) break;
    forgetWritten(oldest);
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
    // 【MC-024】主进程已把这次的内容另存为冲突副本；路径随错误带上去,让界面能说清楚
    // "你的版本在哪儿",而不是只报"被外部修改"、让用户以为刚打的字没了。
    if ((result as { conflict?: boolean }).conflict) {
      let disk = "";
      try { disk = (await api.file.readFile({ filePath })).content; } catch { /* 读不到就给空 */ }
      throw new FileConflictError(disk, (result as { conflictPath?: string }).conflictPath);
    }
    throw new Error("文件写入失败");
  }
  rememberWritten(filePath, content);
});

export const markdownFileWrites = textFileWrites;
