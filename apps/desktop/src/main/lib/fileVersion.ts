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
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

/** 文件当前内容的稳定版本哈希(缓存无关,直接读当前字节)。
 *  只有真实 ENOENT 才返回 `null`(新建 vs 空文件是两种不同事实)。
 *  EACCES/EISDIR/EPERM 等已存在但读不了的情况必须抛给上层显式失败：
 *  不能把「读错」伪装成「不存在」，让带 expectedRevision=null 的写入
 *  误把不可信的版本检查当成成功。此规则供文档编辑与文档视图共用。 */
export async function fileContentVersion(filePath: string): Promise<string | null> {
  try {
    // Hash in bounded chunks: a large PDF/Office file must not be duplicated
    // in full in the main process heap just to compute a CAS revision.
    const sha = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) sha.update(chunk);
    return sha.digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err; // 读失败不等于不存在：上层失败关闭并保留原字节。
  }
}
