/**
 * 设置导入 / 导出的 IPC(R39)。规则与清洗在 `settings/settingsTransfer.ts`;这里只管
 * 对话框、读写文件和导入前的备份。两个对话框都在主进程(渲染端没有保存框,也读不了
 * 项目外的任意路径 —— 和工作流导入导出同一个理由)。
 */
import type { IpcMain } from "electron";
import { app, dialog } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IPC } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { getMainWindow } from "@main/window.js";
import { notificationManager } from "@main/notifications/NotificationManager.js";
import { log } from "@main/lib/logger.js";
import { dialogText } from "@main/lib/dialogText.js";
import { broadcastSettingChangedToAll } from "@main/lib/sessionSync.js";
import { isSyncedSettingKey } from "@contracts/ipc/settingsSync";
import { buildSettingsExport, parseSettingsImport } from "@main/settings/settingsTransfer.js";

function allSettings(): Record<string, string | null> {
  const keys = SettingRepo.keysWithPrefix("");
  return SettingRepo.getMany(keys);
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function registerSettingsTransferHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.SETTING_EXPORT_FILE, async () => {
    try {
      const { doc, count, skipped, scrubbed } = buildSettingsExport(allSettings(), { appVersion: app.getVersion() });
      const win = getMainWindow();
      const opts = {
        title: dialogText("common.dialog.exportSettings"),
        defaultPath: `mcode-settings-${stamp()}.json`,
        filters: [{ name: dialogText("common.dialog.settingsFilter"), extensions: ["json"] }],
      };
      const res = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return { ok: false as const, canceled: true };
      await writeFile(res.filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      log.info(`settings.export: ${count} keys → ${res.filePath} (skipped ${skipped}, scrubbed ${scrubbed})`);
      return { ok: true as const, path: res.filePath, count, skipped, scrubbed };
    } catch (err) {
      log.warn(`settings.export failed: ${(err as Error).message}`);
      return { ok: false as const, error: (err as Error).message };
    }
  });

  ipc.handle(IPC.SETTING_IMPORT_FILE, async () => {
    try {
      const win = getMainWindow();
      const opts = {
        title: dialogText("common.dialog.importSettings"),
        properties: ["openFile" as const],
        filters: [{ name: dialogText("common.dialog.settingsFilter"), extensions: ["json"] }],
      };
      const res = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      const file = res.filePaths[0];
      if (res.canceled || !file) return { ok: false as const, canceled: true };
      const text = await readFile(file, "utf8");
      if (text.length > 20_000_000) return { ok: false as const, error: "文件太大,不像是设置导出文件" };
      const parsed = parseSettingsImport(text);
      if (!parsed.ok) return { ok: false as const, error: parsed.error };

      // 导入前先备份当前设置(同样不含密钥),导坏了能用「导入」再导回来。
      //
      // ⚠️ **备份写不出去就地中止,绝不继续往下覆盖。** 这份备份是导入唯一的后路 ——
      // 而导入会把整张表盖掉。备份失败还照样走完,等于把「导坏了能找回来」这条后路
      // 也一起丢了,而界面上那句「导入前会先把当前设置备份一份」(settings.transfer.
      // importDesc)照旧说着有,返回值里只是悄悄少了 backupPath —— 用户看到的是一次
      // **成功**的、却无法回退的覆盖。宁可让他看到一次明确的失败、当前设置一个字节
      // 不动,也不要用一次静默的覆盖换掉他的全部偏好。(磁盘满 / 目录只读这些真实
      // 入口都会走到这里,原先是 catch 成一行 warn 然后照常覆盖。)
      const dir = join(app.getPath("userData"), "settings-backups");
      let backupPath: string;
      try {
        await mkdir(dir, { recursive: true });
        backupPath = join(dir, `before-import-${stamp()}.json`);
        await writeFile(backupPath, `${JSON.stringify(buildSettingsExport(allSettings(), { appVersion: app.getVersion() }).doc, null, 2)}\n`, "utf8");
      } catch (err) {
        const why = (err as Error).message;
        log.warn(`settings.import: backup failed, aborting import: ${why}`);
        return { ok: false as const, error: `导入前的设置备份失败,已中止导入(当前设置未改动):${why}` };
      }

      for (const [k, v] of parsed.entries) {
        SettingRepo.set(k, v);
        // 「跟着人走」的键推给**所有**端 —— 已配对的手机当场生效,**桌面本端也要收到**
        // (语言 / 强调色 / 快捷键这类不用重启就换上)。⚠️ 这里必须用 `...ToAll`:普通的
        // `broadcastSettingChanged(k, v)` 不带 origin,只发手机、**不给桌面回声**
        // (那是为了别的写入者不被自己的回声拽回上一个按键)。导入这条路桌面端没有"乐观
        // 更新" —— 不推就一直是旧值,直到重启。
        if (isSyncedSettingKey(k)) broadcastSettingChangedToAll(k, v);
      }
      // 主进程里缓存了设置的服务:通知偏好当场重读;其余多数是用时现读。
      try {
        notificationManager.reloadPrefs();
      } catch {
        /* 尽力而为 */
      }
      log.info(`settings.import: ${parsed.entries.length} keys from ${file} (skipped ${parsed.skipped.length})`);
      return {
        ok: true as const,
        count: parsed.entries.length,
        skipped: parsed.skipped.length,
        // 走到这里备份一定写成过(写不成上面就 return 了)—— 所以这条恒在。
        backupPath,
      };
    } catch (err) {
      log.warn(`settings.import failed: ${(err as Error).message}`);
      return { ok: false as const, error: (err as Error).message };
    }
  });
}
