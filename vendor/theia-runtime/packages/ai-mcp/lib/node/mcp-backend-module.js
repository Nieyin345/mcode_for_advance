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
const inversify_1 = require("@theia/core/shared/inversify");
const backend_application_1 = require("@theia/core/lib/node/backend-application");
const core_1 = require("@theia/core");
const mcp_server_manager_impl_1 = require("./mcp-server-manager-impl");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const connection_container_module_1 = require("@theia/core/lib/node/messaging/connection-container-module");
const mcp_preferences_1 = require("../common/mcp-preferences");
const mcp_server_manager_server_1 = require("./mcp-server-manager-server");
const mcp_protocol_1 = require("../common/mcp-protocol");
const mcp_oauth_1 = require("../common/mcp-oauth");
const mcp_oauth_frontend_delegate_1 = require("./mcp-oauth-frontend-delegate");
const mcp_oauth_callback_service_1 = require("./mcp-oauth-callback-service");
const mcp_oauth_callback_responder_1 = require("./mcp-oauth-callback-responder");
const mcp_oauth_callback_backend_contribution_1 = require("./mcp-oauth-callback-backend-contribution");
const mcp_oauth_client_provider_factory_1 = require("./mcp-oauth-client-provider-factory");
const mcp_oauth_credential_store_1 = require("./mcp-oauth-credential-store");
// We use a connection module to handle AI services separately for each frontend.
const mcpConnectionModule = connection_container_module_1.ConnectionContainerModule.create(({ bind, bindBackendService, bindFrontendService }) => {
    bind(mcp_oauth_client_provider_factory_1.MCPOAuthClientProviderFactory).toSelf().inSingletonScope();
    bind(mcp_oauth_credential_store_1.MCPOAuthCredentialStore).toSelf().inSingletonScope();
    bind(mcp_oauth_frontend_delegate_1.MCPOAuthFrontendDelegateImpl).toSelf().inSingletonScope();
    bind(mcp_oauth_1.MCPOAuthFrontendDelegate).toService(mcp_oauth_frontend_delegate_1.MCPOAuthFrontendDelegateImpl);
    bind(mcp_server_manager_1.MCPServerManager).to(mcp_server_manager_impl_1.MCPServerManagerImpl).inSingletonScope();
    bind(core_1.ConnectionHandler).toDynamicValue(ctx => new core_1.RpcConnectionHandler(mcp_server_manager_1.MCPServerManagerPath, client => {
        const server = ctx.container.get(mcp_server_manager_1.MCPServerManager);
        server.setClient(client);
        client.onDidCloseConnection(() => server.disconnectClient(client));
        return server;
    })).inSingletonScope();
    bind(mcp_protocol_1.MCPServerManagerServer).to(mcp_server_manager_server_1.MCPServerManagerServerImpl).inSingletonScope();
    bind(core_1.ConnectionHandler).toDynamicValue(ctx => new core_1.RpcConnectionHandler(mcp_protocol_1.MCPServerManagerServerPath, client => {
        const server = ctx.container.get(mcp_protocol_1.MCPServerManagerServer);
        server.setClient(client);
        client.onDidCloseConnection(() => server.disconnectClient(client));
        return server;
    })).inSingletonScope();
    bind(core_1.ConnectionHandler).toDynamicValue(ctx => new core_1.RpcConnectionHandler(mcp_oauth_1.mcpOAuthFrontendDelegatePath, client => {
        const delegate = ctx.container.get(mcp_oauth_1.MCPOAuthFrontendDelegate);
        delegate.setClient(client);
        client.onDidCloseConnection(() => delegate.disconnectClient(client));
        return delegate;
    })).inSingletonScope();
});
exports.default = new inversify_1.ContainerModule(bind => {
    bind(core_1.PreferenceContribution).toConstantValue({ schema: mcp_preferences_1.McpServersPreferenceSchema });
    bind(mcp_oauth_callback_service_1.MCPOAuthCallbackService).toSelf().inSingletonScope();
    bind(mcp_oauth_callback_responder_1.MCPOAuthCallbackResponder).toSelf().inSingletonScope();
    bind(mcp_oauth_callback_backend_contribution_1.MCPOAuthCallbackBackendContribution).toSelf().inSingletonScope();
    bind(backend_application_1.BackendApplicationContribution).toService(mcp_oauth_callback_backend_contribution_1.MCPOAuthCallbackBackendContribution);
    bind(connection_container_module_1.ConnectionContainerModule).toConstantValue(mcpConnectionModule);
});
//# sourceMappingURL=mcp-backend-module.js.map