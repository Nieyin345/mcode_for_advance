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
import { templatesRoot } from "@main/templates/store.js";

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
    templatesPath: templatesRoot(),
  }));

  /**
   * 把整个数据根迁到新位置,然后**重启应用**。
   *
   * 顺序是刻意的:
   *   1. `flushDb()` —— 先把内存里的数据库**同步**落到旧路径,再复制它。反过来复制到
   *      的是上一个微任务之前的旧文件。
   *   2. 复制整棵树。失败就原样返回,**什么都不动**(连接还活着,应用不受影响)。
   *   3. 写指针文件 → `closeDb()` → `relaunch()`。
   *
   * **不删旧根**:留一份副本,万一新位置有问题还能找回来。多占一份空间换一次安心的
   * 搬家,值。
   */
  ipcMain.handle(IPC.APP_MOVE_DATA_ROOT, (_evt, raw) => {
    const input = z.object({ path: z.string().min(1) }).parse(raw);
    flushDb();
    const err = copyDataRootTo(input.path);
    if (err) return { ok: false, error: err };
    setDataRoot(input.path);
    closeDb();
    log.info(`dataRoot: switching to ${input.path}; relaunching`);
    // 推迟重启,让这个 IPC 的返回值先回到渲染端 —— 否则界面看到的是"点了没反应"
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 600);
    return { ok: true };
  });
}
