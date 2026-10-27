"use strict";
// *****************************************************************************
// Copyright (C) 2023 STMicroelectronics and others.
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
exports.TheiaRendererAPI = exports.TheiaMainApi = void 0;
const tslib_1 = require("tslib");
const electron_1 = require("@theia/electron/shared/electron");
const nativeKeymap = require("@theia/electron/shared/native-keymap");
const inversify_1 = require("inversify");
const electron_token_1 = require("../electron-common/electron-token");
const electron_api_1 = require("../electron-common/electron-api");
const common_1 = require("../common");
const node_1 = require("../node");
const event_utils_1 = require("./event-utils");
const path = require("node:path");
let TheiaMainApi = class TheiaMainApi {
    constructor() {
        this.openPopups = new Map();
    }
    onStart(application) {
        electron_1.ipcMain.on(electron_api_1.CHANNEL_WC_METADATA, event => {
            // Answered synchronously, so the window has its metadata — including the parsed options
            // of a forwarded launch — before any frontend code runs. The window is identified by the
            // IPC sender, so it can only ever read its own.
            event.returnValue = {
                webcontentId: event.sender.id.toString(),
                launchArgs: application.getLaunchArgs(event.sender.id)
            };
        });
        // electron security token
        electron_1.ipcMain.on(electron_api_1.CHANNEL_GET_SECURITY_TOKEN, event => {
            event.returnValue = this.electronSecurityToken.value;
        });
        electron_1.ipcMain.handle(electron_api_1.CHANNEL_ATTACH_SECURITY_TOKEN, (event, endpoint) => electron_1.session.defaultSession.cookies.set({
            url: endpoint,
            name: electron_token_1.ElectronSecurityToken,
            value: JSON.stringify(this.electronSecurityToken),
            httpOnly: true,
            sameSite: 'no_restriction'
        }));
        // application menu
        electron_1.ipcMain.on(electron_api_1.CHANNEL_SET_MENU, (event, menuId, menu) => {
            let electronMenu;
            if (menu) {
                electronMenu = electron_1.Menu.buildFromTemplate(this.fromMenuDto(event.sender, menuId, menu));
            }
            else {
                // eslint-disable-next-line no-null/no-null
                electronMenu = null;
            }
            if (common_1.isOSX) {
                electron_1.Menu.setApplicationMenu(electronMenu);
            }
            else {
                electron_1.BrowserWindow.fromWebContents(event.sender)?.setMenu(electronMenu);
            }
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_SET_MENU_BAR_VISIBLE, (event, visible, windowName) => {
            let electronWindow;
            if (windowName) {
                electronWindow = electron_1.BrowserWindow.getAllWindows().find(win => win.webContents.mainFrame.name === windowName);
            }
            else {
                electronWindow = electron_1.BrowserWindow.fromWebContents(event.sender);
            }
            if (electronWindow) {
                electronWindow.setMenuBarVisibility(visible);
            }
            else {
                console.warn(`There is no known secondary window '${windowName}'. Thus, the menu bar could not be made visible.`);
            }
        });
        // popup menu
        electron_1.ipcMain.handle(electron_api_1.CHANNEL_OPEN_POPUP, (event, menuId, menu, x, y, windowName) => {
            const zoom = event.sender.getZoomFactor();
            // TODO: Remove the offset once Electron fixes https://github.com/electron/electron/issues/31641
            const offset = process.platform === 'win32' ? 0 : 2;
            // x and y values must be Ints or else there is a conversion error
            x = Math.round(x * zoom) + offset;
            y = Math.round(y * zoom) + offset;
            const popup = electron_1.Menu.buildFromTemplate(this.fromMenuDto(event.sender, menuId, menu));
            this.openPopups.set(menuId, popup);
            let electronWindow;
            if (windowName) {
                electronWindow = electron_1.BrowserWindow.getAllWindows().find(win => win.webContents.mainFrame.name === windowName);
            }
            else {
                electronWindow = electron_1.BrowserWindow.fromWebContents(event.sender) || undefined;
            }
            popup.popup({
                window: electronWindow,
                x,
                y,
                callback: () => {
                    this.openPopups.delete(menuId);
                    event.sender.send(electron_api_1.CHANNEL_ON_CLOSE_POPUP, menuId);
                }
            });
        });
        electron_1.ipcMain.handle(electron_api_1.CHANNEL_CLOSE_POPUP, (event, handle) => {
            if (this.openPopups.has(handle)) {
                this.openPopups.get(handle).closePopup();
            }
        });
        // focus windows for secondary window support
        electron_1.ipcMain.on(electron_api_1.CHANNEL_FOCUS_WINDOW, (event, windowName) => {
            const electronWindow = windowName
                ? electron_1.BrowserWindow.getAllWindows().find(win => win.webContents.mainFrame.name === windowName)
                : electron_1.BrowserWindow.fromWebContents(event.sender);
            if (electronWindow) {
                if (electronWindow.isMinimized()) {
                    electronWindow.restore();
                }
                electronWindow.focus();
            }
            else {
                console.warn(`There is no known secondary window '${windowName}'. Thus, the window could not be focussed.`);
            }
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_SHOW_ITEM_IN_FOLDER, (event, fsPath) => {
            electron_1.shell.showItemInFolder(fsPath);
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_OPEN_WITH_SYSTEM_APP, (event, uri) => {
            electron_1.shell.openExternal(uri);
        });
        electron_1.ipcMain.handle(electron_api_1.CHANNEL_GET_TITLE_STYLE_AT_STARTUP, event => application.getTitleBarStyleAtStartup(event.sender));
        electron_1.ipcMain.on(electron_api_1.CHANNEL_SET_TITLE_STYLE, (event, style) => application.setTitleBarStyle(event.sender, style));
        electron_1.ipcMain.on(electron_api_1.CHANNEL_SET_BACKGROUND_COLOR, (event, backgroundColor) => application.setBackgroundColor(event.sender, backgroundColor));
        electron_1.ipcMain.on(electron_api_1.CHANNEL_SET_THEME, (event, theme) => application.setTheme(theme));
        electron_1.ipcMain.on(electron_api_1.CHANNEL_MINIMIZE, event => {
            electron_1.BrowserWindow.fromWebContents(event.sender)?.minimize();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_IS_MAXIMIZED, event => {
            event.returnValue = electron_1.BrowserWindow.fromWebContents(event.sender)?.isMaximized();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_MAXIMIZE, event => {
            electron_1.BrowserWindow.fromWebContents(event.sender)?.maximize();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_UNMAXIMIZE, event => {
            electron_1.BrowserWindow.fromWebContents(event.sender)?.unmaximize();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_CLOSE, event => {
            electron_1.BrowserWindow.fromWebContents(event.sender)?.close();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_RESTART, event => {
            application.restart(event.sender);
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_TOGGLE_DEVTOOLS, event => {
            event.sender.toggleDevTools();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_OPEN_DEVTOOLS_FOR_WINDOW, (event, windowName) => {
            const electronWindow = electron_1.BrowserWindow.getAllWindows().find(win => win.webContents.mainFrame.name === windowName);
            if (electronWindow) {
                electronWindow.webContents.openDevTools();
            }
            else {
                console.warn(`There is no known window '${windowName}'. Thus, the devtools could not be opened.`);
            }
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_SET_ZOOM_LEVEL, (event, zoomLevel, windowName) => {
            let electronWindow;
            if (windowName) {
                electronWindow = electron_1.BrowserWindow.getAllWindows().find(win => win.webContents.mainFrame.name === windowName);
            }
            else {
                electronWindow = electron_1.BrowserWindow.fromWebContents(event.sender);
            }
            if (electronWindow) {
                electronWindow.webContents.setZoomLevel(zoomLevel);
            }
            else {
                console.warn(`There is no known window '${windowName}'. Thus, the zoom level could not be set.`);
            }
        });
        electron_1.ipcMain.handle(electron_api_1.CHANNEL_GET_ZOOM_LEVEL, event => event.sender.getZoomLevel());
        electron_1.ipcMain.on(electron_api_1.CHANNEL_TOGGLE_FULL_SCREEN, event => {
            const win = electron_1.BrowserWindow.fromWebContents(event.sender);
            if (win) {
                win.setFullScreen(!win.isFullScreen());
            }
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_IS_FULL_SCREENABLE, event => {
            event.returnValue = electron_1.BrowserWindow.fromWebContents(event.sender)?.isFullScreenable();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_IS_FULL_SCREEN, event => {
            event.returnValue = electron_1.BrowserWindow.fromWebContents(event.sender)?.isFullScreen();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_READ_CLIPBOARD, event => {
            event.returnValue = electron_1.clipboard.readText();
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_WRITE_CLIPBOARD, (event, text) => {
            electron_1.clipboard.writeText(text);
        });
        nativeKeymap.onDidChangeKeyboardLayout(() => {
            const newLayout = {
                info: nativeKeymap.getCurrentKeyboardLayout(),
                mapping: nativeKeymap.getKeyMap()
            };
            for (const webContent of electron_1.webContents.getAllWebContents()) {
                webContent.send('keyboardLayoutChanged', newLayout);
            }
        });
        electron_1.ipcMain.on(electron_api_1.CHANNEL_UPDATE_RECENT_WORKSPACES, (_event, workspaces, categoryName) => {
            if (!common_1.isWindows) {
                return;
            }
            const jumpListSettings = electron_1.app.getJumpListSettings();
            const isDev = !electron_1.app.isPackaged;
            const appPath = electron_1.app.getAppPath();
            const items = workspaces
                .filter(w => new common_1.URI(w).scheme === 'file')
                .map(workspace => {
                const uri = new common_1.URI(workspace);
                const wspathPretty = uri.path.fsPath();
                const wspath = node_1.FileUri.fsPath(uri);
                const item = {
                    type: 'task',
                    // Windows is picky about the length of some attributes. See: https://github.com/microsoft/vscode/issues/111177#issuecomment-739942612
                    title: uri.path.base.substring(0, 255),
                    description: wspathPretty.substring(0, 255),
                    program: process.execPath,
                    args: isDev ? `"${path.resolve(appPath, 'theia-electron-main.js')}" "${wspath}"` : `"${wspath}"`,
                    iconPath: process.execPath,
                    iconIndex: 0
                };
                // We need to remove items that the user has explicitly removed from the jump list. Otherwise
                // Windows will not show our custom category at all.
                if (jumpListSettings.removedItems.some(removedItem => removedItem.args === item.args)) {
                    return undefined;
                }
                return item;
            })
                .filter(item => !!item);
            const jumpList = [{
                    type: 'custom',
                    name: categoryName || 'Recent Workspaces',
                    items
                }];
            const result = electron_1.app.setJumpList(jumpList);
            if (result !== 'ok') {
                console.warn(`Could not set Jump List with recent workspaces (result = "${result}")`);
            }
        });
    }
    isASCI(accelerator) {
        if (typeof accelerator !== 'string') {
            return false;
        }
        for (let i = 0; i < accelerator.length; i++) {
            if (accelerator.charCodeAt(i) > 127) {
                return false;
            }
        }
        return true;
    }
    fromMenuDto(sender, menuId, menuDto) {
        return menuDto.map(dto => {
            const result = {
                id: dto.id,
                label: dto.label,
                type: dto.type,
                checked: dto.checked,
                enabled: dto.enabled,
                visible: dto.visible,
                role: dto.role,
                accelerator: this.isASCI(dto.accelerator) ? dto.accelerator : undefined
            };
            if (dto.submenu) {
                result.submenu = this.fromMenuDto(sender, menuId, dto.submenu);
            }
            if (dto.handlerId) {
                result.click = () => {
                    sender.send(electron_api_1.CHANNEL_INVOKE_MENU, menuId, dto.handlerId);
                };
            }
            return result;
        });
    }
};
exports.TheiaMainApi = TheiaMainApi;
tslib_1.__decorate([
    (0, inversify_1.inject)(electron_token_1.ElectronSecurityToken),
    tslib_1.__metadata("design:type", Object)
], TheiaMainApi.prototype, "electronSecurityToken", void 0);
exports.TheiaMainApi = TheiaMainApi = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TheiaMainApi);
let nextReplyChannel = 0;
var TheiaRendererAPI;
(function (TheiaRendererAPI) {
    function sendWindowEvent(wc, event) {
        wc.send(electron_api_1.CHANNEL_ON_WINDOW_EVENT, event);
    }
    TheiaRendererAPI.sendWindowEvent = sendWindowEvent;
    function openUrl(wc, url) {
        return new Promise(resolve => {
            const channelNr = nextReplyChannel++;
            const replyChannel = `openUrl${channelNr}`;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const l = (0, event_utils_1.createDisposableListener)(electron_1.ipcMain, replyChannel, (e, args) => {
                l.dispose();
                resolve(args[0]);
            });
            wc.send(electron_api_1.CHANNEL_OPEN_URL, url, replyChannel);
        });
    }
    TheiaRendererAPI.openUrl = openUrl;
    function sendAboutToClose(wc) {
        return new Promise(resolve => {
            const channelNr = nextReplyChannel++;
            const replyChannel = `aboutToClose${channelNr}`;
            const l = (0, event_utils_1.createDisposableListener)(electron_1.ipcMain, replyChannel, e => {
                l.dispose();
                resolve();
            });
            wc.send(electron_api_1.CHANNEL_ABOUT_TO_CLOSE, replyChannel);
        });
    }
    TheiaRendererAPI.sendAboutToClose = sendAboutToClose;
    function requestClose(wc, stopReason) {
        const channelNr = nextReplyChannel++;
        const confirmChannel = `confirm-${channelNr}`;
        const cancelChannel = `cancel-${channelNr}`;
        const disposables = new common_1.DisposableCollection();
        return new Promise(resolve => {
            (0, event_utils_1.createDisposableListener)(electron_1.ipcMain, confirmChannel, e => {
                resolve(true);
            }, disposables);
            (0, event_utils_1.createDisposableListener)(electron_1.ipcMain, cancelChannel, e => {
                resolve(false);
            }, disposables);
            wc.send(electron_api_1.CHANNEL_REQUEST_CLOSE, stopReason, confirmChannel, cancelChannel);
        }).finally(() => disposables.dispose());
    }
    TheiaRendererAPI.requestClose = requestClose;
    function requestSecondaryClose(mainWindow, secondaryWindow) {
        const channelNr = nextReplyChannel++;
        const confirmChannel = `confirm-${channelNr}`;
        const cancelChannel = `cancel-${channelNr}`;
        const disposables = new common_1.DisposableCollection();
        return new Promise(resolve => {
            (0, event_utils_1.createDisposableListener)(electron_1.ipcMain, confirmChannel, e => {
                resolve(true);
            }, disposables);
            (0, event_utils_1.createDisposableListener)(electron_1.ipcMain, cancelChannel, e => {
                resolve(false);
            }, disposables);
            mainWindow.send(electron_api_1.CHANNEL_REQUEST_SECONDARY_CLOSE, secondaryWindow.mainFrame.name, confirmChannel, cancelChannel);
        }).finally(() => disposables.dispose());
    }
    TheiaRendererAPI.requestSecondaryClose = requestSecondaryClose;
    function onRequestReload(wc, handler) {
        return createWindowListener(wc, electron_api_1.CHANNEL_REQUEST_RELOAD, handler);
    }
    TheiaRendererAPI.onRequestReload = onRequestReload;
    function onApplicationStateChanged(wc, handler) {
        return createWindowListener(wc, electron_api_1.CHANNEL_APP_STATE_CHANGED, state => handler(state));
    }
    TheiaRendererAPI.onApplicationStateChanged = onApplicationStateChanged;
    function onIpcData(handler) {
        return (0, event_utils_1.createDisposableListener)(electron_1.ipcMain, electron_api_1.CHANNEL_IPC_CONNECTION, (event, data) => handler(event.sender, data));
    }
    TheiaRendererAPI.onIpcData = onIpcData;
    function sendData(wc, data) {
        wc.send(electron_api_1.CHANNEL_IPC_CONNECTION, data);
    }
    TheiaRendererAPI.sendData = sendData;
    function createWindowListener(wc, channel, handler) {
        return (0, event_utils_1.createDisposableListener)(electron_1.ipcMain, channel, (event, ...args) => {
            if (wc.id === event.sender.id) {
                handler(...args);
            }
        });
    }
})(TheiaRendererAPI || (exports.TheiaRendererAPI = TheiaRendererAPI = {}));
//# sourceMappingURL=electron-api-main.js.map