"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
exports.PluginServerImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_deployer_impl_1 = require("./plugin-deployer-impl");
const plugins_key_value_storage_1 = require("./plugins-key-value-storage");
const plugin_protocol_1 = require("../../common/plugin-protocol");
const plugin_uninstallation_manager_1 = require("./plugin-uninstallation-manager");
let PluginServerImpl = class PluginServerImpl {
    async install(pluginEntry, arg2, options) {
        const type = typeof arg2 === 'number' ? arg2 : undefined;
        const successfulDeployments = await this.doInstall({
            id: pluginEntry,
            type: type ?? plugin_protocol_1.PluginType.User
        }, options);
        if (successfulDeployments === 0) {
            const optionText = options ? ` and options ${JSON.stringify(options)} ` : ' ';
            throw new Error(`Deployment of extension with ID ${pluginEntry}${optionText}failed.`);
        }
    }
    doInstall(pluginEntry, options) {
        return this.pluginDeployer.deploy(pluginEntry, options);
    }
    getInstalledPlugins() {
        return Promise.resolve(this.pluginDeployerHandler.getDeployedPluginIds());
    }
    getUninstalledPlugins() {
        return Promise.resolve(this.uninstallationManager.getUninstalledPluginIds());
    }
    getDisabledPlugins() {
        return Promise.resolve(this.uninstallationManager.getDisabledPluginIds());
    }
    uninstall(pluginId) {
        return this.pluginDeployer.uninstall(pluginId);
    }
    enablePlugin(pluginId) {
        return this.pluginDeployer.enablePlugin(pluginId);
    }
    disablePlugin(pluginId) {
        return this.pluginDeployer.disablePlugin(pluginId);
    }
    setStorageValue(key, value, kind) {
        return this.pluginsKeyValueStorage.set(key, value, kind);
    }
    getStorageValue(key, kind) {
        return this.pluginsKeyValueStorage.get(key, kind);
    }
    getAllStorageValues(kind) {
        return this.pluginsKeyValueStorage.getAll(kind);
    }
};
exports.PluginServerImpl = PluginServerImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_protocol_1.PluginDeployer),
    tslib_1.__metadata("design:type", plugin_deployer_impl_1.PluginDeployerImpl)
], PluginServerImpl.prototype, "pluginDeployer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_protocol_1.PluginDeployerHandler),
    tslib_1.__metadata("design:type", Object)
], PluginServerImpl.prototype, "pluginDeployerHandler", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugins_key_value_storage_1.PluginsKeyValueStorage),
    tslib_1.__metadata("design:type", plugins_key_value_storage_1.PluginsKeyValueStorage)
], PluginServerImpl.prototype, "pluginsKeyValueStorage", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_uninstallation_manager_1.PluginUninstallationManager),
    tslib_1.__metadata("design:type", plugin_uninstallation_manager_1.PluginUninstallationManager)
], PluginServerImpl.prototype, "uninstallationManager", void 0);
exports.PluginServerImpl = PluginServerImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginServerImpl);
//# sourceMappingURL=plugin-server-impl.js.map