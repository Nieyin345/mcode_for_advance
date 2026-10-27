"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPServerManagerImpl = void 0;
const tslib_1 = require("tslib");
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
const inversify_1 = require("@theia/core/shared/inversify");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const mcp_server_1 = require("./mcp-server");
const mcp_oauth_client_provider_factory_1 = require("./mcp-oauth-client-provider-factory");
const mcp_oauth_credential_store_1 = require("./mcp-oauth-credential-store");
const mcp_oauth_keystore_1 = require("./mcp-oauth-keystore");
const core_1 = require("@theia/core");
let MCPServerManagerImpl = class MCPServerManagerImpl {
    constructor() {
        this.servers = new Map();
        this.serverListeners = new Map();
    }
    async stopServer(serverName) {
        const server = this.servers.get(serverName);
        if (!server) {
            throw new Error(`MCP server "${serverName}" not found.`);
        }
        try {
            await server.stop();
            this.logger.info(`MCP server "${serverName}" stopped.`);
        }
        finally {
            this.notifyClients();
        }
    }
    async signOut(serverName) {
        const server = this.servers.get(serverName);
        try {
            if (server && !server.isStopped()) {
                try {
                    await server.stop();
                }
                catch (error) {
                    this.logger.error(`Failed to stop MCP server "${serverName}" during sign-out`, error);
                }
            }
            await this.credentialStore.clear(serverName);
        }
        finally {
            this.notifyClients();
        }
    }
    async hasStoredOAuthCredentials(serverName) {
        const server = this.servers.get(serverName);
        const description = server?.getCachedDescription();
        if (!description || !(0, mcp_server_manager_1.isRemoteMCPServerDescription)(description) || !description.oauth) {
            return false;
        }
        return this.credentialStore.hasTokens(serverName, description.serverUrl, description.oauth);
    }
    async getRunningServers() {
        const runningServers = [];
        for (const [name, server] of this.servers.entries()) {
            if (server.isRunning()) {
                runningServers.push(name);
            }
        }
        return runningServers;
    }
    async getActiveServers() {
        const activeServers = [];
        for (const [name, server] of this.servers.entries()) {
            if (!server.isStopped()) {
                activeServers.push(name);
            }
        }
        return activeServers;
    }
    callTool(serverName, toolName, arg_string) {
        const server = this.servers.get(serverName);
        if (!server) {
            throw new Error(`MCP server "${serverName}" not found.`);
        }
        return server.callTool(toolName, arg_string);
    }
    async startServer(serverName, options = {}) {
        const server = this.servers.get(serverName);
        if (!server) {
            throw new Error(`MCP server "${serverName}" not found.`);
        }
        const description = await server.getDescription();
        if (description.resolve) {
            const resolved = await description.resolve(description);
            if (resolved && !this.haveSameConfiguration(description, resolved)) {
                await this.clearOAuthCredentialsIfConnectionScopeChanged(description, resolved);
                await this.clearOAuthCredentialsIfDisabled(description, resolved);
                server.update(resolved);
            }
        }
        await server.start({ interactive: !!options.interactive });
        this.notifyClients();
    }
    haveSameConfiguration(a, b) {
        return core_1.PreferenceUtils.deepEqual(this.configurationOnly(a), this.configurationOnly(b));
    }
    configurationOnly(description) {
        const { status, error, tools, resolve, ...configuration } = description;
        return configuration;
    }
    async getServerNames() {
        return Array.from(this.servers.keys());
    }
    async getServerDescription(name) {
        const server = this.servers.get(name);
        return server ? await server.getDescription() : undefined;
    }
    async getTools(serverName) {
        const server = this.servers.get(serverName);
        if (!server) {
            throw new Error(`MCP server "${serverName}" not found.`);
        }
        return await server.getTools();
    }
    async addOrUpdateServer(description) {
        const existingServer = this.servers.get(description.name);
        if (existingServer) {
            const oldDescription = existingServer.getCachedDescription();
            const restartServer = this.connectionChangeRequiresRestart(existingServer, oldDescription, description);
            if (restartServer) {
                await existingServer.stop();
            }
            await this.clearOAuthCredentialsIfConnectionScopeChanged(oldDescription, description);
            await this.clearOAuthCredentialsIfDisabled(oldDescription, description);
            existingServer.update(description, this.shouldResetStatusAfterUpdate(existingServer, restartServer));
        }
        else {
            const newServer = new mcp_server_1.MCPServer(description, this.oauthClientProviderFactory);
            newServer.setWorkspaceRoots(this.roots);
            this.servers.set(description.name, newServer);
            const listener = newServer.onDidUpdateStatus(() => {
                this.notifyClients();
            });
            this.serverListeners.set(description.name, listener);
        }
        this.notifyClients();
    }
    async removeServer(name) {
        const server = this.servers.get(name);
        if (server) {
            try {
                await server.stop();
            }
            catch (error) {
                this.logger.error(`Failed to stop MCP server "${name}" during removal`, error);
            }
            await this.credentialStore.clear(name);
            this.servers.delete(name);
            const listener = this.serverListeners.get(name);
            if (listener) {
                listener.dispose();
                this.serverListeners.delete(name);
            }
        }
        else {
            this.logger.warn(`MCP server "${name}" not found.`);
        }
        this.notifyClients();
    }
    shouldRestartServer(oldDescription, newDescription) {
        return !core_1.PreferenceUtils.deepEqual(this.connectionDescription(oldDescription), this.connectionDescription(newDescription));
    }
    connectionChangeRequiresRestart(server, oldDescription, newDescription) {
        // Any non-terminal state must be cancelled because an in-flight doStart would keep reading the
        // OLD serverUrl/headers/oauth on reconnect/SSE-fallback paths after update() swaps the description.
        return !server.isStopped() && this.shouldRestartServer(oldDescription, newDescription);
    }
    shouldResetStatusAfterUpdate(server, restartedByCaller) {
        return restartedByCaller || (!server.isRunning() && !server.isInFlight());
    }
    /**
     * The part of a description that decides whether a running server has to be restarted rather than
     * merely updated in place. Anything that shapes the connection - or, for a local server, the
     * process - belongs here; anything purely presentational does not.
     */
    connectionDescription(description) {
        if ((0, mcp_server_manager_1.isRemoteMCPServerDescription)(description)) {
            const { serverUrl, serverAuthToken, serverAuthTokenHeader, headers, oauth } = description;
            return { type: 'remote', serverUrl, serverAuthToken, serverAuthTokenHeader, headers, oauth };
        }
        const { command, args, env, cwd, pluginRoot, pluginData } = description;
        // `cwd`, `pluginRoot` and `pluginData` all reach the spawned process, so changing any of them
        // needs a new one. `installedAt` is not configuration at all: it is here because replacing a
        // plugin's root deletes the directory a running child works out of while leaving that child's
        // own configuration identical.
        return { type: 'local', command, args, env, cwd, pluginRoot, pluginData, installedAt: description.registryMetadata?.installedAt };
    }
    async clearOAuthCredentialsIfConnectionScopeChanged(oldDescription, newDescription) {
        if ((0, mcp_server_manager_1.isRemoteMCPServerDescription)(oldDescription)
            && oldDescription.oauth
            && (0, mcp_server_manager_1.isRemoteMCPServerDescription)(newDescription)
            && newDescription.oauth
            && this.connectionScopeChanged(oldDescription, newDescription)) {
            await this.credentialStore.clear(oldDescription.name);
        }
    }
    connectionScopeChanged(oldDescription, newDescription) {
        if (this.credentialScopeKey(oldDescription) !== this.credentialScopeKey(newDescription)) {
            return true;
        }
        if (this.normalizedAuthorizationServer(oldDescription.oauth?.authorizationServer)
            !== this.normalizedAuthorizationServer(newDescription.oauth?.authorizationServer)) {
            return true;
        }
        if (oldDescription.oauth?.clientId !== newDescription.oauth?.clientId) {
            return true;
        }
        if (this.normalizedScopes(oldDescription.oauth?.scopes) !== this.normalizedScopes(newDescription.oauth?.scopes)) {
            return true;
        }
        return false;
    }
    credentialScopeKey(description) {
        // Reuse the shared `deriveCredentialScope` so this check matches the factory/store keystore key exactly.
        return (0, mcp_oauth_keystore_1.deriveCredentialScope)(description.serverUrl, description.oauth ?? {});
    }
    normalizedAuthorizationServer(authorizationServer) {
        // Normalize so a trailing-slash-only edit to the authorization server is not mistaken for a scope change.
        return authorizationServer === undefined ? undefined : (0, mcp_oauth_keystore_1.normalizeOAuthUrl)(authorizationServer);
    }
    normalizedScopes(scopes) {
        return JSON.stringify([...(scopes ?? [])].sort());
    }
    async clearOAuthCredentialsIfDisabled(oldDescription, newDescription) {
        if ((0, mcp_server_manager_1.isRemoteMCPServerDescription)(oldDescription)
            && oldDescription.oauth
            && (!(0, mcp_server_manager_1.isRemoteMCPServerDescription)(newDescription) || !newDescription.oauth)) {
            await this.credentialStore.clear(oldDescription.name);
        }
    }
    setClient(client) {
        if (this.client && this.client !== client) {
            throw new Error('MCP server manager is scoped to a single frontend connection.');
        }
        this.client = client;
    }
    disconnectClient(client) {
        if (this.client !== undefined && this.client !== client) {
            this.logger.warn('MCP server manager received disconnectClient for a non-current client; ignoring (one-client-per-container invariant violation).');
            return;
        }
        if (this.client === client) {
            this.client = undefined;
            this.stopServersAfterDisconnect().catch(error => this.logger.error('Failed to stop MCP servers after frontend disconnect', error));
        }
    }
    async stopServersAfterDisconnect() {
        const entries = Array.from(this.servers.entries());
        const results = await Promise.allSettled(entries.map(async ([, server]) => server.stop()));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                const [name] = entries[index];
                this.logger.error(`Failed to stop MCP server "${name}" after frontend disconnect`, result.reason);
            }
        });
    }
    notifyClients() {
        if (!this.client) {
            return;
        }
        try {
            this.client.didUpdateMCPServers();
        }
        catch (error) {
            this.logger.error('Failed to notify MCP frontend client', error);
        }
    }
    readResource(serverName, resourceId) {
        const server = this.servers.get(serverName);
        if (!server) {
            throw new Error(`MCP server "${serverName}" not found.`);
        }
        return server.readResource(resourceId);
    }
    getResources(serverName) {
        const server = this.servers.get(serverName);
        if (!server) {
            throw new Error(`MCP server "${serverName}" not found.`);
        }
        return server.getResources();
    }
    setWorkspaceRoots(roots) {
        this.roots = roots;
        this.servers.forEach(server => {
            server.setWorkspaceRoots(roots);
        });
    }
};
exports.MCPServerManagerImpl = MCPServerManagerImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:MCPServerManagerImpl'),
    tslib_1.__metadata("design:type", Object)
], MCPServerManagerImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_oauth_client_provider_factory_1.MCPOAuthClientProviderFactory),
    tslib_1.__metadata("design:type", mcp_oauth_client_provider_factory_1.MCPOAuthClientProviderFactory)
], MCPServerManagerImpl.prototype, "oauthClientProviderFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_oauth_credential_store_1.MCPOAuthCredentialStore),
    tslib_1.__metadata("design:type", mcp_oauth_credential_store_1.MCPOAuthCredentialStore)
], MCPServerManagerImpl.prototype, "credentialStore", void 0);
exports.MCPServerManagerImpl = MCPServerManagerImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPServerManagerImpl);
//# sourceMappingURL=mcp-server-manager-impl.js.map