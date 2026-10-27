"use strict";
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
require("../../src/browser/style/mcp-server-dialog.css");
require("../../src/browser/style/mcp-configuration-widget.css");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const mcp_frontend_application_contribution_1 = require("./mcp-frontend-application-contribution");
const mcp_frontend_service_1 = require("./mcp-frontend-service");
const mcp_frontend_notification_service_1 = require("./mcp-frontend-notification-service");
const mcp_server_manager_server_client_1 = require("./mcp-server-manager-server-client");
const mcp_protocol_1 = require("../common/mcp-protocol");
const mcp_oauth_1 = require("../common/mcp-oauth");
const mcp_oauth_frontend_delegate_client_1 = require("./mcp-oauth-frontend-delegate-client");
const workspace_trust_service_1 = require("@theia/workspace/lib/browser/workspace-trust-service");
const ai_core_1 = require("@theia/ai-core");
const mcp_generic_capabilities_contribution_1 = require("./mcp-generic-capabilities-contribution");
const mcp_server_editor_1 = require("./mcp-server-editor");
const mcp_server_edit_dialog_1 = require("./mcp-server-edit-dialog");
const mcp_server_install_dialog_1 = require("./mcp-server-install-dialog");
const mcp_servers_configuration_category_1 = require("./mcp-servers-configuration-category");
const ai_configuration_category_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/ai-configuration-category");
const mcp_configuration_command_contribution_1 = require("./mcp-configuration-command-contribution");
const mcp_install_uri_configuration_1 = require("./mcp-install-uri-configuration");
const install_mcp_uri_handler_1 = require("./install-mcp-uri-handler");
exports.default = new inversify_1.ContainerModule(bind => {
    bind(mcp_frontend_application_contribution_1.McpFrontendApplicationContribution).toSelf().inSingletonScope();
    bind(browser_1.FrontendApplicationContribution).toService(mcp_frontend_application_contribution_1.McpFrontendApplicationContribution);
    bind(workspace_trust_service_1.WorkspaceRestrictionContribution).toService(mcp_frontend_application_contribution_1.McpFrontendApplicationContribution);
    bind(mcp_server_manager_1.MCPFrontendService).to(mcp_frontend_service_1.MCPFrontendServiceImpl).inSingletonScope();
    bind(mcp_server_manager_1.MCPFrontendNotificationService).to(mcp_frontend_notification_service_1.MCPFrontendNotificationServiceImpl).inSingletonScope();
    bind(mcp_server_editor_1.MCPServerEditDialogFactory).toFactory(ctx => (parameters) => new mcp_server_edit_dialog_1.MCPServerEditDialog(parameters.props, parameters.initialData ?? { ...mcp_server_edit_dialog_1.DEFAULT_MCP_SERVER_FORM_DATA }, parameters.existingServerNames, parameters.isEditing, () => ctx.container.get(mcp_oauth_1.MCPOAuthFrontendDelegate).getEffectiveRedirectUrl()));
    bind(mcp_server_install_dialog_1.MCPServerInstallDialogFactory).toFactory(ctx => (options) => new mcp_server_install_dialog_1.MCPServerInstallDialog(options, () => ctx.container.get(mcp_oauth_1.MCPOAuthFrontendDelegate).getEffectiveRedirectUrl()));
    bind(mcp_server_editor_1.MCPServerEditorImpl).toSelf().inSingletonScope();
    bind(mcp_server_editor_1.MCPServerEditor).toService(mcp_server_editor_1.MCPServerEditorImpl);
    bind(mcp_servers_configuration_category_1.McpServersConfigurationCategory).toSelf().inSingletonScope();
    bind(ai_configuration_category_1.AiConfigurationCategory).toService(mcp_servers_configuration_category_1.McpServersConfigurationCategory);
    bind(mcp_configuration_command_contribution_1.MCPConfigurationCommandContribution).toSelf().inSingletonScope();
    bind(core_1.CommandContribution).toService(mcp_configuration_command_contribution_1.MCPConfigurationCommandContribution);
    bind(mcp_install_uri_configuration_1.MCPInstallUriConfiguration).toSelf().inSingletonScope();
    bind(install_mcp_uri_handler_1.InstallMcpUriHandler).toSelf().inSingletonScope();
    bind(browser_1.OpenHandler).toService(install_mcp_uri_handler_1.InstallMcpUriHandler);
    bind(mcp_generic_capabilities_contribution_1.MCPGenericCapabilitiesContribution).toSelf().inSingletonScope();
    bind(ai_core_1.GenericCapabilitiesContribution).toService(mcp_generic_capabilities_contribution_1.MCPGenericCapabilitiesContribution);
    bind(mcp_protocol_1.MCPServerManagerServerClient).to(mcp_server_manager_server_client_1.MCPServerManagerServerClientImpl).inSingletonScope();
    bind(mcp_oauth_1.MCPOAuthFrontendDelegateClient).to(mcp_oauth_frontend_delegate_client_1.MCPOAuthFrontendDelegateClientImpl).inSingletonScope();
    bind(mcp_oauth_1.MCPOAuthFrontendDelegate).toDynamicValue(ctx => {
        const connection = ctx.container.get(browser_1.RemoteConnectionProvider);
        const client = ctx.container.get(mcp_oauth_1.MCPOAuthFrontendDelegateClient);
        return connection.createProxy(mcp_oauth_1.mcpOAuthFrontendDelegatePath, client);
    }).inSingletonScope();
    bind(mcp_protocol_1.MCPServerManagerServer).toDynamicValue(ctx => {
        const connection = ctx.container.get(browser_1.RemoteConnectionProvider);
        const client = ctx.container.get(mcp_protocol_1.MCPServerManagerServerClient);
        return connection.createProxy(mcp_protocol_1.MCPServerManagerServerPath, client);
    }).inSingletonScope();
    bind(mcp_server_manager_1.MCPServerManager).toDynamicValue(ctx => {
        const mgrServer = ctx.container.get(mcp_protocol_1.MCPServerManagerServer);
        const connection = ctx.container.get(browser_1.RemoteConnectionProvider);
        const client = ctx.container.get(mcp_server_manager_1.MCPFrontendNotificationService);
        const serverClient = ctx.container.get(mcp_protocol_1.MCPServerManagerServerClient);
        const backendServerManager = connection.createProxy(mcp_server_manager_1.MCPServerManagerPath, client);
        // Listen to server updates to clean up removed servers
        client.onDidUpdateMCPServers(() => backendServerManager.getServerNames()
            .then(names => serverClient.cleanServers(names))
            .catch((error) => {
            console.error('Error cleaning server descriptions:', error);
        }));
        // We proxy the MCPServerManager to override addOrUpdateServer and getServerDescription
        // to handle the resolve functions via the MCPServerManagerServerClient.
        return new Proxy(backendServerManager, {
            get(target, prop) {
                // override addOrUpdateServer to store the original description in the MCPServerManagerServerClient
                // to be used in resolveServerDescription if a resolve function is provided
                if (prop === 'addOrUpdateServer') {
                    return async function (...args) {
                        const updated = serverClient.addServerDescription(args[0]);
                        await mgrServer.addOrUpdateServer(updated);
                    };
                }
                // override getServerDescription to mix in the resolve function from the client
                if (prop === 'getServerDescription') {
                    return async function (name) {
                        const description = await Reflect.apply(target.getServerDescription, target, [name]);
                        if (description) {
                            const resolveFunction = serverClient.getResolveFunction(name);
                            if (resolveFunction) {
                                return {
                                    ...description,
                                    resolve: resolveFunction
                                };
                            }
                        }
                        return description;
                    };
                }
                return Reflect.get(target, prop, target);
            }
        });
    }).inSingletonScope();
});
//# sourceMappingURL=mcp-frontend-module.js.map