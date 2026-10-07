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
import { hasOnlyOfficeSessions } from "@main/onlyoffice/OnlyOfficeBridge.js";
import { onlyOfficeMigrationBlockedMessage } from "@main/onlyoffice/persistenceAlerts.js";

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
   * ⚠️ **`closeDb()` 必须早于 `setDataRoot()`**(顺序由 `db-persistence-smoke` 的
   * `flush,copy,close,publish-root` 断言钉住):关闭这最后一下保存失败时,新位置那份
   * 副本可能是不完整的,那时**绝不能**把指针切过去。
   *
   * ⚠️ **已知未修(见 `docs/底层修复记录-2026-10-07.md` 的「搁置待议」)**:`setDataRoot`
   * 内部把写指针的失败 `log.error` 咽掉、不改返回值,于是"指针写不进去"这一档会回
   * `{ok:true}` 并重启 —— 下次启动读到旧指针(或 null → 回落默认位置),用户以为搬过去了。
   * 之所以不在这里顺手修:改顺序会破坏上面那条**故意**的 close-before-publish;而把
   * 检查放在 `closeDb()` **之后**,一旦指针写失败应用就处于"库已关、指针没换"的两难
   * (`initDb` 已过、renderer 之后任何读都抛),该"重启回旧根"还是"就地保持"是**设计
   * 取舍**,不是能顺手定的。留待讨论。
   *
   * **不删旧根**:留一份副本,万一新位置有问题还能找回来。多占一份空间换一次安心的
   * 搬家,值。
   */
  ipcMain.handle(IPC.APP_MOVE_DATA_ROOT, (_evt, raw) => {
    const input = z.object({ path: z.string().min(1) }).parse(raw);
    // A delayed Office callback still targets the old root. Never publish a copy
    // while an editor (or a failed final save) can still change that source.
    if (hasOnlyOfficeSessions()) return { ok: false, error: onlyOfficeMigrationBlockedMessage() };
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
