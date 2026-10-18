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
import { lstat, open as openFile, rename, rm } from "node:fs/promises";

/** 原子替换 `filePath` 的内容。
 *
 *  `content` 接受字符串（UTF-8，与旧调用方一致）或字节数组（文档视图保存二进制）。
 *  临时文件与目标同目录 —— 跨卷 rename 会失败，同目录才保证原子。 */
export async function atomicReplaceFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.mcode-tmp`;
  // 直接用 wx 默认权限(0666 & umask)创建，会在原有 0600 文件 rename 后放宽
  // 权限，甚至让中间阶段的敏感临时字节可被同机其他账户读取。
  let mode = 0o600;
  try {
    // lstat 不追踪符号链接。若使用 stat，拿到的是链接目标的权限，随后
    // rename 却替换链接本身，导致用户原有链接消失且目标文件并未被更新。
    const existing = await lstat(filePath);
    if (!existing.isFile()) throw new Error("原子保存目标必须是普通文件（拒绝目录或符号链接）");
    // 已有文件保留既定权限，不把用户的 0600/0640 改成 0644。
    mode = existing.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // UUID 防正常撞名、wx 防极端撞名时截断他人的暂存文件。
  const handle = await openFile(tmp, "wx", mode);
  try {
    try {
      if (typeof content === "string") {
        await handle.writeFile(content, "utf-8");
      } else {
        await handle.writeFile(content);
      }
      // openFile(..., mode) 的权限会再被进程 umask 截断：已有 0644
      // 文件遇 umask 077 会变成 0600，替换成功却意外修改了文件授权。
      // POSIX 用已打开的私有暂存句柄恢复原权限（新文件依旧只有 0600），
      // 并在 sync 前完成元数据更新；Windows ACL 与 POSIX mode 不等价。
      if (process.platform !== "win32") await handle.chmod(mode);
      // 把数据和权限元数据刷到介质再 rename。
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
  } catch (err) {
    // 写入、fsync、close、rename 任一步失败都必须清理暂存；
    // 原实现只覆盖 rename 失败，写入失败会残留含半份内容的临时文件。
    try { await rm(tmp, { force: true }); } catch { /* best-effort 清理 */ }
    throw err;
  }
}
