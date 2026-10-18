/**
 * 【ARC-007】**原子文件替换的唯一实现**。
 *
 * ## 为什么抽出来
 *
 * 写盘必须原子：直接 `writeFile` 到目标，写一半断电/崩溃就毁原文件。正确做法是
 * 写同目录随机后缀的临时文件 → `fsync` 刷到介质 → `rename` 覆盖目标 —— 中断只会
 * 留下一个可丢的临时文件。这份逻辑原先只写在 `ipc/files.ts` 里（MC-097），文档视图
 * 的保存通道也要用同一件事：再抄一份就会出现"一处改了 fsync、另一处忘了"的分裂。
 *
 * ## 为什么是叶子模块
 *
 * 不 import electron、不 import 任何 `ipc/*`：两端（`ipc/files.ts` 的文本保存、
 * `document/documentViewHost.ts` 的字节保存）都能引用它，而无头套件加载它也不会
 * 把 electron 的兼容层拖进来。
 *
 * ## 失败语义
 *
 * Windows 上目标被占用时 `rename` 会失败 —— 此时**不**退回"直接写"（那就退回非
 * 原子了），而是清理临时文件后如实抛错，由调用方报 `ok:false`。
 */
import { randomUUID } from "node:crypto";
import { open as openFile, rename, rm } from "node:fs/promises";

/** 原子替换 `filePath` 的内容。
 *
 *  `content` 接受字符串（UTF-8，与旧调用方一致）或字节数组（文档视图保存二进制）。
 *  临时文件与目标同目录 —— 跨卷 rename 会失败，同目录才保证原子。 */
export async function atomicReplaceFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.mcode-tmp`;
  const handle = await openFile(tmp, "w");
  try {
    if (typeof content === "string") {
      await handle.writeFile(content, "utf-8");
    } else {
      await handle.writeFile(content);
    }
    // 把数据真正刷到介质再 rename —— 否则崩溃后可能 rename 成功而内容还在页缓存里丢。
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, filePath);
  } catch (err) {
    try { await rm(tmp, { force: true }); } catch { /* best-effort 清理 */ }
    throw err;
  }
}
