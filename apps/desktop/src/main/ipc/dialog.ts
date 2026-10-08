/**
 * IPC handlers for native OS dialogs.
 *
 * Channels:
 *  - `dialog:pickFiles` - multi-file picker. Intentionally NOT scoped to a
 *    project root: this is the escape hatch that lets the composer "添加上下文"
 *    button attach files that live outside the active project. Returns the
 *    selected absolute paths (empty array on cancel).
 *  - `dialog:pickFolder`  - single-directory picker used to add a new project
 *    root. Uses a raw string channel (kept for back-compat with the existing
 *    preload/sessionStore callers) rather than a typed `RpcMap` entry.
 *  - `file:pickImages` - image-only picker that READS the files here in main
 *    and returns base64 (the renderer can't read arbitrary paths itself).
 *    Same "user explicitly picks" trust level as pickFiles; per-file size cap
 *    PICK_IMAGE_MAX_BYTES, allowlist extensions only.
 *
 * The dialogs are thin wrappers over Electron's `dialog.showOpenDialog`.
 * The selection happens in the OS-native modal, so no path-traversal guard
 * is needed here — the user explicitly picks what they want attached.
 */
import type { IpcMain } from "electron";
import { dialog } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { IPC, DialogPickFilesSchema, PickImagesSchema } from "@contracts/ipc";
import type { PickedImage } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { dialogText } from "@main/lib/dialogText.js";

/** Per-file ceiling for the image picker (raw bytes). Anything larger is
 *  skipped — the renderer downsizes to ~4.5MB before sending anyway, so
 *  anything past this would only waste memory crossing IPC. */
const PICK_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** Extension → allowlist mime (mirrors SendTurnImageSchema.mimeType).
 *
 *  ⚠️ 查表**必须**走 `hasOwn`,不能直接 `PICK_IMAGE_MIME[ext]`。`ext` 是从文件名里
 *  剥出来的**任意字符串**,而字面量对象的查表范围包含 `Object.prototype` ——
 *  文件名叫 `照片.constructor` / `x.__proto__` / `a.valueOf` 时,下标命中的是原型上的
 *  成员,拿到的是个**函数或对象**而不是 `undefined`:白名单判断为假,它被当合格图片
 *  **读进内存**,渲染端还收到一个 `mimeType` 不是字符串的图,拼出来是
 *  `data:function Object() {...};base64,...` 这种打不开的 `<img>`。
 *  (同时把类型收成 `string | undefined`,让查表结果不能悄悄变成别的类型。) */
const PICK_IMAGE_MIME: Record<string, PickedImage["mimeType"] | undefined> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 白名单查表 —— 只认自己那五个键,原型链上的一律当"不认识"。 */
function pickImageMime(ext: string): PickedImage["mimeType"] | undefined {
  return Object.prototype.hasOwnProperty.call(PICK_IMAGE_MIME, ext)
    ? PICK_IMAGE_MIME[ext]
    : undefined;
}

export function registerDialogHandlers(ipcMain: IpcMain): void {
  // ── multi-file picker (project-external files allowed) ──
  ipcMain.handle(IPC.DIALOG_PICK_FILES, async (_evt, raw) => {
    const input = DialogPickFilesSchema.parse(raw);
    const result = await dialog.showOpenDialog({
      title: input.title ?? dialogText("common.dialog.pickFiles"),
      properties: ["openFile", "multiSelections"],
      ...(input.filters ? { filters: input.filters } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return { paths: [] };
    return { paths: result.filePaths };
  });

  // ── folder picker: lets the renderer ask for a project directory ──
  // Raw string channel (pre-typed-contract era); kept as-is for back-compat.
  ipcMain.handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });

  // ── image picker: dialog + main-side read → base64 (composer 图片 button) ──
  ipcMain.handle(IPC.FILE_PICK_IMAGES, async (_evt, raw) => {
    PickImagesSchema.parse(raw ?? {});
    const result = await dialog.showOpenDialog({
      title: dialogText("common.dialog.pickImages"),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: dialogText("common.dialog.imagesFilter"), extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { images: [], skipped: [] };
    }
    const images: PickedImage[] = [];
    const skipped: string[] = [];
    for (const filePath of result.filePaths) {
      const name = basename(filePath);
      const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
      const mimeType = pickImageMime(ext);
      if (!mimeType) {
        skipped.push(name);
        continue;
      }
      try {
        const st = await stat(filePath);
        if (!st.isFile() || st.size > PICK_IMAGE_MAX_BYTES) {
          log.warn(`file.pickImages skipped ${name}: ${st.size} bytes`);
          skipped.push(name);
          continue;
        }
        const buf = await readFile(filePath);
        images.push({ name, data: buf.toString("base64"), mimeType });
      } catch (err) {
        log.warn(`file.pickImages failed for ${filePath}: ${(err as Error).message}`);
        skipped.push(name);
      }
    }
    return { images, skipped };
  });
}
