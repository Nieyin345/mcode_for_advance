"use strict";
// *****************************************************************************
// Copyright (C) 2015-2021 Red Hat, Inc.
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
exports.VsCodePluginScanner = void 0;
const tslib_1 = require("tslib");
const path = require("path");
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_ext_1 = require("@theia/plugin-ext");
const scanner_theia_1 = require("@theia/plugin-ext/lib/hosted/node/scanners/scanner-theia");
const environment_1 = require("@theia/core/shared/@theia/application-package/lib/environment");
const plugin_vscode_uri_1 = require("../common/plugin-vscode-uri");
const plugin_model_1 = require("@theia/plugin-utils/lib/common/plugin-model");
const uiKind = environment_1.environment.electron.is() ? plugin_ext_1.UIKind.Desktop : plugin_ext_1.UIKind.Web;
let VsCodePluginScanner = class VsCodePluginScanner extends scanner_theia_1.TheiaPluginScanner {
    constructor() {
        super(...arguments);
        this.VSCODE_TYPE = 'vscode';
    }
    get apiType() {
        return this.VSCODE_TYPE;
    }
    getModel(plugin) {
        const result = (0, plugin_model_1.buildModelForVsCode)({
            ...plugin,
            publisher: plugin.publisher ?? plugin_ext_1.PluginIdentifiers.UNPUBLISHED,
            packageUri: this.pluginUriFactory.createUri(plugin).toString(),
        }, { uiKind: uiKind === plugin_ext_1.UIKind.Web ? 'web' : 'desktop' });
        result.licenseUrl = this.getLicenseUrl(plugin);
        result.readmeUrl = this.getReadmeUrl(plugin);
        this.applyTrustExtraction(plugin, result);
        return result;
    }
    /**
     * Maps extension dependencies to deployable extension dependencies.
     */
    getDependencies(plugin) {
        const dependencies = new Map();
        for (const dependency of [plugin.extensionDependencies, plugin.extensionPack]) {
            if (dependency !== undefined) {
                dependency.forEach((dep) => {
                    const dependencyId = dep.toLowerCase();
                    dependencies.set(dependencyId, plugin_vscode_uri_1.VSCodeExtensionUri.fromId(dependencyId).toString());
                });
            }
        }
        return dependencies.size > 0 ? dependencies : undefined;
    }
    getLifecycle(plugin) {
        return {
            ...(0, plugin_model_1.buildLifecycle)(plugin, 'vscode'),
            backendInitPath: path.join(__dirname, 'plugin-vscode-init'),
        };
    }
};
exports.VsCodePluginScanner = VsCodePluginScanner;
exports.VsCodePluginScanner = VsCodePluginScanner = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], VsCodePluginScanner);
//# sourceMappingURL=scanner-vscode.js.map