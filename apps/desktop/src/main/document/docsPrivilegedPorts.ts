/**
 * T05b: adapters to Mcode's EXISTING OS pickers, atomic writer and workspace
 * path guard. The vendor cannot import Mcode internals or choose its own UI.
 * All dialogs require an actual user's interaction; absence = deny.
 */
import { dialog, BrowserWindow } from "electron";
import { basename, extname, join } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { dataRoot } from "@main/lib/dataRoot.js";
import { fetchApprovedDocsImage } from "./docsRemoteImage.js";
import { readFile, stat, rm } from "node:fs/promises";
import { pickFilesForUser, pickFolderForUser } from "@main/ipc/dialog.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";

export interface DocsPrivilegedPorts {
  pickFiles(filters?: Array<{ name: string; extensions: string[] }>): Promise<string[]>;
  pickImage(): Promise<{ base64: string; mime: "image/png" | "image/jpeg" | "image/gif"; name: string } | null>;
  pickDirectory(): Promise<string | null>;
  saveTarget(name: string, ext: string): Promise<string | null>;
  savePdfTarget(name: string): Promise<string | null>;
  exportTempRoot(): string;
  fetchApprovedImage(url: string): Promise<{ base64: string; mime: string }>;
  confirmPrint(): Promise<boolean>;
  workspaceRoot(path: string): string | null;
  atomicWrite(path: string, bytes: Uint8Array): Promise<void>;
  removeExportTemp(path: string): Promise<void>;
}

const IMAGE_MIME = new Map<string, "image/png" | "image/jpeg" | "image/gif">([
  [".png", "image/png"], [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"], [".gif", "image/gif"],
]);

/** No second file chooser: exactly the dialog.pickFiles handler's service. */
export const docsPrivilegedPorts: DocsPrivilegedPorts = {
  async pickFiles(filters) {
    const result = await pickFilesForUser(filters ? { filters } : {});
    return result.paths;
  },
  async pickImage() {
    const { paths } = await pickFilesForUser({
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif"] }],
    });
    const file = paths[0];
    if (!file) return null;
    const mime = IMAGE_MIME.get(extname(file).toLowerCase());
    if (!mime) return null;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 5 * 1024 * 1024) return null;
      return { base64: (await readFile(file)).toString("base64"), mime, name: basename(file) };
    } catch { return null; }
  },
  async pickDirectory() {
    return (await pickFolderForUser()).path;
  },
  async saveTarget(name, ext) {
    const opts = {
      title: "保存文档图片",
      defaultPath: basename(name),
      filters: [{ name: "Images", extensions: [ext] }],
    };
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const response = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    return response.canceled ? null : response.filePath ?? null;
  },
  async savePdfTarget(name) {
    const opts = { title: "导出 PDF", defaultPath: basename(name).replace(/\.docx$/i, "") + ".pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] };
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const reply = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return reply.canceled ? null : reply.filePath ?? null;
  },
  exportTempRoot() {
    const dir = join(dataRoot(), "docs", "export-tmp");
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  },
  fetchApprovedImage: fetchApprovedDocsImage,
  async confirmPrint() {
    // Same Mcode modal approval pattern as DocumentViewHost.confirmDirty.
    // This prompt is issued EVERY invocation: no cached grant/silent printing.
    const opts = {
      type: "warning" as const,
      message: "允许当前文档打印？",
      detail: "此操作会向系统打印机发送文档内容。每次打印都需要您本人确认。",
      buttons: ["取消", "确认打印"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const response = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    return response.response === 1;
  },
  workspaceRoot: findContainingWorkspaceRoot,
  atomicWrite: atomicReplaceFile,
  removeExportTemp: async (path) => { await rm(path, { force: true }); },
};
