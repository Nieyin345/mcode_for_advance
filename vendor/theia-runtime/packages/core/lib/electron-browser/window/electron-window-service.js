"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.ElectronWindowService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const default_window_service_1 = require("../../browser/window/default-window-service");
const electron_main_window_service_1 = require("../../electron-common/electron-main-window-service");
const electron_window_preferences_1 = require("../../electron-common/electron-window-preferences");
const connection_management_1 = require("../../common/messaging/connection-management");
const frontend_id_provider_1 = require("../../browser/messaging/frontend-id-provider");
const listener_1 = require("../../common/listener");
let ElectronWindowService = class ElectronWindowService extends default_window_service_1.DefaultWindowService {
    constructor() {
        super(...arguments);
        /**
         * Lock to prevent multiple parallel executions of the `beforeunload` listener.
         */
        this.isUnloading = false;
        /**
         * Close the window right away when `true`, else check if we can unload.
         */
        this.closeOnUnload = false;
        this.onWillShutDownListeners = new listener_1.ListenerList();
        this.onWillShutDown = this.onWillShutDownListeners.registration;
    }
    openNewWindow(url, { external } = {}) {
        this.delegate.openNewWindow(url, { external });
        return undefined;
    }
    async openNewDefaultWindow(params) {
        return this.delegate.openNewDefaultWindow(params?.search);
    }
    closeWindow(windowId) {
        this.delegate.closeWindow(windowId);
    }
    focus() {
        window.electronTheiaCore.focusWindow();
    }
    init() {
        // Update the default zoom level on startup when the preferences event is fired.
        this.electronWindowPreferences.onPreferenceChanged(e => {
            if (e.preferenceName === electron_window_preferences_1.PREF_WINDOW_ZOOM_LEVEL) {
                this.updateWindowZoomLevel();
            }
        });
        window.electronTheiaCore.onAboutToClose(() => {
            this.connectionCloseService.markForClose(this.frontendIdProvider.getId());
        });
    }
    registerUnloadListeners() {
        window.electronTheiaCore.setCloseRequestHandler(async (reason) => {
            const willShutDown = await this.isSafeToShutDown(reason);
            if (willShutDown) {
                await listener_1.Listener.awaitAll(undefined, this.onWillShutDownListeners);
            }
            return willShutDown;
        });
        // Intentionally not calling `super`: in Electron the close request handler above takes the role of
        // `beforeunload`, and there is no back/forward cache, so only the `pagehide` listener is shared.
        this.registerPageHideListener();
    }
    /**
     * Updates the window zoom level based on the preference value.
     */
    async updateWindowZoomLevel() {
        const preferredZoomLevel = this.electronWindowPreferences[electron_window_preferences_1.PREF_WINDOW_ZOOM_LEVEL];
        if (await window.electronTheiaCore.getZoomLevel() !== preferredZoomLevel) {
            window.electronTheiaCore.setZoomLevel(preferredZoomLevel);
        }
    }
    reload(params) {
        if (params) {
            const newLocation = new URL(location.href);
            if (params.search) {
                const query = Object.entries(params.search).map(([name, value]) => `${name}=${value}`).join('&');
                newLocation.search = query;
            }
            if (params.hash) {
                newLocation.hash = '#' + params.hash;
            }
            window.electronTheiaCore.requestReload(newLocation.toString());
        }
        else {
            window.electronTheiaCore.requestReload();
        }
    }
};
exports.ElectronWindowService = ElectronWindowService;
tslib_1.__decorate([
    (0, inversify_1.inject)(frontend_id_provider_1.FrontendIdProvider),
    tslib_1.__metadata("design:type", Object)
], ElectronWindowService.prototype, "frontendIdProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(electron_main_window_service_1.ElectronMainWindowService),
    tslib_1.__metadata("design:type", Object)
], ElectronWindowService.prototype, "delegate", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(electron_window_preferences_1.ElectronWindowPreferences),
    tslib_1.__metadata("design:type", Object)
], ElectronWindowService.prototype, "electronWindowPreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(connection_management_1.ConnectionCloseService),
    tslib_1.__metadata("design:type", Object)
], ElectronWindowService.prototype, "connectionCloseService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ElectronWindowService.prototype, "init", null);
exports.ElectronWindowService = ElectronWindowService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ElectronWindowService);
//# sourceMappingURL=electron-window-service.js.map