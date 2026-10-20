import { registerProjectInitHandlers } from "./projectInit.js";
import { registerSceneHandlers } from "./scene.js";
import { registerDocumentHandlers, documentRepoRoot } from "./document.js";
import { registerDocumentViewHandlers, isApprovedDocumentViewOpen } from "./documentView.js";
import { resolveGenofficeCliPath } from "@main/document/genofficeCli.js";
import { registerWorkflowEngineHandlers } from "./workflowEngine.js";
import { workflowEngineRegistry } from "@main/workflowEngines/registry.js";
import { documentViewHost } from "@main/document/documentViewHost.js";
// 【ARC-007 P1/GA1】slides 执行器与桥：**静态** import（而非运行时
// require("@main/...") —— 那是构建器 alias，打包后无法解析）。
// vendor 快照缺失时的降级在 **seam** 里：slidesVendorModules 被别名到 stub，
// VendorSlidesExecutor.create() 返回 null。
// 【ARC-007 P1/GA1】slides 执行器与桥：**静态** import。运行时
// `require("@main/...")` 是构建器 alias，打包后无法解析
// （实测：产物里变成无法解析的 require2("@main/...")）。
// vendor 快照缺失时的降级在静态 seam 里：
// slidesVendorModules 被别名到 stub， VendorSlidesExecutor.create() 返回 null。
import { VendorSlidesExecutor } from "@main/document/slidesExecutor.js";
import { slidesBridge } from "@main/document/slidesBridge.js";
import { DocumentViewCredentialBroker, readEngineAdminToken } from "@main/document/documentViewCredentialBroker.js";
import { EngineNodeRegistry } from "@main/workflowEngines/engineNodeRegistry.js";
import { ensureEngineNodeReady } from "@main/workflowEngines/engineNodeReadiness.js";
import { installEngineNode } from "@main/workflowEngines/engineNodeInstallRoute.js";
import { NodeInstallApprovalBridge } from "@main/workflowEngines/engineNodeApprovalBridge.js";
import { getMainWindow, hasLiveRendererWindow, sendToRenderer } from "@main/window.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { registerUnattendedHandlers } from "./unattended.js";
import { registerModuleHandlers } from "./modules.js";
import { registerMemoryAssistantHandlers } from "./memoryAssistant.js";
import { ipcMain, session, type IpcMain } from "electron";
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
import { registerAgentSshHandlers } from "./agentSsh.js";
import { registerEngineToolHandlers } from "./engineTools.js";
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
import { registerSettingsTransferHandlers } from "./settingsTransfer.js";
import { registerMobileHandlers } from "./mobile.js";
import { registerRelayHandlers } from "./relay.js";
import { registerVoiceHandlers } from "./voice.js";
import { registerLibraryHandlers } from "./library.js";
import { registerOnlyOfficeHandlers } from "./onlyoffice.js";
import { registerMemoryHandlers } from "./memory.js";
import { registerMonitoringHandlers } from "./monitoring.js";
import { registerCustomUiPanelHandlers } from "./customUiPanel.js";
import { registerExtensionStoreHandlers } from "./extensions.js";

/**
 * Wrap `ipcMain` so every `handle()` registration automatically awaits DB
 * readiness before invoking the handler. This decouples window creation from
 * DB init: the renderer may fire IPC before sql.js finishes loading, and those
 * calls simply queue on `awaitDb()` instead of hitting the "getDb() called
 * before initDb() resolved" throw. Once the DB is ready the promise is
 * already resolved, so the guard is a no-op for all subsequent calls.
 *
 * 【MC-014】同一个包装点也是**跨通道幂等**的桌面接线处：入参里带
 * `__operationId` 且该通道属于有副作用的档位时，先过共享操作账本
 * （`appControl/channelIdempotency.ts`，与 `app_api_call` 同一份账本）。
 * 没带键 / 只读通道 → 原样执行，不写账、不多一次 fsync。
 *
 * Only the `handle` method is intercepted; the register* functions use nothing
 * else from IpcMain, so a minimal object suffices.
 *
 * 【可测性】本函数**导出**并从 `import()` 侧被冒烟直接取用（`#region ipc-guarded`）
 * —— 台账 MC-014 要求「桌面 IPC 通道真的过了账本」，而那条判据只有拿到这个包装器
 * 才能验；从源码复制一份形状去测等于没测接线。
 */
import { createDbGuardedIpc } from "./dbGuardedIpc.js";
export { createDbGuardedIpc };


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
  registerAgentSshHandlers(ipc);
  registerEngineToolHandlers(ipc);
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
  registerSettingsTransferHandlers(ipc);
  registerMobileHandlers(ipc);
  registerRelayHandlers(ipc);
  registerVoiceHandlers(ipc);
  registerLibraryHandlers(ipc);
  registerOnlyOfficeHandlers(ipc);
  registerMemoryHandlers(ipc);
  registerProjectInitHandlers(ipc);
  registerSceneHandlers(ipc);
  registerDocumentHandlers(ipc);
  // 【ARC-007】受控文档视图宿主(GenOffice 编辑器页的 WebContentsView)。
  // 与 `document.*` 区别:那条是 CLI 读写能力,这条是**视图生命周期**;
  // 宿主单例由 `main/index.ts` 的退出路径 `dispose()`。
  // 【ARC-007】路径围栏用与 `document.*` / file IPC 同一份判据（README 硬规矩 2）。
  // 【ARC-006 Gate A 缺口】引擎编辑器页的凭据注入:令牌只在主进程里,经
  // `session.webRequest.onBeforeSendHeaders` 按 webContentsId + 回环 origin 注入;
  // 渲染端只递 `workflowEngineId`,令牌不进 URL / 快照 / 日志。
  documentViewHost.setEditorCredentials(new DocumentViewCredentialBroker({
    readToken: (engineId) => {
      // 只读;未启动过的引擎（数据目录还不存在）返回 null,不因一句查询创建目录。
      try {
        return readEngineAdminToken(workflowEngineRegistry.dataDirOf(engineId));
      } catch {
        return null;
      }
    },
    runningPort: (engineId) => {
      const status = workflowEngineRegistry.statusOf(engineId);
      return status?.state === "running" ? status.port : null;
    },
    getSession: () => session.defaultSession,
  }));
  registerDocumentViewHandlers(
    ipc,
    documentViewHost,
    (p) => findContainingWorkspaceRoot(p) !== null,
    slidesBridge,
    (input) => isApprovedDocumentViewOpen(input, resolveGenofficeCliPath(documentRepoRoot())),
  );
  // 【ARC-007 P1/GA1】slides 视图的打开/保存执行器 —— **按需加载** vendor 源码
  // （`genoffice/` 是 gitignored 快照）。加载不到 = 不装配，桥保持 fail-closed，
  // `document.capabilities.hosts.slides` 报 false（面板显式降级）—— 不假装能力存在。
  {
    const executor = VendorSlidesExecutor.create();
    if (executor !== null) {
      slidesBridge.attach(executor);
      // 【ARC-007 P1/GA1】视图销毁前的清理：vendor 会话按 webContents id 持有，
      // 关闭时必须释放（否则 Map 会随面板开关无限累积）。
      documentViewHost.setViewDisposer((webContentsId) => executor.release(webContentsId));
      // 打开成功后的推送（vendor `slides:opened` 通道名，页面 `onOpened` 订阅）。
      documentViewHost.setSlidesNotify((docId, openResult) => {
        const wc = documentViewHost.webContentsOf(docId) as
          | { send?: (channel: string, ...args: unknown[]) => void }
          | null;
        if (!wc || typeof wc.send !== "function") return;
        wc.send("slides:opened", openResult);
      });
    }
  }
  // 【ARC-007 P0】打开链的真实 dirty 来源已由 preload 的 `reportCloseCheck`
  // 上报进宿主；这里只补「脏时由真人确认是否放弃未保存修改」的端口 ——
  // 与关闭守卫同一个取向：默认按钮是**取消**（不丢用户修改）。
  documentViewHost.setConfirmDirty(async ({ filePath }) => {
    const options = {
      type: "warning" as const,
      message: "当前文档有未保存的修改",
      detail: filePath
        ? `打开另一份文档会放弃这些修改：${filePath}`
        : "打开另一份文档会放弃当前未保存的修改",
      buttons: ["取消", "放弃修改并打开"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { dialog, BrowserWindow } = await import("electron");
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  });
  // 【ARC-006 WF-INT】第三方工作流引擎的起停/状态。引擎是**独立子进程**，
  // 只绑 127.0.0.1；数据目录与启动命令由注册表给（node-red 未安装时显式失败）。
  // 【ARC-006 Gate E】节点包安装：清单落在 node-red 的引擎数据目录；审批经渲染端审批卡
  // （推送 + RPC 应答，见 `engineNodeApprovalBridge.ts`）。没有窗口时 sendToRenderer
  // 返回 false → 桥立刻拒绝（fail-closed）。
  const engineNodeRegistry = new EngineNodeRegistry({
    dataDir: workflowEngineRegistry.dataDirOf("node-red"),
    engineId: "node-red",
  });
  // 【ARC-006 Gate E】生产启动闸门：清单/中断备份/撤权残留不可信时不能起 Node-RED。
  // 与安装共用同一核查：先恢复*唯一且哈希匹配*的旧包，歧义原样保留并阻断运行。
  const ensureEngineNodesReady = (): Promise<void> => ensureEngineNodeReady(engineNodeRegistry);
  // 【MC-057】每个窗口只装一次撤权监听。导航/重载不会改变 webContents.id，
  // 但旧文档的批准卡已经过期；窗口关闭/渲染进程死亡亦必须立即拒绝 pending。
  const watchedNodeApprovalContents = new WeakSet<object>();
  const nodeApprovalBridge = new NodeInstallApprovalBridge({
    // 推送通道用 `IPC.` 常量（`ipc-wiring-smoke` 的扫描器按这个形状认出口，
    // 与 `sendToRenderer(IPC.WORKFLOW_CHANGED, …)` 同一写法）。
    send: (message, expectedSenderId) => {
      const win = getMainWindow();
      // MC-057: 只把审批卡发给发起安装的受信主窗口，空/崩溃/换窗都拒绝。
      if (!win || !hasLiveRendererWindow() || win.webContents.id !== expectedSenderId) return false;
      const wc = win.webContents;
      if (!watchedNodeApprovalContents.has(wc)) {
        watchedNodeApprovalContents.add(wc);
        const revoke = (): void => { nodeApprovalBridge.cancelForSender(wc.id); };
        wc.on("did-start-navigation", revoke);
        wc.on("render-process-gone", revoke);
        wc.once("destroyed", revoke);
      }
      sendToRenderer(IPC.WORKFLOW_ENGINE_NODE_INSTALL_APPROVAL, message);
      return true;
    },
  });
  registerWorkflowEngineHandlers(ipc, {
    registry: workflowEngineRegistry,
    launchSpec: (engineId) => workflowEngineRegistry.launchSpec(engineId),
    beforeStart: async (engineId) => {
      if (engineId === "node-red") await ensureEngineNodesReady();
    },
    nodes: {
      list: async () => {
        const state = await engineNodeRegistry.readState();
        if (state.kind === "corrupt") return { corrupt: state.reason, nodes: [] };
        return {
          corrupt: null,
          nodes: state.entries.map((entry) => ({
            name: entry.name, version: entry.version, source: entry.source,
            sha256: entry.sha256, license: entry.license,
            capabilities: [...entry.capabilities], installedAt: entry.installedAt,
            approvedByUser: entry.approvedByUser,
          })),
        };
      },
      install: async (input, senderId) => {
        const win = getMainWindow();
        if (!win || !hasLiveRendererWindow() || win.webContents.id !== senderId) {
          return { ok: false, code: "approval_unavailable", reason: "不是可信桌面窗口发起的节点安装" };
        }
        const state = workflowEngineRegistry.statusOf("node-red")?.state;
        if (state === "starting" || state === "running") {
          return { ok: false, code: "install_failed", reason: "Node-RED 正在启动或运行；先停止引擎再安装可执行节点包" };
        }
        try {
          await ensureEngineNodesReady();
        } catch (err) {
          return { ok: false, code: "install_failed", reason: err instanceof Error ? err.message : String(err) };
        }
        const result = await installEngineNode({
          registry: engineNodeRegistry,
          sourceDir: input.sourceDir,
          meta: input.meta,
          approval: async (card) => nodeApprovalBridge.request({
            name: card.name, version: card.version, source: card.source,
            license: card.license, capabilities: [...card.capabilities],
            network: card.network, sha256: card.sha256, intent: card.intent,
          }, senderId),
        });
        if (!result.ok) return { ok: false, code: result.code, reason: result.reason };
        const entry = result.entry;
        return {
          ok: true,
          node: {
            name: entry.name, version: entry.version, source: entry.source,
            sha256: entry.sha256, license: entry.license,
            capabilities: [...entry.capabilities], installedAt: entry.installedAt,
            approvedByUser: entry.approvedByUser,
          },
        };
      },
      respond: (input, senderId) => {
        const win = getMainWindow();
        return !!win && hasLiveRendererWindow() && win.webContents.id === senderId
          && nodeApprovalBridge.resolve(input, senderId);
      },
    },
  });
  registerUnattendedHandlers(ipc);
  registerMemoryAssistantHandlers(ipc);
  registerMonitoringHandlers(ipc);
  registerCustomUiPanelHandlers(ipc);
  registerExtensionStoreHandlers(ipc);
}

// Re-export channel constants so handlers stay aligned with the contract.
export { IPC };
