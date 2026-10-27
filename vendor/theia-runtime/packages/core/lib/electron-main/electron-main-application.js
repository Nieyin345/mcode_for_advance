"use strict";
// *****************************************************************************
// Copyright (C) 2020 Ericsson and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElectronMainApplication = exports.ElectronMainProcessArgv = exports.ElectronMainApplicationContribution = exports.ElectronMainApplicationGlobals = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const electron_1 = require("../../electron-shared/electron");
const path = require("path");
const fs_1 = require("fs");
const fs_extra_1 = require("fs-extra");
const child_process_1 = require("child_process");
const application_props_1 = require("@theia/application-package/lib/application-props");
const uri_1 = require("../common/uri");
const file_uri_1 = require("../common/file-uri");
const promise_util_1 = require("../common/promise-util");
const performance_1 = require("../common/performance");
const contribution_provider_1 = require("../common/contribution-provider");
const electron_security_token_service_1 = require("./electron-security-token-service");
const electron_token_1 = require("../electron-common/electron-token");
const Storage = require("electron-store");
const common_1 = require("../common");
const window_1 = require("../common/window");
const launch_argv_parser_1 = require("./launch-argv-parser");
const launch_args_store_1 = require("./launch-args-store");
const theia_electron_window_1 = require("./theia-electron-window");
const electron_main_constants_1 = require("./electron-main-constants");
Object.defineProperty(exports, "ElectronMainApplicationGlobals", { enumerable: true, get: function () { return electron_main_constants_1.ElectronMainApplicationGlobals; } });
const event_utils_1 = require("./event-utils");
const electron_api_main_1 = require("./electron-api-main");
const frontend_application_state_1 = require("../common/frontend-application-state");
const dynamic_require_1 = require("../node/dynamic-require");
const backend_global_1 = require("../node/backend-global");
const createYargs = require('yargs/yargs');
const ELECTRON_TIMER_WARNING_THRESHOLD = 50;
/**
 * The default entrypoint will handle a very rudimentary CLI to open workspaces by doing `app path/to/workspace`. To override this behavior, you can extend and rebind the
 * `ElectronMainApplication` class and overriding the `launch` method.
 * A JSON-RPC communication between the Electron Main Process and the Renderer Processes is available: You can bind services using the `ElectronConnectionHandler` and
 * `ElectronIpcConnectionProvider` APIs, example:
 *
 * From an `electron-main` module:
 *
 *     bind(ElectronConnectionHandler).toDynamicValue(context =>
 *          new RpcConnectionHandler(electronMainWindowServicePath,
 *          () => context.container.get(ElectronMainWindowService))
 *     ).inSingletonScope();
 *
 * And from the `electron-browser` module:
 *
 *     bind(ElectronMainWindowService).toDynamicValue(context =>
 *          ElectronIpcConnectionProvider.createProxy(context.container, electronMainWindowServicePath)
 *     ).inSingletonScope();
 */
exports.ElectronMainApplicationContribution = Symbol('ElectronMainApplicationContribution');
// Extracted and modified the functionality from `yargs@15.4.0-beta.0`.
// Based on https://github.com/yargs/yargs/blob/522b019c9a50924605986a1e6e0cb716d47bcbca/lib/process-argv.ts
let ElectronMainProcessArgv = class ElectronMainProcessArgv {
    get processArgvBinIndex() {
        // The binary name is the first command line argument for:
        // - bundled Electron apps: bin argv1 argv2 ... argvn
        if (this.isBundledElectronApp) {
            return 0;
        }
        // or the second one (default) for:
        // - standard node apps: node bin.js argv1 argv2 ... argvn
        // - unbundled Electron apps: electron bin.js argv1 arg2 ... argvn
        return 1;
    }
    get isBundledElectronApp() {
        // process.defaultApp is either set by electron in an electron unbundled app, or undefined
        // see https://github.com/electron/electron/blob/master/docs/api/process.md#processdefaultapp-readonly
        return this.isElectronApp && !process.defaultApp;
    }
    get isElectronApp() {
        // process.versions.electron is either set by electron, or undefined
        // see https://github.com/electron/electron/blob/master/docs/api/process.md#processversionselectron-readonly
        return !!process.versions.electron;
    }
    getProcessArgvWithoutBin(argv = process.argv) {
        return argv.slice(this.processArgvBinIndex + 1);
    }
    getProcessArgvBin(argv = process.argv) {
        return argv[this.processArgvBinIndex];
    }
};
exports.ElectronMainProcessArgv = ElectronMainProcessArgv;
exports.ElectronMainProcessArgv = ElectronMainProcessArgv = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ElectronMainProcessArgv);
let ElectronMainApplication = class ElectronMainApplication {
    constructor() {
        this.isPortable = this.makePortable();
        this.electronStore = new Storage();
        this._backendPort = new promise_util_1.Deferred();
        this.backendPort = this._backendPort.promise;
        this.useNativeWindowFrame = true;
        this.didUseNativeWindowFrameOnStart = new Map();
        this.windows = new Map();
        this.activeWindowStack = [];
        this.restarting = false;
    }
    get config() {
        if (!this._config) {
            throw new Error('You have to start the application first.');
        }
        return this._config;
    }
    makePortable() {
        const dataFolderPath = path.join(electron_1.app.getAppPath(), 'data');
        const appDataPath = path.join(dataFolderPath, 'app-data');
        if ((0, fs_extra_1.existsSync)(dataFolderPath)) {
            if (!(0, fs_extra_1.existsSync)(appDataPath)) {
                (0, fs_extra_1.mkdirSync)(appDataPath);
            }
            electron_1.app.setPath('userData', appDataPath);
            return true;
        }
        else {
            return false;
        }
    }
    async start(config) {
        const argv = this.processArgv.getProcessArgvWithoutBin(process.argv);
        createYargs(argv, process.cwd())
            .help(false)
            .command('$0 [file]', false, cmd => cmd
            .option('electronUserData', {
            type: 'string',
            describe: 'The area where the electron main process puts its data'
        })
            .positional('file', { type: 'string' }), async (args) => {
            if (args.electronUserData) {
                console.info(`using electron user data area : '${args.electronUserData}'`);
                await fs_1.promises.mkdir(args.electronUserData, { recursive: true });
                electron_1.app.setPath('userData', args.electronUserData);
            }
            const startupMeasurement = this.stopwatch.start('electron-main-startup');
            this.useNativeWindowFrame = this.getTitleBarStyle(config) === 'native';
            this._config = config;
            if (common_1.isWindows && !!config.electron.appUserModelId) {
                electron_1.app.setAppUserModelId(config.electron.appUserModelId);
            }
            this.hookApplicationEvents();
            this.showInitialWindow(argv.includes('--open-url') ? argv[argv.length - 1] : undefined);
            const port = await this.stopwatch.startAsync('electron-main-start-backend', 'Starting backend', () => this.startBackend());
            this._backendPort.resolve(port);
            await electron_1.app.whenReady();
            await this.stopwatch.startAsync('electron-main-security-token', 'Attaching security token', () => this.attachElectronSecurityToken(port));
            await this.stopwatch.startAsync('electron-main-start-contributions', 'Starting contributions', () => this.startContributions());
            startupMeasurement.info('Startup sequence completed');
            const launchArgs = launch_argv_parser_1.LaunchArgvParser.parse(argv);
            this.handleMainCommand({
                file: args.file,
                cwd: process.cwd(),
                secondInstance: false,
                claimed: await this.isWindowClaimed(launchArgs)
            });
        }).parse();
    }
    getTitleBarStyle(config) {
        if ('THEIA_ELECTRON_DISABLE_NATIVE_ELEMENTS' in process.env && process.env.THEIA_ELECTRON_DISABLE_NATIVE_ELEMENTS === '1') {
            return 'custom';
        }
        if (common_1.isOSX) {
            return 'native';
        }
        const storedFrame = this.electronStore.get('windowstate')?.frame;
        if (storedFrame !== undefined) {
            return !!storedFrame ? 'native' : 'custom';
        }
        if (config.preferences && config.preferences['window.titleBarStyle']) {
            const titleBarStyle = config.preferences['window.titleBarStyle'];
            if (titleBarStyle === 'native' || titleBarStyle === 'custom') {
                return titleBarStyle;
            }
        }
        return common_1.isWindows ? 'custom' : 'native';
    }
    setTitleBarStyle(webContents, style) {
        this.useNativeWindowFrame = common_1.isOSX || style === 'native';
        this.saveState(webContents);
    }
    setBackgroundColor(webContents, backgroundColor) {
        electron_1.BrowserWindow.fromWebContents(webContents)?.setBackgroundColor(backgroundColor);
        this.customBackgroundColor = backgroundColor;
        this.saveState(webContents);
    }
    setTheme(theme) {
        electron_1.nativeTheme.themeSource = theme;
    }
    saveState(webContents) {
        const browserWindow = electron_1.BrowserWindow.fromWebContents(webContents);
        if (browserWindow) {
            this.saveWindowState(browserWindow);
        }
        else {
            console.warn(`no BrowserWindow with id: ${webContents.id}`);
        }
    }
    /**
     * @param id the id of the WebContents of the BrowserWindow in question
     * @returns 'native' or 'custom'
     */
    getTitleBarStyleAtStartup(webContents) {
        return this.didUseNativeWindowFrameOnStart.get(webContents.id) ? 'native' : 'custom';
    }
    async determineSplashScreenBounds(initialWindowBounds) {
        const splashScreenOptions = this.getSplashScreenOptions();
        const width = splashScreenOptions?.width ?? 640;
        const height = splashScreenOptions?.height ?? 480;
        // determine the screen on which to show the splash screen via the center of the window to show
        const windowCenterPoint = { x: initialWindowBounds.x + (initialWindowBounds.width / 2), y: initialWindowBounds.y + (initialWindowBounds.height / 2) };
        const { bounds } = electron_1.screen.getDisplayNearestPoint(windowCenterPoint);
        // place splash screen center of screen
        const screenCenterPoint = { x: bounds.x + (bounds.width / 2), y: bounds.y + (bounds.height / 2) };
        const x = screenCenterPoint.x - (width / 2);
        const y = screenCenterPoint.y - (height / 2);
        return {
            x, y, width, height
        };
    }
    isShowWindowEarly() {
        return !!this.config.electron.showWindowEarly &&
            !('THEIA_ELECTRON_NO_EARLY_WINDOW' in process.env && process.env.THEIA_ELECTRON_NO_EARLY_WINDOW === '1');
    }
    showInitialWindow(urlToOpen) {
        if (this.isShowWindowEarly() || this.isShowSplashScreen()) {
            electron_1.app.whenReady().then(async () => {
                const options = await this.getLastWindowOptions();
                // If we want to show a splash screen, don't auto open the main window
                if (this.isShowSplashScreen()) {
                    options.preventAutomaticShow = true;
                }
                this.initialWindow = await this.createWindow({ ...options });
                electron_api_main_1.TheiaRendererAPI.onApplicationStateChanged(this.initialWindow.webContents, state => {
                    if (state === 'ready' && urlToOpen) {
                        this.openUrl(urlToOpen);
                    }
                });
                if (this.isShowSplashScreen()) {
                    console.log('Showing splash screen');
                    this.configureAndShowSplashScreen(this.initialWindow);
                }
                // Show main window early if windows shall be shown early and splash screen is not configured
                if (this.isShowWindowEarly() && !this.isShowSplashScreen()) {
                    console.log('Showing main window early');
                    this.initialWindow.show();
                }
            });
        }
    }
    async configureAndShowSplashScreen(mainWindow) {
        const splashScreenOptions = this.getSplashScreenOptions();
        console.debug('SplashScreen options', splashScreenOptions);
        const splashScreenBounds = await this.determineSplashScreenBounds(mainWindow.getBounds());
        const splashScreenWindow = new electron_1.BrowserWindow({
            ...splashScreenBounds,
            frame: false,
            alwaysOnTop: true,
            show: false,
            transparent: true,
            webPreferences: {
                backgroundThrottling: false
            }
        });
        if (this.isShowWindowEarly()) {
            console.log('Showing splash screen early');
            splashScreenWindow.show();
        }
        else {
            splashScreenWindow.on('ready-to-show', () => {
                splashScreenWindow.show();
            });
        }
        splashScreenWindow.loadFile(path.resolve(this.globals.THEIA_APP_PROJECT_PATH, splashScreenOptions.content).toString());
        // close splash screen and show main window once frontend is ready or a timeout is hit
        const cancelTokenSource = new common_1.CancellationTokenSource();
        const minTime = (0, promise_util_1.timeout)(splashScreenOptions.minDuration ?? 0, cancelTokenSource.token);
        const maxTime = (0, promise_util_1.timeout)(splashScreenOptions.maxDuration ?? 30000, cancelTokenSource.token);
        // Swallow rejections that occur when the cancellation token is cancelled after one of the timers wins.
        const ignoreCancellation = () => { };
        const showWindowAndCloseSplashScreen = () => {
            cancelTokenSource.cancel();
            if (!mainWindow.isVisible()) {
                mainWindow.show();
            }
            splashScreenWindow.close();
        };
        electron_api_main_1.TheiaRendererAPI.onApplicationStateChanged(mainWindow.webContents, state => {
            if (state === 'ready') {
                minTime.then(() => showWindowAndCloseSplashScreen(), ignoreCancellation);
            }
        });
        maxTime.then(() => showWindowAndCloseSplashScreen(), ignoreCancellation);
        return splashScreenWindow;
    }
    isShowSplashScreen() {
        return !process.env.THEIA_NO_SPLASH && typeof this.config.electron.splashScreenOptions === 'object' && !!this.config.electron.splashScreenOptions.content;
    }
    getSplashScreenOptions() {
        if (this.isShowSplashScreen()) {
            return this.config.electron.splashScreenOptions;
        }
        return undefined;
    }
    /**
     * Use this rather than creating `BrowserWindow` instances from scratch, since some security parameters need to be set, this method will do it.
     *
     * @param options
     */
    async createWindow(asyncOptions = this.getDefaultTheiaWindowOptions()) {
        let options = await asyncOptions;
        options = this.avoidOverlap(options);
        const electronWindow = this.windowFactory(options, this.config);
        const id = electronWindow.window.webContents.id;
        this.activeWindowStack.push(id);
        this.windows.set(id, electronWindow);
        electronWindow.onDidClose(() => {
            const stackIndex = this.activeWindowStack.indexOf(id);
            if (stackIndex >= 0) {
                this.activeWindowStack.splice(stackIndex, 1);
            }
            this.windows.delete(id);
            this.launchArgsStore.delete(id);
        });
        electronWindow.window.on('maximize', () => electron_api_main_1.TheiaRendererAPI.sendWindowEvent(electronWindow.window.webContents, 'maximize'));
        electronWindow.window.on('unmaximize', () => electron_api_main_1.TheiaRendererAPI.sendWindowEvent(electronWindow.window.webContents, 'unmaximize'));
        electronWindow.window.on('focus', () => {
            const stackIndex = this.activeWindowStack.indexOf(id);
            if (stackIndex >= 0) {
                this.activeWindowStack.splice(stackIndex, 1);
            }
            this.activeWindowStack.unshift(id);
            electron_api_main_1.TheiaRendererAPI.sendWindowEvent(electronWindow.window.webContents, 'focus');
        });
        this.attachSaveWindowState(electronWindow.window);
        return electronWindow.window;
    }
    async getLastWindowOptions() {
        const previousWindowState = this.electronStore.get('windowstate');
        const windowState = previousWindowState?.screenLayout === this.getCurrentScreenLayout()
            ? previousWindowState
            : this.getDefaultTheiaWindowOptions();
        const result = {
            frame: this.useNativeWindowFrame,
            ...this.getDefaultOptions(),
            ...windowState
        };
        result.webPreferences = {
            ...result.webPreferences,
            preload: path.resolve(this.globals.THEIA_APP_PROJECT_PATH, 'lib', 'frontend', 'preload.js').toString()
        };
        return result;
    }
    avoidOverlap(options) {
        const existingWindowsBounds = electron_1.BrowserWindow.getAllWindows().map(window => window.getBounds());
        if (existingWindowsBounds.length > 0) {
            while (existingWindowsBounds.some(window => window.x === options.x || window.y === options.y)) {
                // if the window is maximized or in fullscreen, use the default window options.
                if (options.isMaximized || options.isFullScreen) {
                    options = this.getDefaultTheiaWindowOptions();
                }
                options.x = options.x + 30;
                options.y = options.y + 30;
            }
        }
        return options;
    }
    getDefaultOptions() {
        return {
            show: false,
            title: this.config.applicationName,
            backgroundColor: application_props_1.DefaultTheme.defaultBackgroundColor(this.config.electron.windowOptions?.darkTheme || electron_1.nativeTheme.shouldUseDarkColors),
            minWidth: 200,
            minHeight: 120,
            webPreferences: {
                // `global` is undefined when `true`.
                contextIsolation: true,
                sandbox: false,
                nodeIntegration: false,
                // Setting the following option to `true` causes some features to break, somehow.
                // Issue: https://github.com/eclipse-theia/theia/issues/8577
                nodeIntegrationInWorker: false,
                backgroundThrottling: false,
                enableDeprecatedPaste: true
            },
            ...this.config.electron?.windowOptions || {},
        };
    }
    closeWindowById(webContentsId) {
        const window = this.windows.get(webContentsId);
        if (window) {
            window.close(frontend_application_state_1.StopReason.Close);
        }
    }
    async openDefaultWindow(params, launchArgs) {
        const options = this.getDefaultTheiaWindowOptions();
        const [uri, electronWindow] = await Promise.all([this.createWindowUri(params), this.reuseOrCreateWindow(options)]);
        this.stashLaunchArgs(electronWindow, launchArgs);
        electronWindow.loadURL(uri.withFragment(window_1.DEFAULT_WINDOW_HASH).toString(true));
        return electronWindow;
    }
    async openWindowWithWorkspace(workspacePath, launchArgs) {
        const options = await this.getLastWindowOptions();
        const [uri, electronWindow] = await Promise.all([this.createWindowUri(), this.reuseOrCreateWindow(options)]);
        this.stashLaunchArgs(electronWindow, launchArgs);
        electronWindow.loadURL(uri.withFragment(encodeURI(workspacePath)).toString(true));
        return electronWindow;
    }
    /**
     * Associates the parsed options of a forwarded launch with the target window before it loads its
     * URL, so that the preload script cannot ask for them before they are stored. No-op for a
     * cold-start launch, which carries none.
     *
     * @experimental
     */
    stashLaunchArgs(window, launchArgs) {
        if (launchArgs) {
            this.launchArgsStore.store(window.webContents.id, launchArgs);
        }
    }
    async reuseOrCreateWindow(asyncOptions) {
        if (!this.initialWindow) {
            return this.createWindow(asyncOptions);
        }
        // reset initial window after having it re-used once
        const window = this.initialWindow;
        this.initialWindow = undefined;
        return window;
    }
    /**
     * "Gently" close all windows, application will not stop if a `beforeunload` handler returns `false`.
     */
    requestStop() {
        electron_1.app.quit();
    }
    async handleMainCommand(options) {
        // A claimed launch (e.g. a CLI attach) opens an empty window rather than restoring the last
        // workspace: the local workbench would only be discarded when the window reloads into the
        // claimed target, so loading a real workspace behind the placeholder wastes work and can
        // trigger side effects.
        if (options.claimed) {
            await this.openDefaultWindow(undefined, options.launchArgs);
            return;
        }
        let workspacePath;
        if (options.file) {
            try {
                workspacePath = await fs_1.promises.realpath(path.resolve(options.cwd, options.file));
            }
            catch {
                console.error(`Could not resolve the workspace path. "${options.file}" is not a valid 'file' option. Falling back to the default workspace location.`);
            }
        }
        if (workspacePath !== undefined) {
            await this.openWindowWithWorkspace(workspacePath, options.launchArgs);
        }
        else {
            if (options.secondInstance === false) {
                await this.openWindowWithWorkspace('', options.launchArgs); // restore previous workspace.
            }
            else if (options.file === undefined) {
                await this.openDefaultWindow(undefined, options.launchArgs);
            }
        }
    }
    /**
     * Returns the parsed launch options stored for the window with the given `webContents` id, or
     * `undefined` for a cold-start window. Read from the per-window metadata channel, where the
     * caller is identified by the IPC sender, so a window can only ever see its own options.
     *
     * @experimental
     */
    getLaunchArgs(windowId) {
        return this.launchArgsStore.get(windowId);
    }
    /**
     * Whether any {@link ElectronMainApplicationContribution} claims responsibility for a window
     * opened for the given launch (see its `claimsWindow` hook). Core stays agnostic of the concrete
     * CLI options; e.g. `@theia/dev-container` claims `--attach-container` launches.
     *
     * @experimental
     */
    async isWindowClaimed(args) {
        for (const contribution of this.contributions.getContributions()) {
            if (await contribution.claimsWindow?.(args)) {
                return true;
            }
        }
        return false;
    }
    async openUrl(url) {
        for (const id of this.activeWindowStack) {
            const window = this.windows.get(id);
            if (window && await window.openUrl(url)) {
                break;
            }
        }
    }
    async createWindowUri(params = {}) {
        if (!('port' in params)) {
            params.port = (await this.backendPort).toString();
        }
        const query = Object.entries(params).map(([name, value]) => `${name}=${value}`).join('&');
        return file_uri_1.FileUri.create(this.globals.THEIA_FRONTEND_HTML_PATH)
            .withQuery(query);
    }
    getDefaultTheiaWindowOptions() {
        const result = {
            frame: this.useNativeWindowFrame,
            isFullScreen: false,
            isMaximized: false,
            ...this.getDefaultTheiaWindowBounds(),
            ...this.getDefaultOptions(),
        };
        result.webPreferences = {
            ...result.webPreferences || {},
            preload: path.resolve(this.globals.THEIA_APP_PROJECT_PATH, 'lib', 'frontend', 'preload.js').toString()
        };
        return result;
    }
    getDefaultTheiaSecondaryWindowBounds() {
        return {};
    }
    getDefaultTheiaWindowBounds() {
        const { bounds } = this.getDisplayForNewWindow();
        // We must center by hand because `browserWindow.center()` fails on multi-screen setups
        // See: https://github.com/electron/electron/issues/3490
        const height = Math.round(bounds.height * (2 / 3));
        const width = Math.round(bounds.width * (2 / 3));
        const y = Math.round(bounds.y + (bounds.height - height) / 2);
        const x = Math.round(bounds.x + (bounds.width - width) / 2);
        return {
            width,
            height,
            x,
            y
        };
    }
    /**
     * Returns the display where a new window should be opened.
     * Attempts to use the display nearest to the cursor position for multi-monitor setups.
     * Falls back to the primary display if cursor position cannot be determined
     * (e.g., on Wayland before any window is opened).
     * See: https://github.com/eclipse-theia/theia/issues/16582
     */
    getDisplayForNewWindow() {
        // On Wayland, screen.getCursorScreenPoint() causes a native crash (SIGSEGV)
        // before any window is opened. Detect Wayland and use primary display instead.
        if (this.isWaylandSession()) {
            console.debug('Running under Wayland, using primary display for new window.');
            return electron_1.screen.getPrimaryDisplay();
        }
        try {
            return electron_1.screen.getDisplayNearestPoint(electron_1.screen.getCursorScreenPoint());
        }
        catch (error) {
            console.warn('Failed to get cursor screen point, falling back to primary display.', error);
            return electron_1.screen.getPrimaryDisplay();
        }
    }
    /**
     * Detects if the current session is running natively under Wayland
     * (i.e., not using X11 fallback/XWayland).
     */
    isWaylandSession() {
        if (process.platform !== 'linux') {
            return false;
        }
        // Primary check: WAYLAND_DISPLAY is set when a Wayland compositor is running
        const hasWaylandDisplay = !!process.env.WAYLAND_DISPLAY;
        // Secondary check: XDG_SESSION_TYPE explicitly set to 'wayland'
        const isWaylandSession = process.env.XDG_SESSION_TYPE === 'wayland';
        // Check whether X11 fallback is in use
        const usingX11Fallback = process.env.GDK_BACKEND?.includes('x11') ||
            process.env.ELECTRON_OZONE_PLATFORM_HINT === 'x11' ||
            process.argv.includes('--ozone-platform=x11');
        return (hasWaylandDisplay || isWaylandSession) && !usingX11Fallback;
    }
    /**
     * Save the window geometry state on every change.
     */
    attachSaveWindowState(electronWindow) {
        const windowStateListeners = new common_1.DisposableCollection();
        let delayedSaveTimeout;
        const saveWindowStateDelayed = () => {
            if (delayedSaveTimeout) {
                clearTimeout(delayedSaveTimeout);
            }
            delayedSaveTimeout = setTimeout(() => this.saveWindowState(electronWindow), 1000);
        };
        (0, event_utils_1.createDisposableListener)(electronWindow, 'close', () => {
            this.saveWindowState(electronWindow);
        }, windowStateListeners);
        (0, event_utils_1.createDisposableListener)(electronWindow, 'resize', saveWindowStateDelayed, windowStateListeners);
        (0, event_utils_1.createDisposableListener)(electronWindow, 'move', saveWindowStateDelayed, windowStateListeners);
        windowStateListeners.push(common_1.Disposable.create(() => { try {
            this.didUseNativeWindowFrameOnStart.delete(electronWindow.webContents.id);
        }
        catch { } }));
        this.didUseNativeWindowFrameOnStart.set(electronWindow.webContents.id, this.useNativeWindowFrame);
        electronWindow.once('closed', () => windowStateListeners.dispose());
    }
    saveWindowState(electronWindow) {
        // In some circumstances the `electronWindow` can be `null`
        if (!electronWindow) {
            return;
        }
        try {
            const bounds = electronWindow.getBounds();
            const options = {
                isFullScreen: electronWindow.isFullScreen(),
                isMaximized: electronWindow.isMaximized(),
                width: bounds.width,
                height: bounds.height,
                x: bounds.x,
                y: bounds.y,
                frame: this.useNativeWindowFrame,
                screenLayout: this.getCurrentScreenLayout(),
                backgroundColor: this.customBackgroundColor ?? electronWindow.getBackgroundColor()
            };
            this.electronStore.set('windowstate', options);
        }
        catch (e) {
            console.error('Error while saving window state:', e);
        }
    }
    /**
     * Return a string unique to the current display layout.
     */
    getCurrentScreenLayout() {
        return electron_1.screen.getAllDisplays().map(display => `${display.bounds.x}:${display.bounds.y}:${display.bounds.width}:${display.bounds.height}`).sort().join('-');
    }
    /**
     * Start the NodeJS backend server.
     *
     * @return Running server's port promise.
     */
    async startBackend() {
        // Check if we should run everything as one process.
        const noBackendFork = process.argv.indexOf('--no-cluster') !== -1;
        // Set the electron version for both the dev and the production mode. (https://github.com/eclipse-theia/theia/issues/3254)
        // Otherwise, the forked backend processes will not know that they're serving the electron frontend.
        process.env.THEIA_ELECTRON_VERSION = process.versions.electron;
        if (noBackendFork) {
            process.env[electron_token_1.ElectronSecurityToken] = JSON.stringify(this.electronSecurityToken);
            // The backend server main file is supposed put a promise resolving with the port used by the http(s) server into the global object.
            (0, dynamic_require_1.dynamicRequire)(this.globals.THEIA_BACKEND_MAIN_PATH);
            const address = await backend_global_1.backendGlobal.serverAddress;
            if (!address) {
                throw new Error('The backend server did not start correctly.');
            }
            return address.port;
        }
        else {
            const backendProcess = (0, child_process_1.fork)(this.globals.THEIA_BACKEND_MAIN_PATH, this.processArgv.getProcessArgvWithoutBin(), await this.getForkOptions());
            return new Promise((resolve, reject) => {
                // The backend server main file is also supposed to send the resolved http(s) server port via IPC.
                backendProcess.on('message', (address) => {
                    resolve(address.port);
                });
                backendProcess.on('error', error => {
                    reject(error);
                });
                backendProcess.on('exit', code => {
                    reject(code);
                });
                electron_1.app.on('quit', () => {
                    // Only issue a kill signal if the backend process is running.
                    // eslint-disable-next-line no-null/no-null
                    if (backendProcess.exitCode === null && backendProcess.signalCode === null) {
                        try {
                            // If we forked the process for the clusters, we need to manually terminate it.
                            // See: https://github.com/eclipse-theia/theia/issues/835
                            if (backendProcess.pid) {
                                process.kill(backendProcess.pid);
                            }
                        }
                        catch (error) {
                            // See https://man7.org/linux/man-pages/man2/kill.2.html#ERRORS
                            if (error.code === 'ESRCH') {
                                return;
                            }
                            throw error;
                        }
                    }
                });
            });
        }
    }
    async getForkOptions() {
        return {
            // The backend must be a process group leader on UNIX in order to kill the tree later.
            // See https://nodejs.org/api/child_process.html#child_process_options_detached
            detached: process.platform !== 'win32',
            env: {
                ...process.env,
                [electron_token_1.ElectronSecurityToken]: JSON.stringify(this.electronSecurityToken),
            },
        };
    }
    async attachElectronSecurityToken(port) {
        await this.electronSecurityTokenService.setElectronSecurityTokenCookie(`http://localhost:${port}`);
    }
    hookApplicationEvents() {
        electron_1.app.on('will-quit', this.onWillQuit.bind(this));
        electron_1.app.on('second-instance', this.onSecondInstance.bind(this));
        electron_1.app.on('window-all-closed', this.onWindowAllClosed.bind(this));
        electron_1.app.on('web-contents-created', this.onWebContentsCreated.bind(this));
        if (common_1.isWindows) {
            const args = this.processArgv.isBundledElectronApp ? [] : [electron_1.app.getAppPath()];
            args.push('--open-url');
            electron_1.app.setAsDefaultProtocolClient(this.config.electron.uriScheme, process.execPath, args);
        }
        else {
            electron_1.app.on('open-url', (evt, url) => {
                this.openUrl(url);
            });
        }
    }
    onWillQuit(event) {
        this.stopContributions();
    }
    async onSecondInstance(event, _, cwd, originalArgv) {
        // the second instance passes it's original argument array as the fourth argument to this method
        // The `argv` second parameter is not usable for us since it is mangled by electron before being passed here
        if (originalArgv.includes('--open-url')) {
            this.openUrl(originalArgv[originalArgv.length - 1]);
        }
        else {
            const argv = this.processArgv.getProcessArgvWithoutBin(originalArgv);
            createYargs(argv, cwd)
                .help(false)
                .command('$0 [file]', false, cmd => cmd
                .positional('file', { type: 'string' }), async (args) => {
                const launchArgs = launch_argv_parser_1.LaunchArgvParser.parse(argv);
                await this.handleMainCommand({
                    file: args.file,
                    cwd: cwd,
                    secondInstance: true,
                    launchArgs,
                    claimed: await this.isWindowClaimed(launchArgs)
                });
            }).parse();
        }
    }
    onWebContentsCreated(event, webContents) {
        // Block any in-page navigation except loading the secondary window contents
        webContents.on('will-navigate', evt => {
            if (new uri_1.default(evt.url).path.fsPath() !== new common_1.Path(this.globals.THEIA_SECONDARY_WINDOW_HTML_PATH).fsPath()) {
                evt.preventDefault();
            }
        });
        webContents.setWindowOpenHandler(details => {
            // if it's a secondary window, allow it to open
            if (new uri_1.default(details.url).path.fsPath() === new common_1.Path(this.globals.THEIA_SECONDARY_WINDOW_HTML_PATH).fsPath()) {
                const defaultOptions = this.getDefaultOptions();
                const options = {
                    ...this.getDefaultTheiaSecondaryWindowBounds(),
                    // We always need the native window frame for now because the secondary window does not have Theia's title bar by default.
                    // In 'custom' title bar mode this would leave the window without any window controls (close, min, max)
                    // TODO set to this.useNativeWindowFrame when secondary windows support a custom title bar.
                    frame: true,
                    minWidth: defaultOptions.minWidth,
                    minHeight: defaultOptions.minHeight,
                    webPreferences: {
                        enableDeprecatedPaste: defaultOptions.webPreferences?.enableDeprecatedPaste
                    }
                };
                if (!this.useNativeWindowFrame) {
                    // If the main window does not have a native window frame, do not show  an icon in the secondary window's native title bar.
                    // The data url is a 1x1 transparent png
                    options.icon = electron_1.nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12P4DwQACfsD/WMmxY8AAAAASUVORK5CYII=');
                }
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: options,
                };
            }
            else {
                const uri = new uri_1.default(details.url);
                let okToOpen = uri.scheme === 'https' || uri.scheme === 'http';
                if (!okToOpen) {
                    const button = electron_1.dialog.showMessageBoxSync(electron_1.BrowserWindow.fromWebContents(webContents), {
                        message: `Open link\n\n${details.url}\n\nin the system handler?`,
                        type: 'question',
                        title: 'Open Link',
                        buttons: ['OK', 'Cancel'],
                        defaultId: 1,
                        cancelId: 1
                    });
                    okToOpen = button === 0;
                }
                if (okToOpen) {
                    electron_1.shell.openExternal(details.url, {});
                }
                return { action: 'deny' };
            }
        });
    }
    onWindowAllClosed(event) {
        if (!this.restarting) {
            this.requestStop();
        }
    }
    async restart(webContents) {
        this.restarting = true;
        const wrapper = this.windows.get(webContents.id);
        if (wrapper) {
            const listener = wrapper.onDidClose(async () => {
                listener.dispose();
                await this.handleMainCommand({
                    secondInstance: false,
                    cwd: process.cwd()
                });
                this.restarting = false;
            });
            // If close failed or was cancelled on this occasion, don't keep listening for it.
            if (!await wrapper.close(frontend_application_state_1.StopReason.Restart)) {
                listener.dispose();
            }
        }
    }
    async startContributions() {
        const promises = [];
        for (const contribution of this.contributions.getContributions()) {
            const onStart = contribution.onStart;
            if (onStart) {
                promises.push(this.stopwatch.startAsync(`${contribution.constructor.name}.onStart`, `${contribution.constructor.name}.onStart`, () => onStart.call(contribution, this), { thresholdMillis: ELECTRON_TIMER_WARNING_THRESHOLD }));
            }
        }
        await Promise.all(promises);
    }
    stopContributions() {
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.onStop) {
                contribution.onStop(this);
            }
        }
    }
};
exports.ElectronMainApplication = ElectronMainApplication;
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(exports.ElectronMainApplicationContribution),
    tslib_1.__metadata("design:type", Object)
], ElectronMainApplication.prototype, "contributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(electron_main_constants_1.ElectronMainApplicationGlobals),
    tslib_1.__metadata("design:type", Object)
], ElectronMainApplication.prototype, "globals", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ElectronMainProcessArgv),
    tslib_1.__metadata("design:type", ElectronMainProcessArgv)
], ElectronMainApplication.prototype, "processArgv", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(electron_security_token_service_1.ElectronSecurityTokenService),
    tslib_1.__metadata("design:type", electron_security_token_service_1.ElectronSecurityTokenService)
], ElectronMainApplication.prototype, "electronSecurityTokenService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(electron_token_1.ElectronSecurityToken),
    tslib_1.__metadata("design:type", Object)
], ElectronMainApplication.prototype, "electronSecurityToken", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(theia_electron_window_1.TheiaElectronWindowFactory),
    tslib_1.__metadata("design:type", Function)
], ElectronMainApplication.prototype, "windowFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(performance_1.Stopwatch),
    tslib_1.__metadata("design:type", performance_1.Stopwatch)
], ElectronMainApplication.prototype, "stopwatch", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(launch_args_store_1.LaunchArgsStore),
    tslib_1.__metadata("design:type", launch_args_store_1.LaunchArgsStore)
], ElectronMainApplication.prototype, "launchArgsStore", void 0);
exports.ElectronMainApplication = ElectronMainApplication = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ElectronMainApplication);
//# sourceMappingURL=electron-main-application.js.map