/**
 * IPC handler for app / runtime info (About panel).
 *
 * Surfaces the app version (from `app.getVersion()`, which reads the root
 * package.json in dev and the built app's version in production) plus the
 * bundled Electron / Node / Chromium versions and the OS platform/arch.
 *
 * Parameterless, read-only RPC - no input validation needed.
 */
import type { IpcMain } from "electron";
import { app } from "electron";
import { z } from "zod";
import { IPC, type AppInfoResult } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { closeDb, flushDb } from "@main/store/db.js";
import { copyDataRootTo, dataRoot, dbPath, setDataRoot } from "@main/lib/dataRoot.js";
import { libraryRoot } from "@main/library/paths.js";

/** Node 在 Windows 上把交给 `cpSync` 的路径展开成的**长路径前缀**。
 *  源码里这个字面量就是四个字符:`\` `\` `?` `\`。 */
const LONG_PATH_PREFIX = "\\\\?\\";

/**
 * 复制失败的那句话**不能原样送到界面上** —— 它带着 Node 的长路径前缀。
 *
 * `cpSync` 内部走的是 `toNamespacedPath()`,所以抛出来的信息里每个路径都顶着
 * `\\?\`。用户点「迁移」被拒时在设置页看到的是:
 *
 * ```
 * 复制失败:Cannot overwrite non-directory \\?\C:\…\a.txt with directory \\?\C:\…\Mcode
 * ```
 *
 * `\\?\` 是**内核**认的写法(绕过 MAX_PATH),不是用户认的写法 —— 他会以为自己
 * 选错了什么特殊路径。前面几档有自己中文话的拒绝(非绝对路径 / 不是空目录 /
 * 互相嵌套)本来就不带它;只有真的走到复制这一步失败时才漏出来,而那恰恰是最需要
 * 用户看懂"我选的目录怎么了"的一档。
 *
 * 只摘前缀,原因那句话**原样保留** —— 那是系统给的事实,不该在这儿改写。
 */
function readableCopyError(message: string): string {
  return message.split(LONG_PATH_PREFIX).join("");
}

export function registerAppHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.APP_INFO, (): AppInfoResult => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? "?",
    node: process.versions.node ?? "?",
    chromium: process.versions.chrome ?? "?",
    platform: process.platform,
    arch: process.arch,
  }));

  /** 统一数据根的当前状态(设置页展示用)。 */
  ipcMain.handle(IPC.APP_GET_DATA_ROOT, () => ({
    root: dataRoot(),
    dbPath: dbPath(),
    libraryPath: libraryRoot(),
  }));

  /**
   * 把整个数据根迁到新位置,然后**重启应用**。
   *
   * 顺序是刻意的:
   *   1. `flushDb()` —— 先把内存里的数据库**同步**落到旧路径,再复制它。反过来复制到
   *      的是上一个微任务之前的旧文件。
   *   2. 复制整棵树。失败就原样返回,**什么都不动**(连接还活着,应用不受影响)。
   *   3. `closeDb()` 成功 → 写指针文件 → `relaunch()`；关闭保存失败时不切根。
   *
   * **不删旧根**:留一份副本,万一新位置有问题还能找回来。多占一份空间换一次安心的
   * 搬家,值。
   */
  ipcMain.handle(IPC.APP_MOVE_DATA_ROOT, (_evt, raw) => {
    const input = z.object({ path: z.string().min(1) }).parse(raw);
    flushDb();
    const err = copyDataRootTo(input.path);
    if (err) return { ok: false, error: readableCopyError(err) };
    // closeDb now preserves the live handle and throws on failure. Do not
    // publish the new root until that barrier has succeeded.
    closeDb();
    setDataRoot(input.path);
    log.info(`dataRoot: switching to ${input.path}; relaunching`);
    // 推迟重启,让这个 IPC 的返回值先回到渲染端 —— 否则界面看到的是"点了没反应"
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 600);
    return { ok: true };
  });
}
