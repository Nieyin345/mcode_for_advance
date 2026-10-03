import { app, BrowserWindow, session } from "electron";
import { createMainWindow } from "@main/window.js";
import { registerIpcHandlers } from "@main/ipc/index.js";
import { initDb, closeDb, awaitDb, flushDb } from "@main/store/db.js";
import { installDbPersistenceAlerts, showDbOpenError, showDbPersistenceError } from "@main/store/persistenceAlerts.js";
import { initTheme } from "@main/lib/theme.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import {
  BRIDGE_TOKEN_SETTING_KEY,
  configureExtensionBridgeTokenStore,
  ensureStarted,
  stopExtensionBridge,
} from "@main/providers/bridge/extensionBridge.js";
import { configureMcpToolHost } from "@main/providers/bridge/mcpEndpoint.js";
import { initPublicMcp, disposePublicMcp, configurePublicMcpRuntime, publicMcpSandboxRoot } from "@main/providers/bridge/publicMcpSession.js";
import { createWebToolHost } from "@main/mcp/webToolHost.js";
import { libraryForAi, sandboxReadCheck } from "@main/mcp/sandboxReadPolicy.js";
import { disposeAllAgentResources } from "@main/mcp/agentSessionCleanup.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { lspManager } from "@main/lsp/LspManager.js";
import { BrowserManager } from "@main/browser/BrowserManager.js";
import { startMobileServer, stopMobileServer, getMobileServer } from "@main/mobile/MobileHttpServer.js";
import { autoStartMobileTunnel, disposeMobileTunnel } from "@main/mobile/mobileTunnel.js";
import { initAgentDelegate } from "@main/mcp/delegateHost.js";
import { relayManager } from "@main/relay/RelayManager.js";
import { RELAY_AUTO_START_SETTING_KEY } from "@contracts/relay";
import { SettingRepo } from "@main/store/repositories.js";
import { initUpdater } from "@main/updater.js";
import { ensureShippedInitializersSeeded } from "@main/projectInit/service.js";
import { initAutoArchiver } from "@main/session/AutoArchiver.js";
import { notificationManager } from "@main/notifications/NotificationManager.js";
import { hookRunner } from "@main/hooks/HookRunner.js";
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { hasActiveRun } from "@main/orchestration/runner.js";
import { is } from "@main/utils.js";
import { preloadClaudeSdk } from "@main/providers/claude-sdk/ClaudeAgentSdkProvider.js";
import { logStartup } from "@main/lib/startupTimer.js";
import { log } from "@main/lib/logger.js";
import { setManagedRuntimeRoot } from "@main/runtimes/managedRuntimeRoots.js";
import { setToolRoot } from "@main/env/managedToolRoots.js";
import { applyAgentEnvironment } from "@main/env/agentEnv.js";
import { getOnlyOfficeOrigin, shutdownOnlyOfficeBridge, flushOnlyOfficeSessions } from "@main/onlyoffice/OnlyOfficeBridge.js";
import { showOnlyOfficeSaveError } from "@main/onlyoffice/persistenceAlerts.js";
import { join } from "node:path";
import { configureLibraryEvents, notifyLibraryChanged } from "@main/library/broadcast.js";
import { importAnyFiles } from "@main/library/importDispatch.js";
import { adoptMarkdownFile } from "@main/library/adoptMarkdown.js";
import { configureCodeNodeLibraryHost } from "@main/orchestration/adoptFromCode.js";
import { initPanelProtocol, registerPanelSchemePrivileged } from "@main/customUi/panelProtocol.js";
import { pathToFileURL } from "node:url";
import { desktopCsp } from "@main/lib/desktopCsp.js";

// 自定义面板的 `mcode-panel://` 协议(R41)。注册特权 scheme **必须**在 app ready 之前。
registerPanelSchemePrivileged();

// 库导入/下载事件的发出口(钩子与「事件发生时」触发器都挂在 runtimeManager 上)。
// 在模块顶层装配:下载队列可能在窗口出来前就恢复并完成条目。注入而非让
// broadcast.ts 直接 import RuntimeManager 的理由见那边的 `LibraryEventRuntime`。
configureLibraryEvents({ emitExternal: (event) => runtimeManager.emitExternal(event) });
// code 节点「收进库 / 挂回 Markdown」的写库能力(理由见 adoptFromCode.ts 的 `CodeNodeLibraryHost`)。
configureCodeNodeLibraryHost({ importAnyFiles, adoptMarkdownFile, notifyLibraryChanged });

// App identity for OS-level surfaces (desktop notifications, taskbar grouping,
// Windows AUMID). setName("Mcode") makes the system notification card title
// read "Mcode" instead of the raw executable name ("electron" in dev, or
// "@mcode/desktop" from package.json).
//
// ⚠️ setName() ALSO changes the default userData path (%APPDATA%/<name>),
// which would orphan the existing database + logs (they live under the
// pre-rename directory). To avoid a silent data wipe, snapshot the current
// userData path BEFORE renaming, then pin it back with setPath() right after.
// Unconditional setPath is safe: when the name already matched (packaged
// builds where exe metadata is "Mcode"), prevUserData == current path and this
// just rewrites the same value (a no-op).
const prevUserData = app.getPath("userData");
app.setName("Mcode");
app.setPath("userData", prevUserData);
// Managed agent runtimes (claude/codex/pi download-on-demand) live under
// userData/runtimes. Register the root early so the binary/library resolvers
// can find installed runtimes from the very first turn.
setManagedRuntimeRoot(join(app.getPath("userData"), "runtimes"));
// 文档工具链(pandoc 等,设置 → 内核)的落点 —— 与 runtimes 并列但**分开**的
// 一个根,理由见 env/managedToolRoots.ts 的文件头。
//
// 紧接着把已装工具挂到 PATH 上:必须在任何 spawn 之前做完,否则第一轮对话里
// agent 敲 `pandoc` 还是找不到(三个 provider 都是 {...process.env},所以这一处
// 覆盖它们全部)。这是一个纯同步操作(读几个目录 + 改一个字符串),放在启动路径
// 上不会拖慢任何东西。
setToolRoot(join(app.getPath("userData"), "tools"));
applyAgentEnvironment();
// Windows: AppUserModelId drives taskbar grouping + the AUMID the toast center
// uses to attribute notifications. Harmless on macOS/Linux (ignored).
if (process.platform === "win32") {
  app.setAppUserModelId("Mcode");
}

// Global exception handlers — install BEFORE anything else. Without these, an
// uncaughtException (e.g. from `new BrowserWindow`, or a require() of a native
// module that fails to load) or an unhandledRejection (from the fire-and-forget
// `void initDb()` / `void initTheme()` / `void initUpdater()` below) crashes
// the main process silently. In a packaged build that looks exactly like "the
// app starts in the background but no window ever appears": the window is
// created with show:false and the ready-to-show -> show() path never completes
// because the process is already dying. These handlers log the cause to
// main.log so the failure is diagnosable instead of invisible.
// 重入保护:若 log.error 自身抛出(如 stderr 管道断裂 EPIPE),重入这些 handler
// 会递归到栈溢出(0xC0000409 STATUS_STACK_BUFFER_OVERRUN)。两个 handler 共用同一
// flag,因为两者都调 log.error。
let handlingGlobalError = false;
process.on("uncaughtException", (err) => {
  if (handlingGlobalError) return;
  handlingGlobalError = true;
  try {
    log.error(`uncaughtException: ${err.stack ?? err}`);
  } finally {
    handlingGlobalError = false;
  }
});
process.on("unhandledRejection", (reason) => {
  if (handlingGlobalError) return;
  handlingGlobalError = true;
  try {
    log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason : String(reason)}`);
  } finally {
    handlingGlobalError = false;
  }
});

// Single-instance lock - only one GUI instance runs at a time.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  // Someone tried to run a second instance — surface our existing window.
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    const [win] = wins;
    if (win.isMinimized()) win.restore();
    // show() is essential here: the main window is created with show:false
    // and only revealed on ready-to-show. If the first launch's renderer is
    // still loading (or stalled), the window may still be hidden, and bare
    // focus() does NOT make a hidden window visible — so the user would see
    // "clicking the shortcut does nothing" even though the process is alive.
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  logStartup("whenReady entered");
  installDbPersistenceAlerts();
  initPanelProtocol();

  // Kick off DB init in the background (sql.js loads ~6MB asm.js + reads the
  // file + migrates). We DON'T await it - the window is created next so the
  // renderer starts loading immediately. IPC handlers await `awaitDb()`
  // internally (see ipc/index.ts), so any request that arrives before the DB
  // is ready simply queues instead of failing.
  void initDb().then(() => {
    // 独立模版库(`<数据根>/templates` + 五个类目目录)已退役(2026-09-27):`d8db783`
    // 把它一次性迁成了统一资料库里的 linked 条目,迁移代码随之删除。老数据根里那个
    // 目录不动 —— linked 条目还指着里面的文件。
    // Legacy cleanup: the browser password vault was removed; wipe any
    // credentials older builds persisted under this key (nothing reads it
    // anymore; SettingRepo has no delete, so overwrite with an empty map).
    if (SettingRepo.get("browser.credentials")) {
      SettingRepo.set("browser.credentials", "{}");
    }
    // 出厂的项目初始化模板(「研究项目」)只播种一次,删了不复活(见 projectInit/shipped.ts)。
    try {
      ensureShippedInitializersSeeded();
    } catch (err) {
      log.warn(`seed shipped project initializers failed: ${String(err)}`);
    }
    // 扩展桥的配对令牌持久化到 settings 表 —— 必须跨重启稳定，否则 mcode 每次
    // 启动都换一个令牌，浏览器里的扩展会静默掉线（用户只会看到"未连接"而不知道
    // 为什么）。注入点必须在这儿：桥模块本身不能碰 db.ts，那会把 electron 拉进
    // 无头 smoke（见 extensionBridge.ts 文件头）。
    configureExtensionBridgeTokenStore({
      get: () => SettingRepo.get(BRIDGE_TOKEN_SETTING_KEY),
      set: (value) => SettingRepo.set(BRIDGE_TOKEN_SETTING_KEY, value),
    });
    // 网页版模型的工具通路:扩展从同一个服务的 `/mcp` 进来,拿 mcode 的工具表。
    // 工具表和进程内那两个 server 是同一份,审批闸门也是同一个(见 webToolHost.ts
    // 文件头)—— 这里只把"会话 → 闸门"接到 RuntimeManager 上。装配很轻(表在扩展
    // 第一次 tools/list 时才转 JSON Schema),所以不必等设置页打开。
    // `cwdFor` 同源:agent_* 文件工具的相对路径与环境块里的工作目录都按会话从
    // RuntimeManager 取(lastCwd → 项目路径)。
    // `sandboxRootFor`:**只对公网那条合成会话**给根(它没有审批闸门,需要一道边界);
    // 其他会话返回 null = 不限制,本机那条路行为不变(见 publicMcpSandboxRoot)。
    configureMcpToolHost(
      createWebToolHost({
        gateFor: (sessionId) => runtimeManager.webToolGate(sessionId),
        cwdFor: (sessionId) => runtimeManager.cwdFor(sessionId),
        sandboxRootFor: (sessionId) => publicMcpSandboxRoot(sessionId),
        // 沙箱外只读:资料库 / 技能库(守屏蔽规则),见 sandboxReadPolicy.ts。
        sandboxReadCheck,
        libraryForAi,
      }),
    );
    // 顺手把桥起起来，别等用户点开设置页才 listen：浏览器里的扩展是**主动来连**
    // 的一方，端口不开它就只能显示"未连接"，而用户并不知道要先去点一下设置页。
    // 失败也不拦启动（绑定失败已经写在 ensureStarted 里，只记日志）。
    void ensureStarted().catch(() => {});

    // **告诉运行时"某个对话此刻有没有一张图在跑"** —— 代理互发消息时靠它决定该叫醒
    // 还是该排队（见 `agentMail.canWake`：图跑着的时候从外面替节点起一轮，会把那一步的
    // 产出弄废，而且不报错）。
    //
    // ⚠️ **注册在这里，不在 `orchestration/runner.ts` 的模块顶层。** 放那边的话，
    // 任何 bundle 了调度器的无头 smoke 都会在 import 那一刻撞上一个换过桩的
    // `runtimeManager`（那些桩没有这个方法），而报出来的是一句与它毫无关系的
    // "registerRunGuard is not a function"。这里是应用真正的装配点，跑得着。
    runtimeManager.registerRunGuard((sessionId) => hasActiveRun(sessionId));

    // 公网 MCP 端点（给 ChatGPT 的 Connector 用）：装配 SettingRepo 存取口，开关
    // 开着就把服务与「ChatGPT 直连」合成会话一并备好。默认关 —— 这条通路等于把本机
    // 操作权交给拿到链接的人（无审批闸门，见 publicMcpServer.ts 文件头）。
    // 运行时能力走注入：直接 import RuntimeManager 会把 provider 图（→ agentTools
    // → agentRemoteSsh → ssh2 原生模块）拉进与它无关的无头 smoke 的打包链。
    configurePublicMcpRuntime({
      setSessionPermissionMode: (sessionId, mode) =>
        runtimeManager.setPermissionMode(sessionId, mode),
      bindSession: (session) => runtimeManager.bindSession(session),
      broadcastSessionChanged: (session) => broadcastSessionChanged(session),
    });
    // 手机伴侣的端口走注入(见 publicMcpSession 里 `mobilePortProvider` 的注释:
    // 直接 import MobileHttpServer 会把 db→electron 拉进几个无关 smoke 的打包图)。
    initPublicMcp({ mobilePort: () => getMobileServer()?.port ?? 0 });
    // 「把 mcode agent 交给外面的 AI 支使」那一组工具的装配。**只是接线** ——
    // 工具报不报得出来由用户那个开关决定(默认关),见 `mcp/delegateServer.ts` 文件头。
    initAgentDelegate();
  }, (err: unknown) => {
    // Only initDb's own rejection lands here (not errors thrown by the ready
    // callback above). Without it the failure was just an unhandledRejection
    // line in main.log while every IPC silently failed on the same promise.
    showDbOpenError(err);
  });

  // CSP only in production - in dev, Vite injects inline HMR scripts that a
  // strict CSP would block, leaving the page blank.
  if (is.prod) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const policy = desktopCsp(details.url, pathToFileURL(join(__dirname, "../renderer/index.html")).href, getOnlyOfficeOrigin() ?? "");
      if (!policy) { callback({}); return; }
      const headers = { ...details.responseHeaders };
      for (const name of Object.keys(headers)) if (name.toLowerCase() === "content-security-policy") delete headers[name];
      callback({ responseHeaders: { ...headers, "Content-Security-Policy": [policy] } });
    });
  }

  // Apply the persisted theme preference. Fire-and-forget: initTheme() awaits
  // DB readiness internally, so the first frame uses the OS-default theme and
  // is corrected to the saved preference once the DB is ready. Only a user
  // preference that differs from the OS causes a brief first-frame flash.
  void initTheme();

  // Register IPC handlers (each awaits DB readiness before running).
  registerIpcHandlers();
  logStartup("IPC handlers registered");

  // HTTP Basic Auth for the embedded browser: BrowserManager pushes an
  // "authRequest" event so the renderer shows a login dialog (answered via
  // the browser.authRespond RPC; credentials are used for that request only).
  // Requests not from a browser view are ignored (default cancel behavior).
  app.on("login", (event, webContents, _details, authInfo, callback) => {
    event.preventDefault();
    // Service-worker authentication may not have a window in current Electron.
    if (!webContents) { callback(); return; }
    BrowserManager.handleLogin(
      webContents.id,
      webContents.getURL(),
      authInfo,
      callback,
    );
  });

  // Create the window immediately - don't wait for DB init to finish. The
  // renderer starts loading its JS/HMR while sql.js parses in parallel.
  createMainWindow();
  logStartup("createMainWindow returned");

  // Warm the Claude Agent SDK module in idle time (deferred 3s). Keeps the
  // large module out of startup AND out of the first turn's send→first-reply
  // critical path. Fire-and-forget; failures surface on real first use.
  preloadClaudeSdk();

  // Start the auto-updater (no-op in dev; only active in packaged builds).
  // Fire-and-forget: the first check is delayed 10s anyway, and the updater
  // module is lazy-loaded, so this never blocks window creation.
  void initUpdater();

  // Start the session auto-archiver. Fire-and-forget: the first pass is
  // delayed 60s and awaits DB readiness internally, so this never blocks
  // window creation.
  initAutoArchiver();

  // Start the notification system. Fire-and-forget: it awaits DB readiness
  // internally (to load prefs), then attaches its event observer to the
  // RuntimeManager. Until the observer attaches, events are simply not
  // observed (no notification) - safe to race with window creation.
  void (async () => {
    try {
      await awaitDb();
      notificationManager.start();
    } catch (err) {
      log.error(`NotificationManager failed to start: ${(err as Error).message}`);
    }
  })();

  // 钩子(HookRunner):挂到同一事件流上。**它也要等数据库就绪** —— 每一条钩子都得
  // 先查会话(种类、标题、工作目录)才知道拿什么跑、在哪个目录跑,而这几个查询都走 db。
  // 不等的话,启动那几秒里的事件会静默地不触发钩子。
  void (async () => {
    try {
      await awaitDb();
      hookRunner.start();
    } catch (err) {
      log.error(`HookRunner failed to start: ${(err as Error).message}`);
    }
  })();

  // 自动化(AutomationRunner):把触发器节点上那句"什么情况下起一次运行"挂起来
  // (定时 / 文件变化 / 事件)。**它也要等数据库就绪** —— 解触发器要读工作流表、
  // 项目路径和清单;不等的话,启动那几秒里命中的定时会把那一次丢掉。
  void (async () => {
    try {
      await awaitDb();
      await automationRunner.start();
    } catch (err) {
      log.error(`AutomationRunner failed to start: ${(err as Error).message}`);
    }
  })();

  // Start the mobile companion HTTP server (LAN-facing). Fire-and-forget: it
  // awaits DB readiness internally to read its enabled/port settings, then
  // binds 0.0.0.0:<port>. If disabled (mobile.enabled=0) it resolves to an
  // idle handle — safe no-op. Failure to bind (port in use) is logged but
  // never blocks the app. When "start remote access on launch" is enabled and
  // a VPS config exists, auto-connect the relay tunnel right after the mobile
  // server is up (the relay forwards into it).
  void (async () => {
    try {
      await startMobileServer();
      await maybeAutoStartRelay();
      // 手机自有域名的隧道(与公网 MCP 无关):上次开着就自动拉起。
      await autoStartMobileTunnel();
    } catch (err) {
      log.error(`mobile server failed to start: ${(err as Error).message}`);
    }
  })();

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Quit when all windows are closed, except on macOS.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/** If "start remote access on launch" is enabled and a VPS config exists,
 *  auto-connect the relay tunnel. Best-effort — failures are logged, never
 *  thrown (startup must not be blocked). */
async function maybeAutoStartRelay(): Promise<void> {
  try {
    const raw = SettingRepo.get(RELAY_AUTO_START_SETTING_KEY);
    if (raw !== "1") return;
    if (!relayManager.getConfig()) return;
    log.info("relay: auto-start enabled, connecting…");
    const result = await relayManager.connect();
    if (!result.ok && result.error) {
      log.warn(`relay: auto-start connect failed: ${result.error}`);
    }
  } catch (err) {
    log.warn(`relay: auto-start failed: ${(err as Error).message}`);
  }
}

// Close PTYs + bridge servers + LSP servers + browser views + DB cleanly on shutdown (best-effort).
//
// Cookie vault: before-quit does NOT wait for async work, so the first
// invocation preventDefaults, snapshots the embedded browser's cookies into
// the settings table (time-boxed so a hung cookie store can never wedge the
// quit), then re-enters quit; the second pass runs the synchronous teardown
// below (which is also what closes the DB the vault row was written to).
let sessionCookiesFlushed = false;
let quitPreparationPending = false;
app.on("before-quit", (event) => {
  if (!sessionCookiesFlushed) {
    event.preventDefault();
    if (quitPreparationPending) return;
    quitPreparationPending = true;
    // Freeze editing while we take the final snapshot; otherwise changes typed
    // during an asynchronous force-save could be lost immediately afterwards.
    const windows = BrowserWindow.getAllWindows().filter((win) => win.isEnabled());
    for (const win of windows) win.setEnabled(false);
    void (async () => {
      try {
        const timeout = new Promise<void>((r) => setTimeout(r, 3000).unref());
        try { await Promise.race([BrowserManager.saveCookieVault(), timeout]); }
        catch (error) { log.warn(`cookie vault flush failed: ${String(error)}`); }
        await flushOnlyOfficeSessions();
        sessionCookiesFlushed = true;
        app.quit();
      } catch (error) {
        // Keep the callback server, DB and other services alive for retry.
        showOnlyOfficeSaveError(error);
      } finally {
        quitPreparationPending = false;
        if (!sessionCookiesFlushed) {
          for (const win of windows) if (!win.isDestroyed()) win.setEnabled(true);
        }
      }
    })();
    return;
  }
  // Save BEFORE tearing down services. If storage is unavailable, retain the
  // live DB and the working app instead of silently losing in-memory changes.
  try { flushDb(); }
  catch (error) {
    event.preventDefault();
    sessionCookiesFlushed = false;
    showDbPersistenceError(error);
    return;
  }
  BridgeRegistry.disposeAll();
  stopExtensionBridge();
  disposePublicMcp();
  shutdownOnlyOfficeBridge();
  TerminalManager.disposeAll();
  // agent 起的后台进程(npm run dev 之类)不会随应用退出,这里杀掉。
  disposeAllAgentResources();
  lspManager.disposeAll();
  BrowserManager.disposeAll();
  relayManager.disposeAll();
  // 关掉定时针、目录监听、事件订阅 —— 它们都挂在事件流 / 文件系统上,不关的话
  // 退出过程中还可能起一次运行(而那时数据库已经在关了,见下面 `closeDb`)。
  automationRunner.dispose();
  disposeMobileTunnel();
  stopMobileServer();
  try { closeDb(); }
  catch (error) {
    // Also protect the final save if a cleanup wrote more data after preflight.
    event.preventDefault();
    sessionCookiesFlushed = false;
    showDbPersistenceError(error);
  }
});
