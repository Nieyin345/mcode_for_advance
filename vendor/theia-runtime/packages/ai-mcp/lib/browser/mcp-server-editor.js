"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
exports.MCPServerEditorImpl = exports.MCPServerEditor = exports.MCPServerEditDialogFactory = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const mcp_preferences_1 = require("../common/mcp-preferences");
/**
 * Factory for the DOM-touching {@link MCPServerEditDialog}. Injected (rather than the
 * dialog module being imported directly) so the editor stays free of the Lumino widget
 * chain - keeping it loadable in Node-only unit tests - and so adopters can rebind the
 * dialog if needed.
 */
exports.MCPServerEditDialogFactory = Symbol('MCPServerEditDialogFactory');
/**
 * Owns the persistence + dialog flows for MCP servers. Lives in `@theia/ai-mcp`
 * alongside the data model so both the configuration widget (in ai-ide) and the
 * registry/URL-driven install flows (in ai-registry / ai-mcp) can share it.
 */
exports.MCPServerEditor = Symbol('MCPServerEditor');
/**
 * Default {@link MCPServerEditor} implementation. The DOM-touching `MCPServerEditDialog`
 * is created through an injected {@link MCPServerEditDialogFactory} rather than imported
 * directly, so this service stays loadable in Node-only unit tests.
 */
let MCPServerEditorImpl = class MCPServerEditorImpl {
    async openAddServer() {
        const existing = (await this.mcpFrontendService.getServerNames()) ?? [];
        const dialog = this.editDialogFactory({
            props: { title: core_1.nls.localizeByDefault('Add MCP Server'), maxWidth: 500 },
            existingServerNames: existing,
            isEditing: false
        });
        const result = await dialog.open();
        if (result) {
            await this.save(result);
        }
    }
    /**
     * Install an MCP server from a self-contained entry - used by registry install actions
     * and the `install-mcp` URL handler. Writes the config blob to `mcpServers[localName]`
     * along with registry-provenance metadata, applying any user-supplied overrides
     * collected by the install dialog.
     */
    async installFromEntry(entry, overrides) {
        const current = this.readServers();
        const stored = {
            ...entry.config,
            ...this.applyOverrides(entry.config, overrides)
        };
        const metadata = this.buildMetadata(entry);
        if (metadata) {
            stored.registryMetadata = metadata;
        }
        try {
            await this.preferenceService.set(mcp_preferences_1.MCP_SERVERS_PREF, { ...current, [entry.localName]: stored }, core_1.PreferenceScope.User);
        }
        catch (error) {
            this.messageService.error(core_1.nls.localize('theia/ai/mcpConfiguration/saveServerError', 'Failed to save MCP server configuration: {0}', String(error)));
        }
    }
    readServers() {
        return this.preferenceService.get(mcp_preferences_1.MCP_SERVERS_PREF, {}) ?? {};
    }
    /**
     * Build a `registryMetadata` block from an install entry's flat provenance fields,
     * or return undefined when the entry carries no registry link (e.g. a hand-crafted
     * `install-mcp` URL without an id).
     */
    buildMetadata(entry) {
        if (entry.serverId === undefined) {
            return undefined;
        }
        return {
            serverId: entry.serverId,
            ...(entry.version !== undefined && { version: entry.version }),
            ...(entry.configHash !== undefined && { configHash: entry.configHash })
        };
    }
    /** Merge user overrides into the config blob (only fields the dialog collects). */
    applyOverrides(config, overrides) {
        if (!overrides) {
            return {};
        }
        const merged = {};
        if (overrides.autostart !== undefined) {
            merged.autostart = overrides.autostart;
        }
        // Sanity-check: only persist a token when the config actually has the slot.
        if (overrides.serverAuthToken !== undefined && 'serverAuthToken' in config) {
            merged.serverAuthToken = overrides.serverAuthToken;
        }
        // Replace the registry's OAuth client placeholders with the user-supplied credentials,
        // keeping the registry-fixed parts (scopes, authorization server, resource) intact.
        if (config.oauth && (overrides.oauthClientId !== undefined || overrides.oauthClientSecret !== undefined)) {
            merged.oauth = {
                ...config.oauth,
                ...(overrides.oauthClientId !== undefined && { clientId: overrides.oauthClientId }),
                ...(overrides.oauthClientSecret !== undefined && { clientSecret: overrides.oauthClientSecret })
            };
        }
        return merged;
    }
    /**
     * Persist the form to the user preference. Preserves any extra fields on an existing entry
     * (e.g. `registryMetadata`) since the dialog only edits user-facing fields.
     */
    async save(formData) {
        const currentServers = this.preferenceService.get(mcp_preferences_1.MCP_SERVERS_PREF, {}) ?? {};
        const serverName = formData.name.trim();
        const existing = (currentServers[serverName] ?? {});
        const serverConfig = formData.serverType === 'local'
            ? this.toLocalConfig(formData)
            : this.toRemoteConfig(formData);
        const merged = { ...existing, ...serverConfig };
        // Preserving extra fields must not retain keys of another server type (e.g. a leftover
        // `oauth` block after switching to "Remote"), which would make the stored entry invalid.
        for (const staleKey of STALE_KEYS_BY_SERVER_TYPE[formData.serverType]) {
            delete merged[staleKey];
        }
        try {
            await this.preferenceService.set(mcp_preferences_1.MCP_SERVERS_PREF, { ...currentServers, [serverName]: merged }, core_1.PreferenceScope.User);
        }
        catch (error) {
            this.messageService.error(core_1.nls.localize('theia/ai/mcpConfiguration/saveServerError', 'Failed to save MCP server configuration: {0}', String(error)));
        }
    }
    toFormData(server) {
        if ((0, mcp_server_manager_1.isLocalMCPServerDescription)(server)) {
            return {
                name: server.name,
                serverType: 'local',
                command: server.command,
                args: server.args ?? [],
                env: server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : '',
                serverUrl: '',
                serverAuthToken: '',
                serverAuthTokenHeader: '',
                headers: '',
                oauthClientId: '',
                oauthClientSecret: '',
                oauthScopes: '',
                oauthAuthorizationServer: '',
                oauthResource: '',
                autostart: server.autostart ?? true,
                deferLoading: server.deferLoading ?? false
            };
        }
        if ((0, mcp_server_manager_1.isRemoteMCPServerDescription)(server)) {
            return {
                name: server.name,
                serverType: server.oauth ? 'remote-oauth' : 'remote',
                command: '',
                args: [],
                env: '',
                serverUrl: server.serverUrl,
                serverAuthToken: server.serverAuthToken ?? '',
                serverAuthTokenHeader: server.serverAuthTokenHeader ?? '',
                headers: server.headers
                    ? Object.entries(server.headers).map(([k, v]) => `${k}=${v}`).join('\n')
                    : '',
                oauthClientId: server.oauth?.clientId ?? '',
                oauthClientSecret: server.oauth?.clientSecret ?? '',
                oauthScopes: server.oauth?.scopes?.join(' ') ?? '',
                oauthAuthorizationServer: server.oauth?.authorizationServer ?? '',
                oauthResource: server.oauth?.resource ?? '',
                autostart: server.autostart ?? true,
                deferLoading: server.deferLoading ?? false
            };
        }
        return undefined;
    }
    toLocalConfig(formData) {
        const config = {
            command: formData.command.trim(),
            autostart: formData.autostart,
            deferLoading: formData.deferLoading
        };
        // Kept verbatim (empty entries dropped), so an argument containing a space stays one argument.
        const args = formData.args.map(argument => argument.trim()).filter(argument => argument.length > 0);
        if (args.length > 0) {
            config.args = args;
        }
        const env = parseKeyValuePairs(formData.env);
        if (env) {
            config.env = env;
        }
        return config;
    }
    toRemoteConfig(formData) {
        const config = {
            serverUrl: formData.serverUrl.trim(),
            autostart: formData.autostart,
            deferLoading: formData.deferLoading
        };
        if (formData.serverType === 'remote') {
            if (formData.serverAuthToken.trim()) {
                config.serverAuthToken = formData.serverAuthToken.trim();
            }
            if (formData.serverAuthTokenHeader.trim()) {
                config.serverAuthTokenHeader = formData.serverAuthTokenHeader.trim();
            }
        }
        const headers = parseKeyValuePairs(formData.headers);
        if (headers) {
            config.headers = headers;
        }
        const oauth = toOAuthConfig(formData);
        if (oauth) {
            config.oauth = oauth;
        }
        return config;
    }
};
exports.MCPServerEditorImpl = MCPServerEditorImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], MCPServerEditorImpl.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], MCPServerEditorImpl.prototype, "messageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPFrontendService),
    tslib_1.__metadata("design:type", Object)
], MCPServerEditorImpl.prototype, "mcpFrontendService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.MCPServerEditDialogFactory),
    tslib_1.__metadata("design:type", Function)
], MCPServerEditorImpl.prototype, "editDialogFactory", void 0);
exports.MCPServerEditorImpl = MCPServerEditorImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPServerEditorImpl);
const STALE_KEYS_BY_SERVER_TYPE = {
    'local': ['serverUrl', 'serverAuthToken', 'serverAuthTokenHeader', 'headers', 'oauth'],
    // The plugin fields go with `command`: they only mean anything for a local server, and leaving
    // them on an entry the user just turned into a remote one would keep a dead plugin root on it.
    'remote': ['command', 'args', 'env', 'cwd', 'pluginRoot', 'pluginData', 'oauth'],
    'remote-oauth': ['command', 'args', 'env', 'cwd', 'pluginRoot', 'pluginData', 'serverAuthToken', 'serverAuthTokenHeader']
};
function parseKeyValuePairs(input) {
    if (!input.trim()) {
        return undefined;
    }
    const result = {};
    for (const line of input.split('\n').filter(l => l.trim())) {
        const eqIndex = line.indexOf('=');
        if (eqIndex > 0) {
            const key = line.substring(0, eqIndex).trim();
            const value = line.substring(eqIndex + 1).trim();
            if (key) {
                result[key] = value;
            }
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
function toOAuthConfig(formData) {
    if (formData.serverType !== 'remote-oauth') {
        return undefined;
    }
    const scopes = formData.oauthScopes.trim() ? formData.oauthScopes.trim().split(/\s+/) : undefined;
    return {
        ...(formData.oauthClientId.trim() && { clientId: formData.oauthClientId.trim() }),
        ...(formData.oauthClientSecret.trim() && { clientSecret: formData.oauthClientSecret.trim() }),
        ...(scopes && { scopes }),
        ...(formData.oauthAuthorizationServer.trim() && { authorizationServer: formData.oauthAuthorizationServer.trim() }),
        ...(formData.oauthResource.trim() && { resource: formData.oauthResource.trim() })
    };
}
//# sourceMappingURL=mcp-server-editor.js.map