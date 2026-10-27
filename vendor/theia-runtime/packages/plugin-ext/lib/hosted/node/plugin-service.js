"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostedPluginServerImpl = exports.BackendPluginHostableFilter = void 0;
const tslib_1 = require("tslib");
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
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_protocol_1 = require("../../common/plugin-protocol");
const hosted_plugin_1 = require("./hosted-plugin");
const core_1 = require("@theia/core");
const plugin_ext_api_contribution_1 = require("../../common/plugin-ext-api-contribution");
const plugin_deployer_handler_impl_1 = require("./plugin-deployer-handler-impl");
const plugin_deployer_impl_1 = require("../../main/node/plugin-deployer-impl");
const hosted_plugin_localization_service_1 = require("./hosted-plugin-localization-service");
const plugin_uninstallation_manager_1 = require("../../main/node/plugin-uninstallation-manager");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
exports.BackendPluginHostableFilter = Symbol('BackendPluginHostableFilter');
/**
 * This class implements the per-front-end services for plugin management and communication
 */
let HostedPluginServerImpl = class HostedPluginServerImpl {
    constructor(hostedPlugin) {
        this.hostedPlugin = hostedPlugin;
        this.toDispose = new core_1.DisposableCollection();
        this.pluginVersions = new Map();
        this.initialized = new promise_util_1.Deferred();
    }
    init() {
        if (!this.backendPluginHostableFilter) {
            this.backendPluginHostableFilter = () => true;
        }
        this.uninstalledPlugins = new Set(this.uninstallationManager.getUninstalledPluginIds());
        const asyncInit = async () => {
            this.disabledPlugins = new Set(await this.uninstallationManager.getDisabledPluginIds());
            this.toDispose.pushAll([
                this.pluginDeployer.onDidDeploy(() => this.client?.onDidDeploy()),
                this.uninstallationManager.onDidChangeUninstalledPlugins(currentUninstalled => {
                    if (this.uninstalledPlugins) {
                        const uninstalled = new Set(currentUninstalled);
                        for (const previouslyUninstalled of this.uninstalledPlugins) {
                            if (!uninstalled.has(previouslyUninstalled)) {
                                this.uninstalledPlugins.delete(previouslyUninstalled);
                            }
                        }
                    }
                    this.client?.onDidDeploy();
                }),
                this.uninstallationManager.onDidChangeDisabledPlugins(currentlyDisabled => {
                    if (this.disabledPlugins) {
                        const disabled = new Set(currentlyDisabled);
                        for (const previouslyUninstalled of this.disabledPlugins) {
                            if (!disabled.has(previouslyUninstalled)) {
                                this.disabledPlugins.delete(previouslyUninstalled);
                            }
                        }
                    }
                    this.client?.onDidDeploy();
                }),
                core_1.Disposable.create(() => this.hostedPlugin.clientClosed()),
            ]);
            this.initialized.resolve();
        };
        asyncInit();
    }
    getServerName() {
        return 'hosted-plugin';
    }
    dispose() {
        this.toDispose.dispose();
    }
    setClient(client) {
        this.client = client;
        this.hostedPlugin.setClient(client);
    }
    async getDeployedPluginIds() {
        return this.getInstalledPluginIds()
            .then(ids => ids.filter(candidate => this.isInstalledPlugin(candidate) && !this.disabledPlugins.has(plugin_protocol_1.PluginIdentifiers.toUnversioned(candidate))));
    }
    async getInstalledPluginIds() {
        await this.initialized.promise;
        const backendPlugins = (await this.deployerHandler.getDeployedBackendPlugins())
            .filter(this.backendPluginHostableFilter);
        if (backendPlugins.length > 0) {
            this.hostedPlugin.runPluginServer(this.getServerName());
        }
        const plugins = new Set();
        const addIds = (identifiers) => identifiers
            .then(ids => ids.forEach(id => this.isInstalledPlugin(id) && plugins.add(id)));
        await Promise.all([
            addIds(this.deployerHandler.getDeployedFrontendPluginIds()),
            addIds(this.deployerHandler.getDeployedBackendPluginIds()),
        ]);
        return Array.from(plugins);
    }
    /**
     * Ensures that the plugin was not uninstalled when this session was started
     * and that it matches the first version of the given plugin seen by this session.
     *
     * The deployment system may have multiple versions of the same plugin available, but
     * a single session should only ever activate one of them.
     */
    isInstalledPlugin(identifier) {
        const versionAndId = plugin_protocol_1.PluginIdentifiers.idAndVersionFromVersionedId(identifier);
        if (!versionAndId) {
            return false;
        }
        const knownVersion = this.pluginVersions.get(versionAndId.id);
        if (knownVersion !== undefined && knownVersion !== versionAndId.version) {
            return false;
        }
        if (this.uninstalledPlugins.has(identifier)) {
            return false;
        }
        if (knownVersion === undefined) {
            this.pluginVersions.set(versionAndId.id, versionAndId.version);
        }
        return true;
    }
    getUninstalledPluginIds() {
        return Promise.resolve(this.uninstallationManager.getUninstalledPluginIds());
    }
    getDisabledPluginIds() {
        return Promise.resolve(this.uninstallationManager.getDisabledPluginIds());
    }
    async getDeployedPlugins(pluginIds) {
        if (!pluginIds.length) {
            return [];
        }
        const plugins = [];
        for (const versionedId of pluginIds) {
            const plugin = this.deployerHandler.getDeployedPlugin(versionedId);
            if (plugin) {
                plugins.push(plugin);
            }
        }
        return Promise.all(plugins.map(plugin => this.localizationService.localizePlugin(plugin)));
    }
    onMessage(pluginHostId, message) {
        this.hostedPlugin.onMessage(pluginHostId, message);
        return Promise.resolve();
    }
    getExtPluginAPI() {
        return Promise.resolve(this.extPluginAPIContributions.getContributions().map(p => p.provideApi()));
    }
};
exports.HostedPluginServerImpl = HostedPluginServerImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext:HostedPluginServerImpl'),
    tslib_1.__metadata("design:type", Object)
], HostedPluginServerImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_deployer_handler_impl_1.PluginDeployerHandlerImpl),
    tslib_1.__metadata("design:type", plugin_deployer_handler_impl_1.PluginDeployerHandlerImpl)
], HostedPluginServerImpl.prototype, "deployerHandler", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_protocol_1.PluginDeployer),
    tslib_1.__metadata("design:type", plugin_deployer_impl_1.PluginDeployerImpl)
], HostedPluginServerImpl.prototype, "pluginDeployer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(hosted_plugin_localization_service_1.HostedPluginLocalizationService),
    tslib_1.__metadata("design:type", hosted_plugin_localization_service_1.HostedPluginLocalizationService)
], HostedPluginServerImpl.prototype, "localizationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(Symbol.for(plugin_ext_api_contribution_1.ExtPluginApiProvider)),
    tslib_1.__metadata("design:type", Object)
], HostedPluginServerImpl.prototype, "extPluginAPIContributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_uninstallation_manager_1.PluginUninstallationManager),
    tslib_1.__metadata("design:type", plugin_uninstallation_manager_1.PluginUninstallationManager)
], HostedPluginServerImpl.prototype, "uninstallationManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.BackendPluginHostableFilter),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Function)
], HostedPluginServerImpl.prototype, "backendPluginHostableFilter", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], HostedPluginServerImpl.prototype, "init", null);
exports.HostedPluginServerImpl = HostedPluginServerImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(hosted_plugin_1.HostedPluginSupport)),
    tslib_1.__metadata("design:paramtypes", [hosted_plugin_1.HostedPluginSupport])
], HostedPluginServerImpl);
//# sourceMappingURL=plugin-service.js.map