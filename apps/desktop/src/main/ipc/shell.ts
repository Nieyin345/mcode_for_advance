/**
 * IPC handler for opening a path in the OS file manager.
 *
 * Two channels:
 *  - `shell:openPath`           - open a project root folder itself. The path
 *    MUST be an exact match (after normalization) for a known, non-archived
 *    project root.
 *  - `shell:showItemInFolder`   - reveal a file or sub-directory inside a
 *    project root, selecting it in Finder/Explorer. The path MUST resolve
 *    inside (or equal) a known, non-archived project root - the same
 *    containment rule the file handlers use.
 *
 * We never let the renderer open arbitrary locations - only paths under
 * directories the user has explicitly added as projects. A refused or failing
 * call logs and resolves (no throw into the renderer).
 */
import type { IpcMain } from "electron";
import { shell } from "electron";
import { IPC, OpenPathSchema, ShowItemInFolderSchema, OpenFileSchema } from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
// ⚠️ 这里**不再自己抄一份 `pathWithin`**。抄的那份只做了 `resolve` 就比,少了
// win32/darwin 的**大小写归一** —— 于是项目根存 `D:\Proj\Foo`、渲染端从 Monaco/LSP
// 拿到小写 `d:\proj\foo\a.txt` 时,一个合法路径被判成"在项目根外面":
// 用户点「在文件管理器里显示」**点了没反应**(不弹窗、不报错)。
// 共享的那份把这条规则写在注释里("a lowercased drive letter from Monaco/LSP
// (`d:\foo`) still matches a project stored with an uppercase letter"),而且
// files/git/terminal/lsp 全走它 —— 围栏规则只该有一份,抄第二份就是等着两边漂开。
import { samePath, pathWithin } from "@main/lib/pathGuard.js";

export function registerShellHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_evt, raw) => {
    const input = OpenPathSchema.parse(raw);
    // Only allow opening a directory that is an exact match for a known
    // project root. Normalized comparison handles trailing-separator / case
    // differences between the folder picker and the persisted Project.path.
    const known = ProjectRepo.list()
      .filter((p) => !p.archived)
      .some((p) => samePath(p.path, input.path));
    if (!known) {
      log.warn(`shell.openPath refused (not a project root): ${input.path}`);
      return;
    }
    // openPath returns an error string on failure ("" on success).
    const err = await shell.openPath(input.path);
    if (err) {
      log.warn(`shell.openPath failed for "${input.path}": ${err}`);
    }
  });

  ipcMain.handle(IPC.SHELL_SHOW_ITEM_IN_FOLDER, async (_evt, raw) => {
    const input = ShowItemInFolderSchema.parse(raw);
    // Accept any path that resolves inside a known, non-archived project root
    // (or equals it). This lets the file-tree context menu reveal individual
    // files/sub-dirs while still refusing anything outside a project.
    const within = ProjectRepo.list()
      .filter((p) => !p.archived)
      .some((p) => pathWithin(p.path, input.path));
    if (!within) {
      log.warn(`shell.showItemInFolder refused (outside project root): ${input.path}`);
      return;
    }
    // showItemInFolder opens the containing folder and selects the item. It
    // has no error return; on failure the OS simply does nothing.
    shell.showItemInFolder(input.path);
  });

  ipcMain.handle(IPC.SHELL_OPEN_FILE, async (_evt, raw) => {
    const input = OpenFileSchema.parse(raw);
    // Same containment rule as showItemInFolder: the path must resolve inside
    // a known, non-archived project root. This lets the editor's unsupported
    // file pane open .docx/.pdf/etc. in the OS default app without letting
    // the renderer open arbitrary locations.
    const within = ProjectRepo.list()
      .filter((p) => !p.archived)
      .some((p) => pathWithin(p.path, input.path));
    if (!within) {
      log.warn(`shell.openFile refused (outside project root): ${input.path}`);
      return;
    }
    // openPath opens a file with its default application (or the folder in
    // the file manager for a directory). Returns an error string on failure.
    const err = await shell.openPath(input.path);
    if (err) {
      log.warn(`shell.openFile failed for "${input.path}": ${err}`);
    }
  });
}
