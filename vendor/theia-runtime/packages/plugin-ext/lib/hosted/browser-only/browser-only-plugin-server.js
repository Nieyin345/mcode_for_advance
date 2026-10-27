"use strict";
// *****************************************************************************
// Copyright (C) 2026 Robert Jandow
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
exports.BrowserOnlyPluginServer = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const async_mutex_1 = require("async-mutex");
const core_1 = require("@theia/core");
const storage_service_1 = require("@theia/core/lib/browser/storage-service");
const plugin_paths_protocol_1 = require("../../main/common/plugin-paths-protocol");
const GLOBAL_STORAGE_KEY = 'plugin-storage:global';
const WORKSPACE_STORAGE_KEY_PREFIX = 'plugin-storage:workspace:';
const LOCK_NAME_PREFIX = 'theia:plugin-storage:';
/**
 * Plugins of a browser-only application are deployed at build time, so they can't be installed,
 * uninstalled, enabled or disabled at runtime. The queries just report an empty result instead
 * of failing, so callers like the plugin view still have something to render.
 *
 * The plugin key-value storage backing `ExtensionContext.globalState` and
 * `ExtensionContext.workspaceState` lives in the browser's local storage.
 */
let BrowserOnlyPluginServer = class BrowserOnlyPluginServer {
    constructor() {
        /** Fallback for {@link withStoreLock} when the Web Locks API is unavailable. */
        this.localLock = new async_mutex_1.Mutex();
        this.missingLocksWarned = false;
    }
    async install(pluginEntry, type, options) {
        throw new Error(core_1.nls.localize('theia/plugin-ext/browserOnlyInstallUnsupported', 'Installing plugins is not supported in a browser-only application.'));
    }
    async uninstall(pluginId) {
        throw new Error(core_1.nls.localize('theia/plugin-ext/browserOnlyUninstallUnsupported', 'Uninstalling plugins is not supported in a browser-only application.'));
    }
    async enablePlugin(pluginId) {
        throw new Error(core_1.nls.localize('theia/plugin-ext/browserOnlyEnableUnsupported', 'Enabling plugins is not supported in a browser-only application.'));
    }
    async disablePlugin(pluginId) {
        throw new Error(core_1.nls.localize('theia/plugin-ext/browserOnlyDisableUnsupported', 'Disabling plugins is not supported in a browser-only application.'));
    }
    async getInstalledPlugins() {
        return [];
    }
    async getUninstalledPlugins() {
        return [];
    }
    async getDisabledPlugins() {
        return [];
    }
    async setStorageValue(key, value, kind) {
        const storeKey = await this.getStoreKey(kind);
        if (!storeKey) {
            this.logger.warn('Cannot save plugin data: no opened workspace.');
            return false;
        }
        // the browser storage is shared with this application's other tabs, each running its own
        // plugin host, so the read and write below need to be atomic - otherwise a concurrent
        // update from another tab could land in between and get overwritten by this one
        await this.withStoreLock(storeKey, async () => {
            const store = await this.getStore(storeKey);
            if (value === undefined || Object.keys(value).length === 0) {
                delete store[key];
            }
            else {
                store[key] = value;
            }
            await this.storageService.setData(storeKey, store);
        });
        return true;
    }
    async getStorageValue(key, kind) {
        return (await this.getAllStorageValues(kind))[key] ?? {};
    }
    async getAllStorageValues(kind) {
        const storeKey = await this.getStoreKey(kind);
        return storeKey ? this.getStore(storeKey) : {};
    }
    getStore(storeKey) {
        return this.storageService.getData(storeKey, {});
    }
    /**
     * Runs `task` while holding the cross-tab lock for `storeKey`, via the Web Locks API, so a
     * concurrent {@link setStorageValue} on this or another tab can't interleave with it.
     */
    withStoreLock(storeKey, task) {
        const locks = this.getWebLocks();
        if (locks) {
            return this.requestLock(locks, `${LOCK_NAME_PREFIX}${storeKey}`, task);
        }
        // no Web Locks API (insecure context, older browser): fall back to serializing writes
        // within this tab. A write from another tab can still race and get lost.
        if (!this.missingLocksWarned) {
            this.missingLocksWarned = true;
            this.logger.warn('Web Locks API unavailable: plugin storage updates from different tabs may race.');
        }
        return this.localLock.runExclusive(task);
    }
    /** The Web Locks API of this browsing context, or `undefined` in an insecure context or an older browser. */
    getWebLocks() {
        return typeof navigator === 'object' ? navigator.locks : undefined;
    }
    /**
     * Requests `name` from `locks` and runs `callback` once granted, same as `LockManager.request()`.
     *
     * `LockGrantedCallback` is typed as `(lock: Lock | null) => T`, which doesn't account for an
     * async or never-settling callback even though the API itself supports and awaits one, hence
     * the cast. Kept as its own method so a subclass or test can swap the lock implementation.
     */
    requestLock(locks, name, callback) {
        return locks.request(name, callback);
    }
    /**
     * The browser storage key holding the given kind of values, or `undefined` if there's
     * nowhere to keep them - e.g. workspace state while no workspace is open.
     */
    async getStoreKey(kind) {
        if (!kind) {
            return GLOBAL_STORAGE_KEY;
        }
        // derived from the storage path so workspace state follows `ExtensionContext.storageUri`
        const storagePath = await this.pluginPathsService.getHostStoragePath(kind.workspace, kind.roots);
        return storagePath && `${WORKSPACE_STORAGE_KEY_PREFIX}${storagePath}`;
    }
};
exports.BrowserOnlyPluginServer = BrowserOnlyPluginServer;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:BrowserOnlyPluginServer'),
    tslib_1.__metadata("design:type", Object)
], BrowserOnlyPluginServer.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(storage_service_1.LocalStorageService),
    tslib_1.__metadata("design:type", Object)
], BrowserOnlyPluginServer.prototype, "storageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_paths_protocol_1.PluginPathsService),
    tslib_1.__metadata("design:type", Object)
], BrowserOnlyPluginServer.prototype, "pluginPathsService", void 0);
exports.BrowserOnlyPluginServer = BrowserOnlyPluginServer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserOnlyPluginServer);
//# sourceMappingURL=browser-only-plugin-server.js.map