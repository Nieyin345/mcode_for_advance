/**
 * IPC handlers for language servers (LSP).
 *
 * Each handler validates input with a zod schema, delegates to the singleton
 * `lspManager`, and converts thrown errors into `LspOpResult`/`{ error }`
 * returns so the renderer never sees a rejected invoke. Document-sync and
 * request handlers also enforce that workspacePath is a known project root;
 * `lspManager` re-checks path containment for filePaths.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  LspListSchema,
  LspInstallSchema,
  LspInstallFromFileSchema,
  LspUninstallSchema,
  LspToggleSchema,
  LspSetPathSchema,
  LspHealthCheckSchema,
  LspPrewarmSchema,
  LspRestartSchema,
  LspOpenDocSchema,
  LspCloseDocSchema,
  LspDidChangeSchema,
  LspDidSaveSchema,
  LspRequestSchema,
} from "@contracts/ipc";
import { lspManager } from "@main/lsp/LspManager.js";
import { log } from "@main/lib/logger.js";
import { errText } from "@main/lib/ipcError.js";

export function registerLspHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.LSP_LIST, async () => {
    try {
      return await lspManager.list();
    } catch (err) {
      log.warn(`lsp.list failed: ${errText(err)}`);
      return { languages: [] };
    }
  });

  ipcMain.handle(IPC.LSP_INSTALL, async (_evt, raw) => {
    try {
      const input = LspInstallSchema.parse(raw);
      return await lspManager.install(input.language);
    } catch (err) {
      const msg = errText(err);
      log.error(`lsp.install failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_INSTALL_FROM_FILE, async (_evt, raw) => {
    try {
      const input = LspInstallFromFileSchema.parse(raw);
      return await lspManager.installFromFile(input.language, input.archivePath);
    } catch (err) {
      const msg = errText(err);
      log.error(`lsp.installFromFile failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_UNINSTALL, async (_evt, raw) => {
    try {
      const input = LspUninstallSchema.parse(raw);
      return await lspManager.uninstall(input.language);
    } catch (err) {
      const msg = errText(err);
      log.error(`lsp.uninstall failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_TOGGLE, async (_evt, raw) => {
    try {
      const input = LspToggleSchema.parse(raw);
      return await lspManager.toggle(input.language, input.enabled);
    } catch (err) {
      // ⚠️ **变更类 handler 失败必须抛,不能折成一个「成功形状的空列表」。**
      // 从前这里是 `return { languages: [] }`:而 `lspManager.toggle` 走 `list()`,
      // 那份列表永远是**全部四种语言**,所以 `{ languages: [] }` 在成功路径上
      // **根本不可能出现** —— 它只能是被吞掉的失败(一种恒为失败的分支)。
      // 契约(`RpcMap["lsp.toggle"]`)也没有 error 字段,渲染端 `LspLanguagesPanel.doToggle`
      // 唯一能察觉失败的途径就是这条 invoke **抛**;handler 不抛,那句专门写的 catch
      // (注释:「失败要说出来」)就永远是死分支 —— 开关点了没反应、也不报错。
      // 改成抛出(与 institutionAuth 同口径,错误经共享 errText 翻成人话)。
      const msg = errText(err);
      log.error(`lsp.toggle failed: ${msg}`);
      throw new Error(msg);
    }
  });

  ipcMain.handle(IPC.LSP_SET_PATH, async (_evt, raw) => {
    try {
      const input = LspSetPathSchema.parse(raw);
      return await lspManager.setPath(input.language, input.serverPath, input.args, input.javaHome);
    } catch (err) {
      // 同 LSP_TOGGLE:成功路径只会回完整列表,`{ languages: [] }` 是失败被伪装成成功。
      const msg = errText(err);
      log.error(`lsp.setPath failed: ${msg}`);
      throw new Error(msg);
    }
  });

  ipcMain.handle(IPC.LSP_HEALTH_CHECK, async (_evt, raw) => {
    try {
      const input = LspHealthCheckSchema.parse(raw);
      return await lspManager.healthCheck(input.language);
    } catch (err) {
      const msg = errText(err);
      log.error(`lsp.healthCheck failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_PREWARM, async (_evt, raw) => {
    try {
      const input = LspPrewarmSchema.parse(raw);
      return await lspManager.prewarm(input.workspacePath);
    } catch (err) {
      const msg = errText(err);
      log.warn(`lsp.prewarm failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_RESTART, async (_evt, raw) => {
    try {
      const input = LspRestartSchema.parse(raw);
      return await lspManager.restart(input.workspacePath, input.language);
    } catch (err) {
      const msg = errText(err);
      log.error(`lsp.restart failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_OPEN_DOC, async (_evt, raw) => {
    try {
      const input = LspOpenDocSchema.parse(raw);
      await lspManager.openDocument(input.workspacePath, input.filePath, input.language);
      return;
    } catch (err) {
      const msg = errText(err);
      log.warn(`lsp.openDocument failed: ${msg}`);
    }
  });

  ipcMain.handle(IPC.LSP_CLOSE_DOC, async (_evt, raw) => {
    try {
      const input = LspCloseDocSchema.parse(raw);
      await lspManager.closeDocument(input.workspacePath, input.filePath);
    } catch (err) {
      const msg = errText(err);
      log.warn(`lsp.closeDocument failed: ${msg}`);
    }
  });

  ipcMain.handle(IPC.LSP_DID_CHANGE, async (_evt, raw) => {
    try {
      const input = LspDidChangeSchema.parse(raw);
      await lspManager.didChange(input.workspacePath, input.filePath, input.text, input.version);
    } catch (err) {
      const msg = errText(err);
      log.warn(`lsp.didChange failed: ${msg}`);
    }
  });

  ipcMain.handle(IPC.LSP_DID_SAVE, async (_evt, raw) => {
    try {
      const input = LspDidSaveSchema.parse(raw);
      await lspManager.didSave(input.workspacePath, input.filePath, input.text);
    } catch (err) {
      const msg = errText(err);
      log.warn(`lsp.didSave failed: ${msg}`);
    }
  });

  ipcMain.handle(IPC.LSP_REQUEST, async (_evt, raw) => {
    try {
      const input = LspRequestSchema.parse(raw);
      return await lspManager.request(input.workspacePath, input.language, input.method, input.params);
    } catch (err) {
      const msg = errText(err);
      log.warn(`lsp.request failed: ${msg}`);
      return { error: { code: -32603, message: msg } };
    }
  });
}
