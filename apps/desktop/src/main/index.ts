import { app, BrowserWindow, session } from "electron";
import { createMainWindow } from "@main/window.js";
import { registerIpcHandlers } from "@main/ipc/index.js";
import { initDb, closeDb, awaitDb } from "@main/store/db.js";
import { ensureTemplateDirs } from "@main/templates/store.js";
import { migrateTemplatesToLibraryOnce } from "@main/library/templateMigration.js";
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
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { lspManager } from "@main/lsp/LspManager.js";
import { BrowserManager } from "@main/browser/BrowserManager.js";
import { startMobileServer, stopMobileServer } from "@main/mobile/MobileHttpServer.js";
import { relayManager } from "@main/relay/RelayManager.js";
import { RELAY_AUTO_START_SETTING_KEY } from "@contracts/relay";
import { SettingRepo } from "@main/store/repositories.js";
import { initUpdater } from "@main/updater.js";
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
import { join } from "node:path";

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

  // Kick off DB init in the background (sql.js loads ~6MB asm.js + reads the
  // file + migrates). We DON'T await it - the window is created next so the
  // renderer starts loading immediately. IPC handlers await `awaitDb()`
  // internally (see ipc/index.ts), so any request that arrives before the DB
  // is ready simply queues instead of failing.
  void initDb().then(() => {
    // 模版库的骨架目录(库根 + 五个类目)在**启动时**就建好,而不是等用户点开设置页。
    // 用户会直接从资源管理器往这些目录里丢文件(文件系统即事实源),所以它们应该一开始
    // 就在 —— 否则用户照着界面上显示的路径去找会发现没有,以为坏了(实际发生过)。
    ensureTemplateDirs();
    // 统一资料库(M4):旧模版一次性迁成 linked 条目。放在 ensureTemplateDirs 之后
    // —— 迁移要扫模版目录,骨架得先在。没迁过才跑(幂等在 templateMigration 里),
    // 失败只记日志,不拦启动。
    migrateTemplatesToLibraryOnce();
    // Legacy cleanup: the browser password vault was removed; wipe any
    // credentials older builds persisted under this key (nothing reads it
    // anymore; SettingRepo has no delete, so overwrite with an empty map).
    if (SettingRepo.get("browser.credentials")) {
      SettingRepo.set("browser.credentials", "{}");
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
    initPublicMcp();
  });

  // CSP only in production - in dev, Vite injects inline HMR scripts that a
  // strict CSP would block, leaving the page blank.
  if (is.prod) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
            "Content-Security-Policy": [
            // ⚠️ `worker-src 'self' blob:` 是 EmbedPDF 要的，不是可选的。
            //
            // 它把 PDFium 引擎跑在 **worker** 里，而那个 worker 是
            // `URL.createObjectURL(new Blob([...]))` **现铸**出来的（见它的
            // `worker-engine-*.js`），所以 URL 是 `blob:` 开头。CSP 里没写
            // `worker-src` 时回落到 `default-src 'self'` —— `blob:` 不在其中，
            // 于是 worker 起不来、引擎初始化不完，界面**永远停在
            // "Initializing plugins…"**，而控制台只有一句被拒的报错，看着完全
            // 不像"worker 的事"。
            //
            // `'wasm-unsafe-eval'` 同理：PDFium 是 WebAssembly。
            //
            // 只把 `blob:` 加进 `worker-src`，不碰 `script-src` —— 那个口子
            // （内联脚本）比这里需要的宽得多。手机端走 HTTP、没有这层 Electron
            // CSP，所以这条只影响桌面。
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
          ],
        },
      });
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
app.on("before-quit", (event) => {
  if (!sessionCookiesFlushed) {
    event.preventDefault();
    const timeout = new Promise<void>((r) => setTimeout(r, 3000).unref());
    void Promise.race([BrowserManager.saveCookieVault(), timeout]).finally(() => {
      sessionCookiesFlushed = true;
      app.quit();
    });
    return;
  }
  BridgeRegistry.disposeAll();
  stopExtensionBridge();
  disposePublicMcp();
  TerminalManager.disposeAll();
  lspManager.disposeAll();
  BrowserManager.disposeAll();
  relayManager.disposeAll();
  // 关掉定时针、目录监听、事件订阅 —— 它们都挂在事件流 / 文件系统上,不关的话
  // 退出过程中还可能起一次运行(而那时数据库已经在关了,见下面 `closeDb`)。
  automationRunner.dispose();
  stopMobileServer();
  closeDb();
});
