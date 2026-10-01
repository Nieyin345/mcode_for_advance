import { registerProjectInitHandlers } from "./projectInit.js";
import { registerModuleHandlers } from "./modules.js";
import { registerMemoryAssistantHandlers } from "./memoryAssistant.js";
import { ipcMain, type IpcMain } from "electron";
import { recordRpcHandler } from "@main/appControl/registry.js";
import { IPC } from "@contracts/ipc";
import { awaitDb } from "@main/store/db.js";
import { registerProjectHandlers } from "./projects.js";
import { registerClaudeHandlers } from "./claude.js";
import { registerDialogHandlers } from "./dialog.js";
import { registerCustomModelHandlers } from "./customModel.js";
import { registerPiModelsHandlers } from "./piModels.js";
import { registerCodexModelsHandlers } from "./codexModels.js";
import { registerThemeHandlers } from "./theme.js";
import { registerFileHandlers } from "./files.js";
import { registerRgHandlers } from "./rg.js";
import { registerGitHandlers } from "./git.js";
import { registerTerminalHandlers } from "./terminal.js";
import { registerAppHandlers } from "./app.js";
import { registerShellHandlers } from "./shell.js";
import { registerUpdaterHandlers } from "./updater.js";
import { registerSkillsHandlers } from "./skills.js";
import { registerMcpHandlers } from "./mcp.js";
import { registerContextHandlers } from "./context.js";
import { registerOutputStyleHandlers } from "./outputStyle.js";
import { registerUsageHandlers } from "./usage.js";
import { registerLspHandlers } from "./lsp.js";
import { registerRuntimesHandlers } from "./runtimes.js";
import { registerToolchainHandlers } from "./toolchain.js";
import { registerWorkflowHandlers } from "./orchestration.js";
import { registerHookHandlers } from "./hooks.js";
import { registerPluginsHandlers } from "./plugins.js";
import { registerBrowserHandlers } from "./browser.js";
import { registerNotificationHandlers } from "./notifications.js";
import { registerMobileHandlers } from "./mobile.js";
import { registerRelayHandlers } from "./relay.js";
import { registerVoiceHandlers } from "./voice.js";
import { registerLibraryHandlers } from "./library.js";
import { registerInstitutionAuthHandlers } from "./institutionAuth.js";
import { registerOnlyOfficeHandlers } from "./onlyoffice.js";
import { registerMemoryHandlers } from "./memory.js";
import { registerMonitoringHandlers } from "./monitoring.js";

/**
 * Wrap `ipcMain` so every `handle()` registration automatically awaits DB
 * readiness before invoking the handler. This decouples window creation from
 * DB init: the renderer may fire IPC before sql.js finishes loading, and those
 * calls simply queue on `awaitDb()` instead of hitting the "getDb() called
 * before initDb() resolved" throw. Once the DB is ready the promise is
 * already resolved, so the guard is a no-op for all subsequent calls.
 *
 * Only the `handle` method is intercepted; the register* functions use nothing
 * else from IpcMain, so a minimal object suffices.
 */
function createDbGuardedIpc(target: IpcMain): IpcMain {
  const wrapped: Pick<IpcMain, "handle"> = {
    handle(channel, handler) {
      const guarded = async (event: Parameters<typeof handler>[0], raw: unknown) => {
        await awaitDb();
        return handler(event, raw);
      };
      target.handle(channel, guarded);
      // 同一个函数留一份给 mcode-app 的 `app_api_call`(agent 调功能 = 界面按按钮,走同一段代码)。
      recordRpcHandler(channel, guarded as (event: unknown, raw: unknown) => unknown);
    },
  };
  return wrapped as unknown as IpcMain;
}

/** Register all renderer->main IPC handlers. */
export function registerIpcHandlers(): void {
  const ipc = createDbGuardedIpc(ipcMain);
  registerProjectHandlers(ipc);
  registerClaudeHandlers(ipc);
  registerDialogHandlers(ipc);
  registerCustomModelHandlers(ipc);
  registerPiModelsHandlers(ipc);
  registerCodexModelsHandlers(ipc);
  registerThemeHandlers(ipc);
  registerFileHandlers(ipc);
  registerModuleHandlers(ipc);
  registerRgHandlers(ipc);
  registerGitHandlers(ipc);
  registerTerminalHandlers(ipc);
  registerAppHandlers(ipc);
  registerShellHandlers(ipc);
  registerUpdaterHandlers(ipc);
  registerSkillsHandlers(ipc);
  registerMcpHandlers(ipc);
  registerContextHandlers(ipc);
  registerOutputStyleHandlers(ipc);
  registerUsageHandlers(ipc);
  registerLspHandlers(ipc);
  registerRuntimesHandlers(ipc);
  registerToolchainHandlers(ipc);
  registerWorkflowHandlers(ipc);
  registerHookHandlers(ipc);
  registerPluginsHandlers(ipc);
  registerBrowserHandlers(ipc);
  registerNotificationHandlers(ipc);
  registerMobileHandlers(ipc);
  registerRelayHandlers(ipc);
  registerVoiceHandlers(ipc);
  registerLibraryHandlers(ipc);
  registerInstitutionAuthHandlers(ipc);
  registerOnlyOfficeHandlers(ipc);
  registerMemoryHandlers(ipc);
  registerProjectInitHandlers(ipc);
  registerMemoryAssistantHandlers(ipc);
  registerMonitoringHandlers(ipc);
}

// Re-export channel constants so handlers stay aligned with the contract.
export { IPC };
