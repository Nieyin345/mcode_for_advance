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
var LocalVSIXFilePluginDeployerResolver_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalVSIXFilePluginDeployerResolver = void 0;
const tslib_1 = require("tslib");
const path = require("path");
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_ext_1 = require("@theia/plugin-ext");
const local_plugin_deployer_resolver_1 = require("@theia/plugin-ext/lib/main/node/resolvers/local-plugin-deployer-resolver");
const plugin_vscode_environment_1 = require("../common/plugin-vscode-environment");
const plugin_vscode_file_handler_1 = require("./plugin-vscode-file-handler");
const plugin_vscode_utils_1 = require("./plugin-vscode-utils");
const core_1 = require("@theia/core");
let LocalVSIXFilePluginDeployerResolver = class LocalVSIXFilePluginDeployerResolver extends local_plugin_deployer_resolver_1.LocalPluginDeployerResolver {
    static { LocalVSIXFilePluginDeployerResolver_1 = this; }
    static { this.LOCAL_FILE = 'local-file'; }
    static { this.FILE_EXTENSION = '.vsix'; }
    get supportedScheme() {
        return LocalVSIXFilePluginDeployerResolver_1.LOCAL_FILE;
    }
    accept(pluginId) {
        return super.accept(pluginId) && (0, plugin_vscode_file_handler_1.isVSCodePluginFile)(pluginId);
    }
    async resolveFromLocalPath(pluginResolverContext, localPath) {
        // Extract the true extension identity from the VSIX package.json
        // This prevents duplicate installations when the same extension is installed from VSIX files with different filenames
        // See: https://github.com/eclipse-theia/theia/issues/16845
        const components = await (0, plugin_vscode_utils_1.extractExtensionIdentityFromVsix)(localPath);
        if (!components) {
            // Fallback to filename-based ID if package.json cannot be read
            // This maintains backward compatibility for edge cases
            const fallbackId = path.basename(localPath, LocalVSIXFilePluginDeployerResolver_1.FILE_EXTENSION);
            this.logger.warn(`[${pluginResolverContext.getOriginId()}]: Could not read extension identity from VSIX, falling back to filename: ${fallbackId}`);
            if (await (0, plugin_vscode_utils_1.existsInDeploymentDir)(this.environment, fallbackId)) {
                this.logger.info(`[${pluginResolverContext.getOriginId()}]: Target dir already exists in plugin deployment dir`);
                return;
            }
            const fallbackDeploymentDir = await (0, plugin_vscode_utils_1.unpackToDeploymentDir)(this.environment, localPath, fallbackId);
            pluginResolverContext.addPlugin(fallbackId, fallbackDeploymentDir);
            return;
        }
        const versionedId = plugin_ext_1.PluginIdentifiers.componentsToVersionedId(components);
        // Check if the deployment directory already exists on disk
        if (await (0, plugin_vscode_utils_1.existsInDeploymentDir)(this.environment, versionedId)) {
            const unversionedId = plugin_ext_1.PluginIdentifiers.componentsToUnversionedId(components);
            const error = new Error(`Extension ${unversionedId} is already installed (version: ${components.version}).`);
            error.name = 'DuplicateExtensionError';
            throw error;
        }
        const extensionDeploymentDir = await (0, plugin_vscode_utils_1.unpackToDeploymentDir)(this.environment, localPath, versionedId);
        pluginResolverContext.addPlugin(versionedId, extensionDeploymentDir);
    }
};
exports.LocalVSIXFilePluginDeployerResolver = LocalVSIXFilePluginDeployerResolver;
tslib_1.__decorate([
    (0, inversify_1.inject)(plugin_vscode_environment_1.PluginVSCodeEnvironment),
    tslib_1.__metadata("design:type", plugin_vscode_environment_1.PluginVSCodeEnvironment)
], LocalVSIXFilePluginDeployerResolver.prototype, "environment", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('plugin-ext-vscode:LocalVSIXFilePluginDeployerResolver'),
    tslib_1.__metadata("design:type", Object)
], LocalVSIXFilePluginDeployerResolver.prototype, "logger", void 0);
exports.LocalVSIXFilePluginDeployerResolver = LocalVSIXFilePluginDeployerResolver = LocalVSIXFilePluginDeployerResolver_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], LocalVSIXFilePluginDeployerResolver);
//# sourceMappingURL=local-vsix-file-plugin-deployer-resolver.js.map