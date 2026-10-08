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
import { broadcastSettingChanged } from "@main/lib/sessionSync.js";
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
      let backupPath: string | undefined;
      try {
        const dir = join(app.getPath("userData"), "settings-backups");
        await mkdir(dir, { recursive: true });
        backupPath = join(dir, `before-import-${stamp()}.json`);
        await writeFile(backupPath, `${JSON.stringify(buildSettingsExport(allSettings(), { appVersion: app.getVersion() }).doc, null, 2)}\n`, "utf8");
      } catch (err) {
        log.warn(`settings.import: backup failed: ${(err as Error).message}`);
        backupPath = undefined;
      }

      for (const [k, v] of parsed.entries) {
        SettingRepo.set(k, v);
        // 「跟着人走」的键照常推一次(和 setting.set 一样):已配对的手机当场生效,
        // 桌面自己也会收到回声,语言 / 强调色 / 快捷键这类不用重启就换上。
        if (isSyncedSettingKey(k)) broadcastSettingChanged(k, v);
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
        ...(backupPath ? { backupPath } : {}),
      };
    } catch (err) {
      log.warn(`settings.import failed: ${(err as Error).message}`);
      return { ok: false as const, error: (err as Error).message };
    }
  });
}
