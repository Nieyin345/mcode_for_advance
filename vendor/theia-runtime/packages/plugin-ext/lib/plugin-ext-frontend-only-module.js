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
const inversify_1 = require("@theia/core/shared/inversify");
const plugin_protocol_1 = require("./common/plugin-protocol");
const browser_only_hosted_plugin_server_1 = require("./hosted/browser-only/browser-only-hosted-plugin-server");
const plugin_paths_protocol_1 = require("./main/common/plugin-paths-protocol");
const browser_only_plugin_paths_service_1 = require("./hosted/browser-only/browser-only-plugin-paths-service");
const browser_only_plugin_server_1 = require("./hosted/browser-only/browser-only-plugin-server");
const browser_only_plugin_file_system_provider_1 = require("./hosted/browser-only/browser-only-plugin-file-system-provider");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
exports.default = new inversify_1.ContainerModule((bind, unbind, isBound, rebind) => {
    rebind(plugin_protocol_1.HostedPluginServer).to(browser_only_hosted_plugin_server_1.BrowserOnlyHostedPluginServer).inSingletonScope();
    rebind(plugin_protocol_1.PluginServer).to(browser_only_plugin_server_1.BrowserOnlyPluginServer).inSingletonScope();
    rebind(plugin_paths_protocol_1.PluginPathsService).to(browser_only_plugin_paths_service_1.BrowserOnlyPluginPathsService).inSingletonScope();
    bind(browser_only_plugin_file_system_provider_1.BrowserOnlyPluginFileSystemProvider).toSelf().inSingletonScope();
    bind(browser_only_plugin_file_system_provider_1.BrowserOnlyPluginFileServiceContribution).toSelf().inSingletonScope();
    bind(file_service_1.FileServiceContribution).toService(browser_only_plugin_file_system_provider_1.BrowserOnlyPluginFileServiceContribution);
});
//# sourceMappingURL=plugin-ext-frontend-only-module.js.map