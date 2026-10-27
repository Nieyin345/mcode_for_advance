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
exports.BrowserOnlyHostedPluginServer = exports.BrowserOnlyPluginOptions = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const constants_1 = require("@theia/plugin-utils/lib/common/constants");
const common_1 = require("../../common");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
exports.BrowserOnlyPluginOptions = Symbol('BrowserOnlyPluginOptions');
/**
 * Serves the plugins statically deployed into the frontend bundle. There's no backend in a
 * browser-only application, so nothing can be deployed or undeployed at runtime.
 */
let BrowserOnlyHostedPluginServer = class BrowserOnlyHostedPluginServer {
    constructor() {
        this.onDidOpenConnection = core_1.Event.None;
        this.onDidCloseConnection = core_1.Event.None;
    }
    /** The statically deployed plugins, from {@link BrowserOnlyPluginOptions} if bound, otherwise from the list the build wrote. */
    getPlugins() {
        if (!this.plugins) {
            this.plugins = this.options ? Promise.resolve(this.options.pluginMetadata) : this.fetchDeployedPlugins();
            // don't keep a failed fetch around, otherwise the tab has no plugins until it's reloaded
            this.plugins.catch(() => this.plugins = undefined);
        }
        return this.plugins;
    }
    async fetchDeployedPlugins() {
        // Built through `Endpoint`, like `PluginIconService#toPluginUrl`, so this keeps working
        // when the application is deployed under a sub-path.
        const url = new browser_1.Endpoint({ path: `${constants_1.PLUGINS_BASE_PATH}/${constants_1.LIST_JSON}` }).getRestUrl().toString();
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }
            const plugins = await response.json();
            if (!Array.isArray(plugins)) {
                throw new Error(`expected an array but got ${typeof plugins}`);
            }
            return plugins;
        }
        catch (error) {
            throw new Error(`Failed to load the deployed plugins from '${url}': ${error.message}`);
        }
    }
    async getDeployedPluginIds() {
        const plugins = await this.getPlugins();
        return plugins.map(p => common_1.PluginIdentifiers.componentsToVersionedId(p.metadata.model));
    }
    getInstalledPluginIds() {
        // the statically deployed plugins are the only ones that could ever be "installed"
        return this.getDeployedPluginIds();
    }
    async getUninstalledPluginIds() {
        return [];
    }
    async getDisabledPluginIds() {
        return [];
    }
    async getDeployedPlugins(ids) {
        const plugins = await this.getPlugins();
        const requested = new Set(ids);
        return plugins.filter(p => requested.has(common_1.PluginIdentifiers.componentsToVersionedId(p.metadata.model)));
    }
    async getExtPluginAPI() {
        return [];
    }
    async onMessage(targetHost, message) {
        // the frontend delivers messages to the plugin host directly, not through here
    }
    setClient(client) {
        this.client = client;
    }
    getClient() {
        return this.client;
    }
    dispose() {
        this.client = undefined;
    }
};
exports.BrowserOnlyHostedPluginServer = BrowserOnlyHostedPluginServer;
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.BrowserOnlyPluginOptions),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], BrowserOnlyHostedPluginServer.prototype, "options", void 0);
exports.BrowserOnlyHostedPluginServer = BrowserOnlyHostedPluginServer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserOnlyHostedPluginServer);
//# sourceMappingURL=browser-only-hosted-plugin-server.js.map