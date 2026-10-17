/**
 * **文件内容版本的唯一实现**（【MC-097】引入，【ARC-007】抽成叶子模块）。
 *
 * 版本 = 文件**原始字节**的 sha256。`file.readFile` 回传它、`file.writeFile` 的
 * `expectedVersion` 与 `document.edit` 的 `expectedRevision` 都拿它比对 ——
 * 三处必须同一算法，所以只有这一份。
 *
 * 为什么是叶子模块：`ipc/files.ts` 顶层 import 了 electron（app/clipboard/shell），
 * 其它只需要"算个版本"的模块（`ipc/document.ts` 及其无头套件）不该被拖进整条
 * electron 依赖链。与 `realPathWithin.ts` 从 `pathGuard` 拆出同一条理由。
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/** 文件当前内容的稳定版本哈希(缓存无关,直接读当前字节)。文件不存在
 *  时返回 `null`(与"内容为空串"区分:新建 vs 空文件是两种不同的事实)。 */
export async function fileContentVersion(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null; // 不存在 / 读不了 —— 当作"没有可匹配的版本"。
  }
}
