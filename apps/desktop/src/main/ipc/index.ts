import { registerProjectInitHandlers } from "./projectInit.js";
import { registerSceneHandlers } from "./scene.js";
import { registerTaskHandlers } from "./task.js";
import { registerApprovalHandlers } from "./approval.js";
import { registerDocumentHandlers, documentRepoRoot } from "./document.js";
import { registerDocumentViewHandlers, isApprovedDocumentViewOpen } from "./documentView.js";
import { resolveGenofficeCliPath } from "@main/document/genofficeCli.js";
import { registerWorkflowEngineHandlers } from "./workflowEngine.js";
import { workflowEngineRegistry } from "@main/workflowEngines/registry.js";
import { startEngineIfNeeded, ensureEngineStarted, type EngineAutostartPorts, type EngineAutostartResult } from "@main/workflowEngines/engineAutostart.js";
import { setPendingMigrationProvider } from "./workflowEngine.js";
import { migrateLegacyWorkflows, describeMigrationReport, pendingMigrationNoticeOf, MIGRATION_REPORT_SETTING_KEY } from "@main/workflowEngines/legacyMigration.js";
import { evaluateWorkflowMigration } from "@main/workflowEngines/workflowMigrationGate.js";
import { loadWorkflowIntoNative } from "@main/workflowEngines/nativeLibraryLoad.js";
import { getWorkflow, listWorkflows, saveWorkflow } from "@main/orchestration/library.js";
import { workflowSaveVersion } from "@main/orchestration/workflowSaveVersion.js";
import { SettingRepo, WorkflowRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { workflowReviewOf } from "@main/orchestration/workflowTrust.js";
import { sharedExecutorOwnership } from "@main/workflowEngines/executorOwnership.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { documentViewHost } from "@main/document/documentViewHost.js";
import { docsPrivilegedPorts } from "@main/document/docsPrivilegedPorts.js";
import { docsAiPorts } from "@main/document/docsAiPorts.js";
// 【T40】渲染端工具通道的宿主登记簿包装。**必须**用它包住 `docsAiPorts` 再交给宿主：
// 未包装的 ports 不会在 `run` 前后登记/撤销绑定，`activeRendererBindingFor` 永远空,
// `document.tool_call` 的渲染端路线因此永远走不到(退回 CLI 或直接失败)。
import { withRendererToolRegistry } from "@main/document/documentToolRendererBinding.js";
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
import { configureGenofficeNativeViews, makeGenofficeNativeView, nativeHostStatus } from "@main/document/genofficeViewFactories.js";
// 【T29/T155】原厂五编辑器的关闭守卫（vendor `request*Close` 的转发）。静态 import：
// 快速失败于编译期；vendor 快照缺失时本模块被 build alias 到 stub，
// `requestNativeViewClose` 恒 false（Host 侧 fail-closed）。
import { installDocumentSaveGuard, requestNativeViewClose } from "@main/document/genofficeNativeVendor.js";
import { registerGenofficeViewAiIpc } from "@main/document/genofficeViewAiVendor.js";
import { DocumentViewCredentialBroker, readEngineAdminToken } from "@main/document/documentViewCredentialBroker.js";
import { EngineNodeRegistry } from "@main/workflowEngines/engineNodeRegistry.js";
import { ensureEngineNodeReady } from "@main/workflowEngines/engineNodeReadiness.js";
import { installEngineNode } from "@main/workflowEngines/engineNodeInstallRoute.js";
import { NodeInstallApprovalBridge } from "@main/workflowEngines/engineNodeApprovalBridge.js";
import { getMainWindow, hasLiveRendererWindow, sendToRenderer } from "@main/window.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { registerUnattendedHandlers } from "./unattended.js";
import { registerTheiaPreviewHandlers } from "./theiaPreview.js";
import { registerTheiaInstalledHandlers } from "./theiaInstalled.js";
import { dataRoot } from "@main/lib/dataRoot.js";
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
// 【Q8】引擎自启的装配缝。`registerIpcHandlers` 里装配，`main/index.ts` 在 DB
// 就绪后调用 `runEngineAutostart()`。**存成模块级函数而不是直接导出端口**，是为了让
// `main/index.ts` 不必 import `workflowEngines/*`（那会把它拖进 Electron 之外的依赖面）。
let engineAutostartRunner: (() => Promise<EngineAutostartResult>) | null = null;

/** 装配自启（幂等；生产只在 `registerIpcHandlers` 里调一次）。 */
export function setEngineAutostartRunner(runner: (() => Promise<EngineAutostartResult>) | null): void {
  engineAutostartRunner = runner;
}

/** 需要就拉起引擎。未装配 = 未调用 `registerIpcHandlers`，返回"不需要"。 */
export async function runEngineAutostart(): Promise<EngineAutostartResult> {
  if (engineAutostartRunner === null) return { started: false, reason: null };
  return engineAutostartRunner();
}

export function registerIpcHandlers(): void {  const ipc = createDbGuardedIpc(ipcMain);
  registerProjectHandlers(ipc);
  registerClaudeHandlers(ipc);
  registerDialogHandlers(ipc);
  registerCustomModelHandlers(ipc);
  registerPiModelsHandlers(ipc);
  registerCodexModelsHandlers(ipc);
  registerThemeHandlers(ipc);
  registerFileHandlers(ipc);
  registerTheiaPreviewHandlers(ipc);
  registerTheiaInstalledHandlers(ipc,{dataRoot});
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
  registerWorkflowHandlers(ipc, () => workflowEngineRegistry.dataDirOf("node-red"));
  // 【Q5】迁移待办：启动时迁不动的那几张，由这里读给引擎状态（引擎页显示）。
  setPendingMigrationProvider(() => {
    try {
      const raw = SettingRepo.get(MIGRATION_REPORT_SETTING_KEY);
      if (raw === null || raw === "") return null;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const notice = parsed as { summary?: unknown; pending?: unknown; at?: unknown };
      if (typeof notice.summary !== "string" || !Array.isArray(notice.pending)) return null;
      return {
        summary: notice.summary,
        pending: notice.pending.flatMap((item) => {
          if (item === null || typeof item !== "object") return [];
          const row = item as { workflowId?: unknown; name?: unknown; reason?: unknown };
          if (typeof row.workflowId !== "string" || typeof row.name !== "string") return [];
          return [{ workflowId: row.workflowId, name: row.name,
            reason: typeof row.reason === "string" ? row.reason : "未知原因" }];
        }),
        at: typeof notice.at === "number" ? notice.at : 0,
      };
    } catch {
      return null;
    }
  });
  registerHookHandlers(ipc);
  registerPluginsHandlers(ipc);
  registerBrowserHandlers(ipc);
  registerNotificationHandlers(ipc);
  registerSettingsTransferHandlers(ipc);
  registerMobileHandlers(ipc);
  registerRelayHandlers(ipc);
  registerVoiceHandlers(ipc);
  registerLibraryHandlers(ipc);
  registerMemoryHandlers(ipc);
  registerProjectInitHandlers(ipc);
  registerSceneHandlers(ipc);
  registerTaskHandlers(ipc);
  registerApprovalHandlers(ipc);
  registerDocumentHandlers(ipc);
  // T28: choose the actual upstream factory only after resource validation.
  configureGenofficeNativeViews(resolveGenofficeCliPath(documentRepoRoot()));
  documentViewHost.setVendorViewFactory(
    Object.values(nativeHostStatus()).some(Boolean) ? makeGenofficeNativeView : null,
    (p) => findContainingWorkspaceRoot(p) !== null,
  );
  // 【T29/T155】原厂五编辑器（pdf/markdown/html/sheets/slides）的关闭守卫：dirty
  // 状态与保存/放弃/取消流程归 vendor 主进程（`request*Close`），页面 preload 不
  // 统一订阅 `mcode:document-view:close-check`。宿主把关闭请求转给 vendor 原实现，
  // 不另造脏检查或保存流程。vendor 快照缺失时 stub 恒 false，关闭 fail-closed。
  documentViewHost.setVendorCloseGuard(({ editor, webContents }) =>
    requestNativeViewClose(editor, webContents));
  // 【O10】四个 vendor 保存调用点（html/markdown/pdf/slides）的版本校验 + 文件租约。
  // vendor 自己的 `atomic-write.ts` 注释写明「原子写只管临时文件所有权，version +
  // lease 由 caller/Host 负责」—— 这就是那一半。没装时四个格式的保存与改动前逐字节
  // 相同（vendor 独立运行的行为），装了就在租约内比「打开时版本」再写。
  // vendor 快照缺失时 stub 里是个 no-op（没有接缝可装）。
  installDocumentSaveGuard();
  // 【T40】两处注入**都要**包装过的 ports —— 它们喂的是同一个登记簿:
  //   - 第 170 行:vendor 视图 AI 通道(`registerGenofficeViewAiIpc` 的 `ports`);
  //   - 第 227 行:文档视图宿主的 `docsAiPorts`。
  // 只包一处的话,另一条路上的 AI 请求不会登记绑定 —— `document.tool_call` 在那条
  // 路上仍然永远拿不到活跃绑定。用同一个常量保证两条路是**同一份**包装。
  const registryWrappedDocsAiPorts = withRendererToolRegistry(docsAiPorts);
  if (Object.values(nativeHostStatus()).some(Boolean)) {
    // AI never trusts a renderer-provided project, file path, engine, or session.
    registerGenofficeViewAiIpc(ipcMain, (sender: unknown) => {
      const context = documentViewHost.vendorAiContextForSender(sender);
      return context ? { context, ports: registryWrappedDocsAiPorts } : null;
    });
  }
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
  // T05b: use Mcode's existing pickers, pathGuard and modal approval UI.
  documentViewHost.setDocsPrivilegedPorts(docsPrivilegedPorts);
  documentViewHost.setDocsAiPorts(registryWrappedDocsAiPorts);
  documentViewHost.setConfirmRecovery(async ({ filePath, diskNewer }) => {
    const { dialog, BrowserWindow } = await import("electron");
    const options = {
      type: "warning" as const,
      message: "发现未保存的 Word 文档恢复副本",
      detail: `${filePath}${diskNewer ? "\\n磁盘文件此后已被修改；恢复后仍需手动保存，且保存将进行版本冲突检查。" : ""}`,
      buttons: ["取消打开", "恢复未保存内容", "丢弃恢复副本并打开磁盘文件"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) ?? null;
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return result.response === 1 ? "restore" : result.response === 2 ? "discard" : "cancel";
  });
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
    load: async (workflowId, confirmReplace) => {
      await awaitDb();
      const runtime = workflowEngineRegistry.get("node-red");
      if (!runtime) return { ok: false, reason: "Node-RED 引擎未注册" };
      return loadWorkflowIntoNative(workflowId, {
        get: getWorkflow,
        types: async () => new Map((await loadNodeTypes()).entries.map(entry => [entry.id, entry.manifest])),
        dataDir: () => workflowEngineRegistry.dataDirOf("node-red"),
        // 【T21】迁移预检的宿主事实：审批记录（SQL）与在途运行（执行归属账本的
        // 运行租约）。两样都在主进程里有唯一读口，不另造快照格式。
        migrationFacts: (doc) => ({
          review: workflowReviewOf(doc),
          inFlightWorkflowIds: sharedExecutorOwnership.runningFlowIds(),
        }),
        runtime,
        beforeStart: ensureEngineNodesReady,
        launchSpec: () => workflowEngineRegistry.launchSpec("node-red"),
      }, confirmReplace);
    },
    beforeStart: async (engineId) => {
      if (engineId === "node-red") await ensureEngineNodesReady();
    },
    /* 【Q9e】**打开工作流界面就把引擎拉起来** —— 判据是"用户在用它"，不是
     * "库里已经有 node-red 图"（那一条是启动期的 `startEngineIfNeeded` 用的）。
     *
     * 没有这一条时，全新用户第一次点开工作流看到的是「引擎未就绪」，必须先按一次
     * 「启动」才能画第一张图 —— 与"下载就能用"直接冲突。
     *
     * 走的是与 UI 按钮**完全相同**的 `startWorkflowEngine`（`beforeStart` 的节点包
     * 校验、`launchSpec` 的完整性与版本校验一个都不跳）；这里只改"什么时候起"。 */
    ensureStarted: async (engineId) => {
      await awaitDb();
      return ensureEngineStarted({
        hasNativeWorkflows: () => listWorkflows().some((entry) => entry.engine === "node-red"),
        engine: {
          registry: workflowEngineRegistry,
          launchSpec: (id) => workflowEngineRegistry.launchSpec(id),
          beforeStart: async (id) => {
            if (id === "node-red") await ensureEngineNodesReady();
          },
        },
      }, engineId as "node-red");
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

  // 【Q8】引擎常驻的装配口。放在这里而不是 `main/index.ts`，是因为启动要用的
  // `beforeStart`（节点清单闸门）与 `launchSpec` 都挂在上面那个 `engineNodeRegistry`
  // 上 —— 在别处重建一份只会得到两个互不知晓的清单实例。
  //
  // 由 `main/index.ts` 在 DB 就绪后调用；返回结果**原样带出**，不在这里吞失败。
  setEngineAutostartRunner(async () => {
    const ports: EngineAutostartPorts = {
      hasNativeWorkflows: () => listWorkflows().some((entry) => entry.engine === "node-red"),
      engine: {
        registry: workflowEngineRegistry,
        launchSpec: (engineId) => workflowEngineRegistry.launchSpec(engineId),
        beforeStart: async (engineId) => {
          if (engineId === "node-red") await ensureEngineNodesReady();
        },
      },
    };
    // 【Q6】**先把旧图迁过来，再决定起不起引擎**。顺序反了的话，只有旧图的新用户
    // 第一次启动时引擎不会起（此刻库里还没有 node-red 图），要等第二次启动才生效。
    const migration = await migrateLegacyWorkflows({
      legacyGraphs: () => WorkflowRepo.list()
        .map((row) => row.doc)
        .filter((doc) => (doc.engine ?? "mcode") === "mcode" && doc.nodes.length > 0),
      types: async () => new Map((await loadNodeTypes()).entries.map((entry) => [entry.id, entry.manifest])),
      // 走**保存那条路**（CAS / 审批记录 / 广播都跟着），不是直接 WorkflowRepo.save。
      // 直接写表会绕过 `requireWorkflowReview` 与引擎切换体检。
      save: async (doc) => {
        // `getWorkflow` 在这一刻可能已经读不到（并发删除）：那说明这张图不该再迁，
        // 如实交回失败而不是用一个 null 版本号去撞 CAS。
        const current = getWorkflow(doc.id);
        if (current === null) return { ok: false, error: "工作流已不存在" };
        const result = await saveWorkflow(doc, { expectedRevision: workflowSaveVersion(current) });
        return result.ok ? { ok: true } : { ok: false, ...(result.error !== undefined ? { error: result.error } : {}) };
      },
      evaluate: (doc, types) => {
        const evaluation = evaluateWorkflowMigration({
          doc,
          types,
          // 迁移预检的在途判据要一个"哪些图正在跑"的集合。启动时刻旧执行器还没
          // 挂触发器、引擎也还没起，所以是空集 —— 这是**查过且确认没在跑**，
          // 不是"没有可信快照"（后者该传 undefined，预检会按 unknown 处理）。
          facts: { review: workflowReviewOf(doc), inFlightWorkflowIds: new Set<string>() },
        });
        return { decision: evaluation.decision, summary: evaluation.summary };
      },
    });
    if (migration.outcomes.length > 0) {
      log.info(`[workflow-migration] ${describeMigrationReport(migration)}`);
      for (const outcome of migration.outcomes) {
        if (outcome.decision !== "migrated") {
          log.warn(`[workflow-migration] 「${outcome.name}」未迁移：${outcome.reason ?? "未知原因"}`);
        }
      }
      // 【Q5】结果落进设置 —— 迁移发生在**窗口还没开**的时候，那一刻广播没有听众。
      // 用户事后打开工作流面板才需要看到「有哪几张没迁」。全迁完就清掉这条。
      try {
        const notice = pendingMigrationNoticeOf(migration);
        SettingRepo.set(MIGRATION_REPORT_SETTING_KEY, notice === null ? "" : JSON.stringify(notice));
      } catch (err) {
        log.warn(`[workflow-migration] 迁移结果未能写入设置（界面不会显示这条）：${(err as Error).message}`);
      }
    }
    return startEngineIfNeeded(ports);
  });
}

// Re-export channel constants so handlers stay aligned with the contract.
export { IPC };
