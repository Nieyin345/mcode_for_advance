"use strict";
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
var PluginUninstallationManager_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginUninstallationManager = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../../common");
const node_1 = require("@theia/core/lib/node");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
let PluginUninstallationManager = class PluginUninstallationManager {
    constructor() {
        this.onDidChangeUninstalledPluginsEmitter = new core_1.Emitter();
        this.onDidChangeUninstalledPlugins = this.onDidChangeUninstalledPluginsEmitter.event;
        this.onDidChangeDisabledPluginsEmitter = new core_1.Emitter();
        this.onDidChangeDisabledPlugins = this.onDidChangeDisabledPluginsEmitter.event;
        this.uninstalledPlugins = new Set();
        this.disabledPlugins = new Set();
        this.initialized = new promise_util_1.Deferred();
    }
    static { PluginUninstallationManager_1 = this; }
    static { this.DISABLED_PLUGINS = 'installedPlugins.disabledPlugins'; }
    init() {
        this.load().then(() => this.initialized.resolve());
    }
    async load() {
        try {
            const disabled = JSON.parse(await this.settingService.get(PluginUninstallationManager_1.DISABLED_PLUGINS) || '[]');
            disabled.forEach(id => this.disabledPlugins.add(common_1.PluginIdentifiers.toUnversioned(id)));
        }
        catch (e) {
            // settings may be corrupt; just carry on
            this.logger.warn(e);
        }
    }
    async save() {
        await this.settingService.set(PluginUninstallationManager_1.DISABLED_PLUGINS, JSON.stringify(await this.getDisabledPluginIds()));
    }
    async markAsUninstalled(...pluginIds) {
        let didChange = false;
        for (const id of pluginIds) {
            if (!this.uninstalledPlugins.has(id)) {
                didChange = true;
                this.uninstalledPlugins.add(id);
            }
        }
        if (didChange) {
            this.onDidChangeUninstalledPluginsEmitter.fire(this.getUninstalledPluginIds());
        }
        this.markAsEnabled(...pluginIds);
        return didChange;
    }
    async markAsInstalled(...pluginIds) {
        let didChange = false;
        for (const id of pluginIds) {
            didChange = this.uninstalledPlugins.delete(id) || didChange;
        }
        if (didChange) {
            this.onDidChangeUninstalledPluginsEmitter.fire(this.getUninstalledPluginIds());
        }
        return didChange;
    }
    isUninstalled(pluginId) {
        return this.uninstalledPlugins.has(pluginId);
    }
    getUninstalledPluginIds() {
        return [...this.uninstalledPlugins];
    }
    async markAsDisabled(...pluginIds) {
        await this.initialized.promise;
        let didChange = false;
        for (const id of pluginIds) {
            if (!this.disabledPlugins.has(id)) {
                this.disabledPlugins.add(id);
                didChange = true;
            }
        }
        if (didChange) {
            await this.save();
            this.onDidChangeDisabledPluginsEmitter.fire([...this.disabledPlugins]);
        }
        return didChange;
    }
    async markAsEnabled(...pluginIds) {
        await this.initialized.promise;
        let didChange = false;
        for (const id of pluginIds) {
            didChange = this.disabledPlugins.delete(id) || didChange;
        }
        if (didChange) {
            await this.save();
            this.onDidChangeDisabledPluginsEmitter.fire([...this.disabledPlugins]);
        }
        return didChange;
    }
    async isDisabled(pluginId) {
        await this.initialized.promise;
        return this.disabledPlugins.has(pluginId);
    }
    async getDisabledPluginIds() {
        await this.initialized.promise;
        return [...this.disabledPlugins];
    }
};
exports.PluginUninstallationManager = PluginUninstallationManager;
tslib_1.__decorate([
    (0, inversify_1.inject)(node_1.SettingService),
    tslib_1.__metadata("design:type", Object)
], PluginUninstallationManager.prototype, "settingService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:PluginUninstallationManager'),
    tslib_1.__metadata("design:type", Object)
], PluginUninstallationManager.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PluginUninstallationManager.prototype, "init", null);
exports.PluginUninstallationManager = PluginUninstallationManager = PluginUninstallationManager_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginUninstallationManager);
//# sourceMappingURL=plugin-uninstallation-manager.js.map