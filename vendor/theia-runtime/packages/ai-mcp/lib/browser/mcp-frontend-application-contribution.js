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
exports.McpFrontendApplicationContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../common");
const mcp_preferences_1 = require("../common/mcp-preferences");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const core_1 = require("@theia/core");
const nls_1 = require("@theia/core/lib/common/nls");
const workspace_trust_service_1 = require("@theia/workspace/lib/browser/workspace-trust-service");
const workspace_service_1 = require("@theia/workspace/lib/browser/workspace-service");
const mcp_server_preference_validator_1 = require("../common/mcp-server-preference-validator");
let McpFrontendApplicationContribution = class McpFrontendApplicationContribution {
    constructor() {
        this.prevServers = new Map();
        this.blockedUntrustedServers = new Set();
        this.serverChangeQueue = Promise.resolve();
        /** Pending OAuth sign-in prompts, keyed by server name. */
        this.pendingSignInPrompts = new Map();
    }
    onStart() {
        // Preflight the backend→frontend RPC channel for OAuth callbacks so a wiring failure surfaces
        // at startup rather than at the first OAuth flow. Failures are logged but not propagated.
        this.oauthFrontendDelegate.getCallbackUrl().catch(error => this.logger.warn('MCP OAuth duplex-channel preflight failed; OAuth callbacks may not work until reconnect.', error));
        this.mcpNotificationService.onDidUpdateMCPServers(() => {
            this.dismissSettledSignInPrompts().catch(error => this.logger.error('Failed to dismiss settled MCP OAuth sign-in prompts', error));
        });
        this.preferenceService.ready.then(async () => {
            const servers = (0, mcp_server_preference_validator_1.filterValidValues)(this.preferenceService.get(mcp_preferences_1.MCP_SERVERS_PREF, {}));
            this.prevServers = this.convertToMap(servers);
            await this.syncServers(this.prevServers);
            // Set up workspace roots tracking
            await this.updateWorkspaceRoots(false);
            this.workspaceService.onWorkspaceChanged(async () => {
                await this.updateWorkspaceRoots(false);
            });
            await this.autoStartServers(this.prevServers);
            this.preferenceService.onPreferenceChanged(async (event) => {
                if (event.preferenceName === mcp_preferences_1.MCP_SERVERS_PREF) {
                    this.enqueueServerChanges((0, mcp_server_preference_validator_1.filterValidValues)(this.preferenceService.get(mcp_preferences_1.MCP_SERVERS_PREF, {})));
                }
                if (event.preferenceName === mcp_preferences_1.MCP_USE_WORKSPACE_AS_ROOT_PREF) {
                    await this.updateWorkspaceRoots(true);
                }
            });
            this.workspaceTrustService.onDidChangeWorkspaceTrust(async (trusted) => {
                try {
                    if (trusted) {
                        await this.startPreviouslyBlockedServers();
                    }
                    else {
                        await this.stopAllServers();
                    }
                }
                catch (error) {
                    this.logger.error('Failed to handle workspace trust change for MCP servers', error);
                }
            });
        });
    }
    async updateWorkspaceRoots(restart) {
        const startedServerNames = await this.frontendMCPService.getStartedServers();
        if (restart) {
            // stop all servers
            for (const name of startedServerNames) {
                await this.frontendMCPService.stopServer(name);
            }
        }
        // update the roots
        // either roots are supported or not
        const useWorkspaceAsRoot = this.preferenceService.get(mcp_preferences_1.MCP_USE_WORKSPACE_AS_ROOT_PREF, true);
        if (!useWorkspaceAsRoot) {
            this.manager.setWorkspaceRoots(undefined);
        }
        else {
            const roots = this.workspaceService.tryGetRoots().map(root => root.resource.toString());
            this.manager.setWorkspaceRoots(roots);
        }
        if (restart) {
            // restart servers
            for (const name of startedServerNames) {
                await this.frontendMCPService.startServer(name).catch(error => {
                    this.logger.error(`Failed to restart MCP server ${name} after changing workspace root setting`, error);
                });
            }
        }
    }
    async startPreviouslyBlockedServers() {
        if (this.blockedUntrustedServers.size === 0) {
            return;
        }
        const startedServers = await this.frontendMCPService.getStartedServers();
        for (const name of this.blockedUntrustedServers) {
            const serverDesc = this.prevServers.get(name);
            if (serverDesc && serverDesc.autostart && !startedServers.includes(name)) {
                await this.attemptSilentStartOrPromptForOAuth(name, serverDesc);
            }
        }
        this.blockedUntrustedServers.clear();
        this.updateBlockedServersStatusBar();
    }
    async stopAllServers() {
        // Walk active servers (not just running ones) so a server in `Starting`, `Connecting`, or
        // `AuthenticationRequired` at the moment trust is lost is also interrupted.
        // Use `Promise.allSettled` so one hanging server's stop does not prevent the others from
        // being stopped during the untrusted-workspace transition.
        const activeServers = await this.frontendMCPService.getActiveServers();
        const results = await Promise.allSettled(activeServers.map(name => this.frontendMCPService.stopServer(name)));
        results.forEach((result, index) => {
            const name = activeServers[index];
            if (result.status === 'rejected') {
                this.logger.error(`Failed to stop MCP server "${name}" on workspace-trust loss`, result.reason);
                // Skip blocked-set bookkeeping for servers we could not actually stop.
                return;
            }
            const serverDesc = this.prevServers.get(name);
            if (serverDesc?.autostart) {
                this.blockedUntrustedServers.add(name);
            }
        });
        this.updateBlockedServersStatusBar();
    }
    updateBlockedServersStatusBar() {
        this.workspaceTrustService.refreshRestrictedModeIndicator();
    }
    getRestrictions() {
        if (this.blockedUntrustedServers.size === 0) {
            return [];
        }
        return [{
                label: nls_1.nls.localize('theia/ai/mcp/blockedServersLabel', 'MCP Servers (autostart blocked)'),
                details: Array.from(this.blockedUntrustedServers)
            }];
    }
    async autoStartServers(servers) {
        const startedServers = await this.frontendMCPService.getStartedServers();
        const isTrusted = await this.workspaceTrustService.getWorkspaceTrust();
        for (const [name, serverDesc] of servers) {
            if (serverDesc && serverDesc.autostart) {
                if (!startedServers.includes(name)) {
                    // Block MCP autostart in untrusted workspaces to prevent interaction with malicious content.
                    if (!isTrusted) {
                        this.blockedUntrustedServers.add(name);
                        continue;
                    }
                    await this.attemptSilentStartOrPromptForOAuth(name, serverDesc);
                }
            }
        }
        this.updateBlockedServersStatusBar();
    }
    /**
     * Autostart path for a single server. For non-OAuth servers, just calls `startServer`. For OAuth
     * servers, either skips the silent start when no usable credentials exist (and prompts the user)
     * or attempts the silent start; if the silent start lands in `AuthenticationRequired`, prompts
     * the user via a notification with a Sign In action.
     */
    async attemptSilentStartOrPromptForOAuth(name, serverDesc) {
        const isOAuthServer = (0, common_1.isRemoteMCPServerDescription)(serverDesc) && !!serverDesc.oauth;
        if (isOAuthServer && !await this.frontendMCPService.hasStoredOAuthCredentials(name)) {
            // No usable stored credentials — skip the silent attempt and prompt directly.
            this.promptForOAuthSignIn(name);
            return;
        }
        await this.frontendMCPService.startServer(name);
        if (isOAuthServer) {
            const description = await this.frontendMCPService.getServerDescription(name);
            if (description?.status === common_1.MCPServerStatus.AuthenticationRequired) {
                this.promptForOAuthSignIn(name);
            }
        }
    }
    /**
     * Prompts the user to authorize the given MCP server via a non-modal notification with a 'Sign In'
     * action. Dismissed automatically once the start attempt concludes, see {@link dismissSettledSignInPrompts}.
     */
    promptForOAuthSignIn(serverName) {
        this.pendingSignInPrompts.get(serverName)?.cancel();
        const signInAction = nls_1.nls.localizeByDefault('Sign In');
        this.messageService.showProgress({
            text: nls_1.nls.localize('theia/ai/mcp/oauth/notification/signInPrompt', 'MCP server "{0}" requires authorization to start.', serverName),
            actions: [signInAction],
            options: { cancelable: true }
        }).then(progress => {
            this.pendingSignInPrompts.set(serverName, progress);
            return progress.result.then(action => {
                if (this.pendingSignInPrompts.get(serverName) === progress) {
                    this.pendingSignInPrompts.delete(serverName);
                }
                if (action !== signInAction) {
                    return undefined;
                }
                return this.frontendMCPService.startServerInteractive(serverName);
            });
        }).catch(error => {
            this.logger.error(`Failed to drive OAuth sign-in prompt for MCP server "${serverName}"`, error);
        });
    }
    /** Dismisses sign-in prompts whose server was removed or whose start attempt has concluded. */
    async dismissSettledSignInPrompts() {
        for (const [name, prompt] of Array.from(this.pendingSignInPrompts.entries())) {
            const description = await this.frontendMCPService.getServerDescription(name);
            const status = description?.status;
            if (!description || status === common_1.MCPServerStatus.Connected || status === common_1.MCPServerStatus.Running || status === common_1.MCPServerStatus.Errored) {
                this.pendingSignInPrompts.delete(name);
                prompt.cancel();
            }
        }
    }
    enqueueServerChanges(newServers) {
        this.serverChangeQueue = this.serverChangeQueue
            .then(() => this.handleServerChanges(newServers))
            .catch(error => {
            // Catch here (instead of propagating) so a single failed change does not poison the queue.
            this.logger.error('Failed to handle MCP server preference changes', error);
            this.messageService.warn(nls_1.nls.localize('theia/ai/mcp/warn/serverPreferenceChangeFailed', 'Failed to apply MCP server preference changes: {0}', error instanceof Error ? error.message : String(error)));
        });
    }
    async handleServerChanges(newServers) {
        const oldServers = this.prevServers;
        const updatedServers = this.convertToMap(newServers);
        for (const [name] of oldServers) {
            if (!updatedServers.has(name)) {
                await this.manager.removeServer(name);
                this.blockedUntrustedServers.delete(name);
            }
        }
        for (const [name, description] of updatedServers) {
            const oldDescription = oldServers.get(name);
            let diff = false;
            try {
                // We know that that the descriptions are actual JSONObjects as we construct them ourselves
                if (!oldDescription || !core_1.PreferenceUtils.deepEqual(oldDescription, description)) {
                    diff = true;
                }
            }
            catch (e) {
                // In some cases the deepEqual function throws an error, so we fall back to assuming that there is a difference
                // This seems to happen in cases where the objects are structured differently, e.g. whole sub-objects are missing
                this.logger.debug('Failed to compare MCP server descriptions, assuming a difference', e);
                diff = true;
            }
            if (diff) {
                await this.manager.addOrUpdateServer(description);
            }
        }
        this.prevServers = updatedServers;
        await this.autoStartServers(updatedServers);
    }
    async syncServers(servers) {
        // Initial sync only: `prevServers` is assigned to the same map immediately before this call, so a
        // remove-pass would compare the map against itself and never iterate. Server removals on subsequent
        // preference changes are handled by `handleServerChanges`, which holds onto the previous map.
        for (const [, description] of servers) {
            await this.manager.addOrUpdateServer(description);
        }
    }
    convertToMap(servers) {
        const map = new Map();
        Object.entries(servers).forEach(([name, description]) => {
            let filteredDescription;
            const { registryMetadata } = description;
            if ('serverUrl' in description) {
                // Create RemoteMCPServerDescription by picking only remote-specific properties
                const { serverUrl, serverAuthToken, serverAuthTokenHeader, headers, oauth, autostart, deferLoading } = description;
                filteredDescription = {
                    name,
                    serverUrl,
                    ...(serverAuthToken && { serverAuthToken }),
                    ...(serverAuthTokenHeader && { serverAuthTokenHeader }),
                    ...(headers && { headers }),
                    ...(oauth && { oauth }),
                    autostart: autostart ?? true,
                    ...(registryMetadata && { registryMetadata }),
                    ...(deferLoading !== undefined && { deferLoading }),
                };
            }
            else {
                // Create LocalMCPServerDescription by picking only local-specific properties
                const { command, args, env, cwd, pluginRoot, pluginData, autostart, deferLoading } = description;
                filteredDescription = {
                    name,
                    command,
                    ...(args && { args }),
                    ...(env && { env }),
                    ...(cwd && { cwd }),
                    ...(pluginRoot && { pluginRoot }),
                    ...(pluginData && { pluginData }),
                    autostart: autostart ?? true,
                    ...(registryMetadata && { registryMetadata }),
                    ...(deferLoading !== undefined && { deferLoading }),
                };
            }
            map.set(name, filteredDescription);
        });
        return map;
    }
};
exports.McpFrontendApplicationContribution = McpFrontendApplicationContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], McpFrontendApplicationContribution.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MCPServerManager),
    tslib_1.__metadata("design:type", Object)
], McpFrontendApplicationContribution.prototype, "manager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPFrontendService),
    tslib_1.__metadata("design:type", Object)
], McpFrontendApplicationContribution.prototype, "frontendMCPService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_trust_service_1.WorkspaceTrustService),
    tslib_1.__metadata("design:type", workspace_trust_service_1.WorkspaceTrustService)
], McpFrontendApplicationContribution.prototype, "workspaceTrustService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:McpFrontendApplicationContribution'),
    tslib_1.__metadata("design:type", Object)
], McpFrontendApplicationContribution.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_service_1.WorkspaceService),
    tslib_1.__metadata("design:type", workspace_service_1.WorkspaceService)
], McpFrontendApplicationContribution.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], McpFrontendApplicationContribution.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MCPOAuthFrontendDelegate),
    tslib_1.__metadata("design:type", Object)
], McpFrontendApplicationContribution.prototype, "oauthFrontendDelegate", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPFrontendNotificationService),
    tslib_1.__metadata("design:type", Object)
], McpFrontendApplicationContribution.prototype, "mcpNotificationService", void 0);
exports.McpFrontendApplicationContribution = McpFrontendApplicationContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], McpFrontendApplicationContribution);
//# sourceMappingURL=mcp-frontend-application-contribution.js.map