/**
 * IPC handlers for ripgrep availability + one-click install.
 *
 * These drive the search dialog's "ripgrep 未安装" banner: `rg.status` tells
 * the renderer whether a binary is resolvable (and whether an install is
 * already in flight), `rg.install` downloads the pinned release into
 * userData/bin and resets the resolution cache. Handlers never reject —
 * failures return `{ ok: false, error }` (same shape as the LSP ops).
 *
 * ⚠️ `error` is a **bare** reason, not a sentence that announces itself. Every
 * caller wraps it: `useRgStatus` hands it to the search dialog's
 * 「安装失败:{error}」 copy. So a message that already began with 「安装失败:」
 * would be rendered as 「安装失败:安装失败:…」 — keep the announcement out of
 * this layer.
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { resolveRg } from "@main/lib/rgSearch.js";
import { installRg, isRgInstalling } from "@main/lib/rgInstall.js";
import { log } from "@main/lib/logger.js";

export function registerRgHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.RG_STATUS, async () => {
    try {
      const path = resolveRg();
      return { available: path != null, path: path ?? undefined, installing: isRgInstalling() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`rg.status failed: ${msg}`);
      return { available: false, installing: false };
    }
  });

  ipcMain.handle(IPC.RG_INSTALL, async () => {
    // ⚠️ **不要在这里包一层「安装失败:」。** 这个 catch 是**够不到**的:
    // `installRg()` 返回 `doInstall()` 那个 promise,而 `doInstall` 是
    // `try { … } catch (err) { return { ok:false, error } }` —— **从不 reject**。
    //
    // 早先这里写的是 `msg.startsWith("安装失败:") ? msg : \`安装失败:${msg}\`` —— 防的是
    // 一个结构上不可能出现的双层文案。而它一旦真被触发(比如以后有人给 `doInstall`
    // 加了一条 try 之外的抛点),产生的正是它想防的那个东西:渲染端
    // (`SearchDialog.tsx:460` / `CommandPalette.tsx:472`)已经在外面套过一次
    // 「安装失败:{error}」,这里再套就是「安装失败:安装失败:…」。
    //
    // 这个文件开头的约定是"**handler 永不 reject**,失败返回 `{ok:false,error}`"
    // —— 维持它,`error` 也维持**裸原因**(加前缀是渲染端的事)。所以这里什么都不
    // 加,只把"本不该发生"这件事记成 error 级日志:真到了这一步,原因原样交出去,
    // 用户看到的和别的安装失败长得一样,而不是一句 Electron 的
    // 「Error invoking remote method …」。
    try {
      return await installRg();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`rg.install 抛出了它不该抛的异常(installRg 的契约是返回 {ok:false,error},不 reject):${msg}`);
      return { ok: false, error: msg };
    }
  });
}