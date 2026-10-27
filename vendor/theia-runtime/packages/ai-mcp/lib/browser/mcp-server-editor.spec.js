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
const chai_1 = require("chai");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const mcp_preferences_1 = require("../common/mcp-preferences");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const mcp_server_editor_1 = require("./mcp-server-editor");
class FakePreferenceService {
    constructor() {
        this.store = new Map();
    }
    get(key, defaultValue) {
        return (this.store.has(key) ? this.store.get(key) : defaultValue);
    }
    async set(key, value) {
        this.store.set(key, value);
    }
    snapshot(key) {
        return this.store.get(key);
    }
}
describe('MCPServerEditor.installFromEntry', () => {
    let prefs;
    let editor;
    beforeEach(() => {
        const container = new inversify_1.Container();
        prefs = new FakePreferenceService();
        container.bind(core_1.PreferenceService).toConstantValue(prefs);
        container.bind(core_1.MessageService).toConstantValue({ error: () => undefined });
        container.bind(mcp_server_manager_1.MCPFrontendService).toConstantValue({});
        // installFromEntry never opens a dialog; bind a factory that fails loudly if it is used.
        container.bind(mcp_server_editor_1.MCPServerEditDialogFactory).toConstantValue(() => {
            throw new Error('MCPServerEditDialogFactory should not be invoked in these tests');
        });
        container.bind(mcp_server_editor_1.MCPServerEditorImpl).toSelf().inSingletonScope();
        editor = container.get(mcp_server_editor_1.MCPServerEditorImpl);
    });
    it('writes the config blob under entry.localName and tags it with registry metadata', async () => {
        const entry = {
            localName: 'example',
            config: { command: 'npx', args: ['-y', 'example-mcp'] },
            serverId: 'io.github.example/example-mcp',
            version: '^1.0.0',
            configHash: 'hash-v1'
        };
        await editor.installFromEntry(entry);
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            example: {
                command: 'npx',
                args: ['-y', 'example-mcp'],
                registryMetadata: {
                    serverId: 'io.github.example/example-mcp',
                    version: '^1.0.0',
                    configHash: 'hash-v1'
                }
            }
        });
    });
    it('omits registryMetadata when the entry carries no serverId - keeps the preference free of registry-link traces for URL-driven installs', async () => {
        const entry = {
            localName: 'example',
            config: { command: 'npx', args: ['-y', 'example-mcp'] }
        };
        await editor.installFromEntry(entry);
        const stored = prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF).example;
        (0, chai_1.expect)(stored).to.not.have.property('registryMetadata');
    });
    it('omits optional metadata fields the entry does not carry while keeping the required serverId', async () => {
        const entry = {
            localName: 'example',
            config: { command: 'npx', args: ['-y', 'example-mcp'] },
            serverId: 'io.github.example/example-mcp'
        };
        await editor.installFromEntry(entry);
        const stored = prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF).example;
        (0, chai_1.expect)(stored.registryMetadata).to.deep.equal({ serverId: 'io.github.example/example-mcp' });
    });
    it('applies the autostart override the dialog collected', async () => {
        const entry = {
            localName: 'example',
            config: { command: 'npx', args: ['-y', 'example-mcp'] }
        };
        await editor.installFromEntry(entry, { autostart: false });
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF).example.autostart).to.equal(false);
    });
    it('fills serverAuthToken when the entry config advertises the slot - even if the slot was empty', async () => {
        const entry = {
            localName: 'example',
            config: { serverUrl: 'https://example.com/mcp', serverAuthToken: '' }
        };
        await editor.installFromEntry(entry, { serverAuthToken: 'secret-123' });
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF).example.serverAuthToken).to.equal('secret-123');
    });
    it('ignores serverAuthToken when the entry config does not advertise the slot - avoids leaking it onto local entries', async () => {
        const entry = {
            localName: 'example',
            // No `serverAuthToken` key - entry is local stdio.
            config: { command: 'npx', args: ['-y', 'example-mcp'] }
        };
        await editor.installFromEntry(entry, { serverAuthToken: 'should-be-ignored' });
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF).example).to.not.have.property('serverAuthToken');
    });
    it('fills the OAuth client credentials while keeping the registry-fixed OAuth parts', async () => {
        const entry = {
            localName: 'example',
            config: {
                serverUrl: 'https://mcp.example.com/mcp',
                oauth: { clientId: '<clientId>', clientSecret: '<clientSecret>', resource: 'https://mcp.example.com' }
            }
        };
        await editor.installFromEntry(entry, { oauthClientId: 'real-id', oauthClientSecret: 'real-secret' });
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF).example.oauth).to.deep.equal({
            clientId: 'real-id',
            clientSecret: 'real-secret',
            resource: 'https://mcp.example.com'
        });
    });
    it('ignores OAuth credentials when the entry config does not advertise an oauth block', async () => {
        const entry = {
            localName: 'example',
            config: { command: 'npx', args: ['-y', 'example-mcp'] }
        };
        await editor.installFromEntry(entry, { oauthClientId: 'should-be-ignored', oauthClientSecret: 'should-be-ignored' });
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF).example).to.not.have.property('oauth');
    });
    it('preserves unrelated servers already in the preference', async () => {
        await prefs.set(mcp_preferences_1.MCP_SERVERS_PREF, {
            other: { command: 'node', args: ['unrelated.js'] }
        });
        const entry = {
            localName: 'example',
            config: { command: 'npx', args: ['-y', 'example-mcp'] }
        };
        await editor.installFromEntry(entry);
        const all = prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF);
        (0, chai_1.expect)(Object.keys(all).sort()).to.deep.equal(['example', 'other']);
        (0, chai_1.expect)(all.other).to.deep.equal({ command: 'node', args: ['unrelated.js'] });
    });
});
describe('MCPServerEditor OAuth form handling', () => {
    let prefs;
    let editor;
    beforeEach(() => {
        const container = new inversify_1.Container();
        prefs = new FakePreferenceService();
        container.bind(core_1.PreferenceService).toConstantValue(prefs);
        container.bind(core_1.MessageService).toConstantValue({ error: () => undefined });
        container.bind(mcp_server_manager_1.MCPFrontendService).toConstantValue({});
        container.bind(mcp_server_editor_1.MCPServerEditDialogFactory).toConstantValue(() => {
            throw new Error('MCPServerEditDialogFactory should not be invoked in these tests');
        });
        container.bind(mcp_server_editor_1.MCPServerEditorImpl).toSelf().inSingletonScope();
        editor = container.get(mcp_server_editor_1.MCPServerEditorImpl);
    });
    function localFormData(overrides) {
        return { ...remoteFormData({}), name: 'local-server', serverType: 'local', command: 'node', serverUrl: '', ...overrides };
    }
    it('stores each argument verbatim, so one containing a space stays a single argument', async () => {
        await editor.save(localFormData({ args: ['--root', '/home/me/My Documents', '--verbose'] }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)['local-server'].args)
            .to.deep.equal(['--root', '/home/me/My Documents', '--verbose']);
    });
    it('drops blank arguments rather than writing empty strings', async () => {
        await editor.save(localFormData({ args: ['--root', '   ', ''] }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)['local-server'].args).to.deep.equal(['--root']);
    });
    function remoteFormData(overrides) {
        return {
            name: 'oauth-server',
            serverType: 'remote',
            command: '',
            args: [],
            env: '',
            serverUrl: 'https://mcp.example.com/mcp',
            serverAuthToken: '',
            serverAuthTokenHeader: '',
            headers: '',
            oauthClientId: '',
            oauthClientSecret: '',
            oauthScopes: '',
            oauthAuthorizationServer: '',
            oauthResource: '',
            autostart: false,
            deferLoading: false,
            ...overrides
        };
    }
    it('persists OAuth fields for a remote MCP server', async () => {
        await editor.save(remoteFormData({
            serverType: 'remote-oauth',
            oauthClientId: 'client-id',
            oauthClientSecret: 'client-secret',
            oauthScopes: 'mcp.read mcp.write',
            oauthAuthorizationServer: 'https://auth.example.com',
            oauthResource: 'https://mcp.example.com/mcp'
        }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: false,
                deferLoading: false,
                oauth: {
                    clientId: 'client-id',
                    clientSecret: 'client-secret',
                    scopes: ['mcp.read', 'mcp.write'],
                    authorizationServer: 'https://auth.example.com',
                    resource: 'https://mcp.example.com/mcp'
                }
            }
        });
    });
    it('omits OAuth config when token authentication is selected even if OAuth fields are populated', async () => {
        await editor.save(remoteFormData({
            serverType: 'remote',
            oauthClientId: 'client-id',
            oauthClientSecret: 'client-secret',
            oauthScopes: 'mcp.read mcp.write',
            oauthAuthorizationServer: 'https://auth.example.com',
            oauthResource: 'https://mcp.example.com/mcp'
        }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: false,
                deferLoading: false
            }
        });
    });
    it('does not persist auth token fields when OAuth authentication is selected', async () => {
        await editor.save(remoteFormData({
            serverType: 'remote-oauth',
            serverAuthToken: 'stale-token',
            serverAuthTokenHeader: 'X-Auth'
        }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: false,
                deferLoading: false,
                oauth: {}
            }
        });
    });
    it('drops the stored oauth block when an OAuth server is switched to token authentication', async () => {
        await prefs.set(mcp_preferences_1.MCP_SERVERS_PREF, {
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: false,
                oauth: { clientId: 'client-id' },
                registryMetadata: { serverId: 'io.github.example/example-mcp' }
            }
        });
        await editor.save(remoteFormData({ serverType: 'remote', serverAuthToken: 'token-123' }));
        // Extra fields like registryMetadata survive the edit, but the oauth block of the previous
        // server type must not - a retained oauth key would conflict with the new token.
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: false,
                deferLoading: false,
                serverAuthToken: 'token-123',
                registryMetadata: { serverId: 'io.github.example/example-mcp' }
            }
        });
    });
    it('drops stale token fields when a token server is switched to OAuth', async () => {
        await prefs.set(mcp_preferences_1.MCP_SERVERS_PREF, {
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: false,
                serverAuthToken: 'old-token',
                serverAuthTokenHeader: 'X-Auth'
            }
        });
        await editor.save(remoteFormData({ serverType: 'remote-oauth', oauthClientId: 'client-id' }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: false,
                deferLoading: false,
                oauth: { clientId: 'client-id' }
            }
        });
    });
    it('drops remote-only fields when a remote OAuth server is switched to a local command', async () => {
        await prefs.set(mcp_preferences_1.MCP_SERVERS_PREF, {
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: false,
                oauth: { clientId: 'client-id' },
                headers: { 'X-Custom': 'value' }
            }
        });
        await editor.save(remoteFormData({ serverType: 'local', command: 'npx' }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            'oauth-server': {
                command: 'npx',
                autostart: false,
                deferLoading: false
            }
        });
    });
    it('preserves the Agent Plugin fields of a local server, which the dialog never edits', async () => {
        await prefs.set(mcp_preferences_1.MCP_SERVERS_PREF, {
            'oauth-server': {
                command: 'node',
                cwd: '/plugins/io.example_bq',
                pluginRoot: '/plugins/io.example_bq',
                pluginData: '/plugin-data/io.example_bq',
                registryMetadata: { pluginId: 'io.example/bq' }
            }
        });
        await editor.save(remoteFormData({ serverType: 'local', command: 'node', args: ['server.js'], autostart: true }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            'oauth-server': {
                command: 'node',
                args: ['server.js'],
                cwd: '/plugins/io.example_bq',
                pluginRoot: '/plugins/io.example_bq',
                pluginData: '/plugin-data/io.example_bq',
                autostart: true,
                deferLoading: false,
                registryMetadata: { pluginId: 'io.example/bq' }
            }
        });
    });
    it('drops the Agent Plugin fields when a local plugin server is switched to remote', async () => {
        await prefs.set(mcp_preferences_1.MCP_SERVERS_PREF, {
            'oauth-server': {
                command: 'node',
                cwd: '/plugins/io.example_bq',
                pluginRoot: '/plugins/io.example_bq',
                pluginData: '/plugin-data/io.example_bq'
            }
        });
        await editor.save(remoteFormData({ serverType: 'remote', autostart: true }));
        (0, chai_1.expect)(prefs.snapshot(mcp_preferences_1.MCP_SERVERS_PREF)).to.deep.equal({
            'oauth-server': {
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: true,
                deferLoading: false
            }
        });
    });
    it('pre-populates OAuth fields when converting a remote server to form data', () => {
        const server = {
            name: 'oauth-server',
            serverUrl: 'https://mcp.example.com/mcp',
            oauth: {
                clientId: 'client-id',
                clientSecret: 'client-secret',
                scopes: ['mcp.read', 'mcp.write'],
                authorizationServer: 'https://auth.example.com',
                resource: 'https://mcp.example.com/mcp'
            }
        };
        const formData = editor.toFormData(server);
        (0, chai_1.expect)(formData).to.deep.include({
            name: 'oauth-server',
            serverType: 'remote-oauth',
            serverUrl: 'https://mcp.example.com/mcp',
            oauthClientId: 'client-id',
            oauthClientSecret: 'client-secret',
            oauthScopes: 'mcp.read mcp.write',
            oauthAuthorizationServer: 'https://auth.example.com',
            oauthResource: 'https://mcp.example.com/mcp'
        });
    });
});
//# sourceMappingURL=mcp-server-editor.spec.js.map