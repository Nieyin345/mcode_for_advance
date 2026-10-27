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
exports.PluginVsCodeDirectoryHandler = void 0;
const tslib_1 = require("tslib");
const path = require("path");
const fs = require("@theia/core/shared/fs-extra");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const plugin_ext_1 = require("@theia/plugin-ext");
const plugin_cli_contribution_1 = require("@theia/plugin-ext/lib/main/node/plugin-cli-contribution");
const plugin_vscode_utils_1 = require("./plugin-vscode-utils");
let PluginVsCodeDirectoryHandler = class PluginVsCodeDirectoryHandler {
    async accept(plugin) {
        this.logger.debug(`Resolving "${plugin.id()}" as a VS Code extension...`);
        if (plugin.path().startsWith(plugin_vscode_utils_1.TMP_DIR_PREFIX)) {
            // avoid adding corrupted plugins from temporary directories
            return false;
        }
        return this.attemptResolution(plugin);
    }
    async attemptResolution(plugin) {
        if (this.resolvePackage(plugin)) {
            return true;
        }
        return this.deriveMetadata(plugin);
    }
    async deriveMetadata(plugin) {
        return (0, promise_util_1.firstTrue)(this.resolveFromSources(plugin), this.resolveFromVSIX(plugin), this.resolveFromNpmTarball(plugin));
    }
    async handle(context) {
        const types = [];
        const packageJson = context.pluginEntry().getValue('package.json');
        if (packageJson.browser) {
            types.push(plugin_ext_1.PluginDeployerEntryType.FRONTEND);
        }
        if (packageJson.main || !packageJson.browser) {
            types.push(plugin_ext_1.PluginDeployerEntryType.BACKEND);
        }
        context.pluginEntry().accept(...types);
    }
    async resolveFromSources(plugin) {
        const pluginPath = plugin.path();
        const pck = await this.requirePackage(pluginPath);
        return this.resolvePackage(plugin, { pluginPath, pck });
    }
    async resolveFromVSIX(plugin) {
        if (!(await fs.pathExists(path.join(plugin.path(), 'extension.vsixmanifest')))) {
            return false;
        }
        const pluginPath = path.join(plugin.path(), 'extension');
        const pck = await this.requirePackage(pluginPath);
        return this.resolvePackage(plugin, { pluginPath, pck });
    }
    async resolveFromNpmTarball(plugin) {
        const pluginPath = path.join(plugin.path(), 'package');
        const pck = await this.requirePackage(pluginPath);
        return this.resolvePackage(plugin, { pluginPath, pck });
    }
    resolvePackage(plugin, options) {
        const { pluginPath, pck } = options || {
            pluginPath: plugin.path(),
            pck: plugin.getValue('package.json')
        };
        if (!pck || !pck.name || !pck.version || !pck.engines || !pck.engines.vscode) {
            return false;
        }
        pck.publisher ??= plugin_ext_1.PluginIdentifiers.UNPUBLISHED;
        if (options) {
            plugin.storeValue('package.json', pck);
            plugin.rootPath = plugin.path();
            plugin.updatePath(pluginPath);
        }
        this.logger.debug(`Resolved "${plugin.id()}" to a VS Code extension "${pck.name}@${pck.version}" with engines:`, pck.engines);
        return true;
    }
    async requirePackage(pluginPath) {
        try {
            const plugin = await fs.readJSON(path.join(pluginPath, 'package.json'));
            plugin.publisher ??= plugin_ext_1.PluginIdentifiers.UNPUBLISHED;
            return plugin;
        }
        catch {
            return undefined;
        }
    }
};
exports.PluginVsCodeDirectoryHandler = PluginVsCodeDirectoryHandler;
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_cli_contribution_1.PluginCliContribution),
    tslib_1.__metadata("design:type", plugin_cli_contribution_1.PluginCliContribution)
], PluginVsCodeDirectoryHandler.prototype, "pluginCli", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext-vscode:PluginVsCodeDirectoryHandler'),
    tslib_1.__metadata("design:type", Object)
], PluginVsCodeDirectoryHandler.prototype, "logger", void 0);
exports.PluginVsCodeDirectoryHandler = PluginVsCodeDirectoryHandler = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginVsCodeDirectoryHandler);
//# sourceMappingURL=plugin-vscode-directory-handler.js.map