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
exports.bindMainBackend = bindMainBackend;
const plugin_service_1 = require("./plugin-service");
const node_1 = require("@theia/core/lib/node");
const ws_request_validators_1 = require("@theia/core/lib/node/ws-request-validators");
const plugins_key_value_storage_1 = require("./plugins-key-value-storage");
const plugin_deployer_contribution_1 = require("./plugin-deployer-contribution");
const plugin_protocol_1 = require("../../common/plugin-protocol");
const plugin_deployer_impl_1 = require("./plugin-deployer-impl");
const local_directory_plugin_deployer_resolver_1 = require("./resolvers/local-directory-plugin-deployer-resolver");
const plugin_theia_file_handler_1 = require("./handlers/plugin-theia-file-handler");
const plugin_theia_directory_handler_1 = require("./handlers/plugin-theia-directory-handler");
const plugin_github_resolver_1 = require("./plugin-github-resolver");
const plugin_http_resolver_1 = require("./plugin-http-resolver");
const core_1 = require("@theia/core");
const plugin_paths_protocol_1 = require("../common/plugin-paths-protocol");
const plugin_paths_service_1 = require("./paths/plugin-paths-service");
const plugin_server_impl_1 = require("./plugin-server-impl");
const plugin_cli_contribution_1 = require("./plugin-cli-contribution");
const plugin_theia_environment_1 = require("../common/plugin-theia-environment");
const plugin_theia_deployer_participant_1 = require("./plugin-theia-deployer-participant");
const webview_backend_security_warnings_1 = require("./webview-backend-security-warnings");
const plugin_uninstallation_manager_1 = require("./plugin-uninstallation-manager");
const localization_server_1 = require("@theia/core/lib/node/i18n/localization-server");
const plugin_localization_server_1 = require("./plugin-localization-server");
const plugin_mgmt_cli_contribution_1 = require("./plugin-mgmt-cli-contribution");
const plugin_remote_cli_contribution_1 = require("./plugin-remote-cli-contribution");
const remote_cli_contribution_1 = require("@theia/core/lib/node/remote/remote-cli-contribution");
const plugin_remote_copy_contribution_1 = require("./plugin-remote-copy-contribution");
const remote_copy_contribution_1 = require("@theia/core/lib/node/remote/remote-copy-contribution");
const webview_preferences_1 = require("../common/webview-preferences");
const plugin_host_environment_preferences_1 = require("../common/plugin-host-environment-preferences");
const plugin_host_navigator_state_initializer_1 = require("./plugin-host-navigator-state-initializer");
function bindMainBackend(bind, unbind, isBound, rebind) {
    bind(plugin_service_1.PluginApiContribution).toSelf().inSingletonScope();
    bind(node_1.BackendApplicationContribution).toService(plugin_service_1.PluginApiContribution);
    bind(ws_request_validators_1.WsRequestValidatorContribution).toService(plugin_service_1.PluginApiContribution);
    (0, core_1.bindRootContributionProvider)(bind, plugin_protocol_1.PluginDeployerParticipant);
    bind(plugin_protocol_1.PluginDeployer).to(plugin_deployer_impl_1.PluginDeployerImpl).inSingletonScope();
    bind(plugin_deployer_contribution_1.PluginDeployerContribution).toSelf().inSingletonScope();
    bind(node_1.BackendApplicationContribution).toService(plugin_deployer_contribution_1.PluginDeployerContribution);
    bind(plugin_uninstallation_manager_1.PluginUninstallationManager).toSelf().inSingletonScope();
    bind(plugin_protocol_1.PluginDeployerResolver).to(local_directory_plugin_deployer_resolver_1.LocalDirectoryPluginDeployerResolver).inSingletonScope();
    bind(plugin_protocol_1.PluginDeployerResolver).to(plugin_github_resolver_1.GithubPluginDeployerResolver).inSingletonScope();
    bind(plugin_protocol_1.PluginDeployerResolver).to(plugin_http_resolver_1.HttpPluginDeployerResolver).inSingletonScope();
    bind(plugin_theia_environment_1.PluginTheiaEnvironment).toSelf().inSingletonScope();
    bind(plugin_theia_deployer_participant_1.PluginTheiaDeployerParticipant).toSelf().inSingletonScope();
    bind(plugin_protocol_1.PluginDeployerParticipant).toService(plugin_theia_deployer_participant_1.PluginTheiaDeployerParticipant);
    bind(plugin_protocol_1.PluginDeployerFileHandler).to(plugin_theia_file_handler_1.PluginTheiaFileHandler).inSingletonScope();
    bind(plugin_protocol_1.PluginDeployerDirectoryHandler).to(plugin_theia_directory_handler_1.PluginTheiaDirectoryHandler).inSingletonScope();
    bind(plugin_protocol_1.PluginServer).to(plugin_server_impl_1.PluginServerImpl).inSingletonScope();
    bind(plugins_key_value_storage_1.PluginsKeyValueStorage).toSelf().inSingletonScope();
    bind(plugin_paths_protocol_1.PluginPathsService).to(plugin_paths_service_1.PluginPathsServiceImpl).inSingletonScope();
    bind(core_1.ConnectionHandler).toDynamicValue(ctx => new core_1.RpcConnectionHandler(plugin_paths_protocol_1.pluginPathsServicePath, () => ctx.container.get(plugin_paths_protocol_1.PluginPathsService))).inSingletonScope();
    bind(core_1.ConnectionHandler).toDynamicValue(ctx => new core_1.RpcConnectionHandler(plugin_protocol_1.pluginServerJsonRpcPath, () => ctx.container.get(plugin_protocol_1.PluginServer))).inSingletonScope();
    bind(plugin_cli_contribution_1.PluginCliContribution).toSelf().inSingletonScope();
    bind(node_1.CliContribution).toService(plugin_cli_contribution_1.PluginCliContribution);
    bind(plugin_mgmt_cli_contribution_1.PluginMgmtCliContribution).toSelf().inSingletonScope();
    bind(node_1.CliContribution).toService(plugin_mgmt_cli_contribution_1.PluginMgmtCliContribution);
    bind(plugin_remote_cli_contribution_1.PluginRemoteCliContribution).toSelf().inSingletonScope();
    bind(remote_cli_contribution_1.RemoteCliContribution).toService(plugin_remote_cli_contribution_1.PluginRemoteCliContribution);
    bind(plugin_remote_copy_contribution_1.PluginRemoteCopyContribution).toSelf().inSingletonScope();
    bind(remote_copy_contribution_1.RemoteCopyContribution).toService(plugin_remote_copy_contribution_1.PluginRemoteCopyContribution);
    bind(webview_backend_security_warnings_1.WebviewBackendSecurityWarnings).toSelf().inSingletonScope();
    bind(node_1.BackendApplicationContribution).toService(webview_backend_security_warnings_1.WebviewBackendSecurityWarnings);
    rebind(localization_server_1.LocalizationServerImpl).to(plugin_localization_server_1.PluginLocalizationServer).inSingletonScope();
    (0, webview_preferences_1.bindWebviewPreferences)(bind);
    (0, plugin_host_environment_preferences_1.bindPluginHostEnvironmentPreferences)(bind);
    bind(plugin_host_navigator_state_initializer_1.PluginHostNavigatorStateInitializer).toSelf().inSingletonScope();
    bind(node_1.BackendApplicationContribution).toService(plugin_host_navigator_state_initializer_1.PluginHostNavigatorStateInitializer);
}
//# sourceMappingURL=plugin-ext-backend-module.js.map