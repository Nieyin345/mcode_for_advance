/** F025: desktop-only ephemeral Theia VSIX compatibility preview.
 * Separate from registerModuleHandlers: no extra catalog/install permission surface.
 * It never persists a ModuleHost installation and never answers to Agent RPC.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { TheiaPreviewInputSchema } from "@contracts/ipc/modules.js";
import { desktopSenderId } from "@main/modules/installConsentPolicy.js";

let previewPromise: Promise<import("@main/modules/theiaHost/theiaVsixPreview.js").TheiaVsixPreview> | null = null;
async function previewService() {
  if (!previewPromise) {
    previewPromise = import("@main/modules/theiaHost/theiaVsixPreview.js").then(({ TheiaVsixPreview }) => {
      const roots = [process.env.MCODE_THEIA_ROOT, resolve(process.cwd(), "vendor/theia"), resolve(process.cwd(), "../../vendor/theia")]
        .filter((p): p is string => Boolean(p));
      const root = roots.find(p => existsSync(join(p, "packages/plugin-ext/lib/hosted/node/plugin-host.js")) &&
        existsSync(join(p, "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js")));
      if (!root) throw Error("Theia preview requires a built vendor/theia checkout (plugin-ext and plugin-ext-vscode). Not available in packaged builds yet.");
      const service = new TheiaVsixPreview(root);
      import("electron").then(({ app }) => app.once("before-quit", () => { void service.disposeAll(); })).catch(() => {});
      return service;
    }).catch(error => { previewPromise = null; throw error; });
  }
  return previewPromise;
}

/** Rejects Agent calls (no verified desktop sender) and nested renderer frames. */
export function theiaDesktopSender(event: unknown): number {
  const id = desktopSenderId(event);
  const source = event as {senderFrame?: unknown; sender?: {mainFrame?: unknown}} | null;
  if (id === null || !source?.senderFrame || source.sender?.mainFrame !== source.senderFrame) {
    throw Error("Theia compatibility preview is restricted to a desktop main-frame user action");
  }
  return id;
}

export function registerTheiaPreviewHandlers(ipcMain: IpcMain): void {
  const watched = new Set<number>();
  const destroyed = new Set<number>();
  ipcMain.handle(IPC.MODULE_THEIA_PREVIEW, async (event, raw: unknown) => {
    const senderId = theiaDesktopSender(event);
    if (destroyed.has(senderId)) throw Error("窗口已销毁，旧 Theia 授权全部失效");
    const input = TheiaPreviewInputSchema.parse(raw);
    const manager = await previewService();
    const sender = event.sender;
    if (destroyed.has(senderId) || sender.isDestroyed?.()) throw Error("桌面窗口已关闭，拒绝试运行");
    if (!watched.has(senderId) && typeof sender.once === "function") {
      watched.add(senderId);
      sender.once("destroyed", () => {
        destroyed.add(senderId);
        watched.delete(senderId);
        void manager.disposeSender(senderId).catch(error => console.warn("[theia-preview] cleanup failed:", error));
      });
    }
    switch (input.op) {
      case "inspect": return manager.inspect(senderId, input.path);
      case "start": return manager.start(senderId, input.ticket, input.accepted);
      case "cancel": return manager.cancel(senderId, input.ticket);
      case "execute": return manager.execute(senderId, input.sessionId, input.commandId);
      case "stop": return manager.stop(senderId, input.sessionId);
    }
  });
}
