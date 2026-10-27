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
const mcp_server_manager_impl_1 = require("./mcp-server-manager-impl");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
describe('MCPServerManagerImpl OAuth cleanup', () => {
    it('stops a running server before clearing OAuth credentials', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => true,
            isStopped: () => false,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.signOut('asana');
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'clear']);
    });
    it('stops the server and notifies clients on stopServer', async () => {
        // Cancellation of an in-flight OAuth flow is now MCPServer.stop()'s responsibility (via
        // authProvider.cancel()); the manager only orchestrates stop + notify.
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            stop: async () => { calls.push('stop'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {};
        const client = { onDidUpdateMCPServers: () => ({ dispose: () => { } }), didUpdateMCPServers: () => { calls.push('notify'); } };
        manager.setClient(client);
        await manager.stopServer('asana');
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'notify']);
    });
    it('still notifies clients when stopping a server fails', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            stop: async () => { calls.push('stop'); throw new Error('transport hung'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {};
        const client = { onDidUpdateMCPServers: () => ({ dispose: () => { } }), didUpdateMCPServers: () => { calls.push('notify'); } };
        manager.setClient(client);
        try {
            await manager.stopServer('asana');
            throw new Error('Expected stopServer to propagate stop failure');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal('transport hung');
        }
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'notify']);
    });
    it('stops every managed server when the frontend disconnects', async () => {
        // Server.stop() now cancels its own in-flight OAuth flow; the manager just iterates and stops.
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const client = { onDidUpdateMCPServers: () => ({ dispose: () => { } }), didUpdateMCPServers: () => { } };
        const server = {
            stop: async () => { calls.push('stop'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {};
        manager.setClient(client);
        manager.disconnectClient(client);
        await Promise.resolve();
        (0, chai_1.expect)(calls).to.deep.equal(['stop']);
    });
    it('clears OAuth credentials when removing a server after stopping it', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            stop: async () => { calls.push('stop'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.removeServer('asana');
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'clear']);
    });
    it('still clears OAuth credentials and removes the server when stopping it fails', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            stop: async () => { calls.push('stop'); throw new Error('transport hung'); }
        };
        const servers = new Map([
            ['asana', server]
        ]);
        manager.servers = servers;
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.removeServer('asana');
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'clear']);
        (0, chai_1.expect)(servers.has('asana')).to.be.false;
    });
    it('does not stop a running server for non-connection preference changes', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => true,
            isStopped: () => false,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', autostart: true }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.addOrUpdateServer({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', autostart: false });
        (0, chai_1.expect)(calls).to.deep.equal(['update']);
    });
    describe('an Agent Plugin server', () => {
        const pluginServer = (overrides = {}) => ({
            name: 'bigquery',
            command: 'node',
            args: ['server.js'],
            cwd: '/home/u/.agents/plugins/acme_bq',
            pluginRoot: '/home/u/.agents/plugins/acme_bq',
            pluginData: '/home/u/.agents/plugin-data/acme_bq',
            autostart: true,
            registryMetadata: { pluginId: 'io.github.acme/bq', configHash: 'h1', installedAt: '2026-08-17T10:00:00.000Z' },
            ...overrides
        });
        async function apply(next) {
            const calls = [];
            const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
            const server = {
                isRunning: () => true,
                isStopped: () => false,
                isInFlight: () => false,
                stop: async () => { calls.push('stop'); },
                getCachedDescription: () => pluginServer(),
                update: () => { calls.push('update'); },
                setWorkspaceRoots: () => { },
                onDidUpdateStatus: () => ({ dispose: () => { } })
            };
            manager.servers = new Map([
                ['bigquery', server]
            ]);
            manager.credentialStore = { clear: async () => { } };
            await manager.addOrUpdateServer(next);
            return calls;
        }
        it('restarts when the plugin was re-installed, even though its own configuration is identical', async () => {
            // An update or a Fix deletes and re-creates the very directory the child is working in while
            // changing nothing the server declared. Without a restart the process keeps running against
            // a root that no longer exists.
            const reinstalled = { ...pluginServer().registryMetadata, installedAt: '2026-08-17T12:00:00.000Z' };
            (0, chai_1.expect)(await apply(pluginServer({ registryMetadata: reinstalled }))).to.deep.equal(['stop', 'update']);
        });
        it('restarts when the working directory or either plugin path changes, because all three reach the process', async () => {
            (0, chai_1.expect)(await apply(pluginServer({ cwd: '/somewhere/else' }))).to.deep.equal(['stop', 'update']);
            (0, chai_1.expect)(await apply(pluginServer({ pluginRoot: '/other/root' }))).to.deep.equal(['stop', 'update']);
            (0, chai_1.expect)(await apply(pluginServer({ pluginData: '/other/data' }))).to.deep.equal(['stop', 'update']);
        });
        it('does not restart when nothing that reaches the process changed', async () => {
            (0, chai_1.expect)(await apply(pluginServer())).to.deep.equal(['update']);
            (0, chai_1.expect)(await apply(pluginServer({ autostart: false }))).to.deep.equal(['update']);
        });
    });
    it('restarts a running server for connection preference changes', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => true,
            isStopped: () => false,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', headers: { old: 'header' } }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.addOrUpdateServer({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', headers: { new: 'header' } });
        // cancel is now MCPServer.stop()'s responsibility; the manager only orchestrates stop + update.
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'update']);
    });
    it('clears credentials when OAuth client scope changes for a stopped server', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => false,
            isStopped: () => true,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({
                name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: { clientId: 'old', scopes: ['old'] }
            }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.addOrUpdateServer({
            name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: { clientId: 'new', scopes: ['new'] }
        });
        (0, chai_1.expect)(calls).to.deep.equal(['clear', 'update']);
    });
    it('clears credentials when OAuth client scope changes', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => true,
            isStopped: () => false,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({
                name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: { clientId: 'old', scopes: ['old'] }
            }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.addOrUpdateServer({
            name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: { clientId: 'new', scopes: ['new'] }
        });
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'clear', 'update']);
    });
    it('stops a running server and clears credentials before disabling OAuth', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => true,
            isStopped: () => false,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: {} }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.addOrUpdateServer({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp' });
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'clear', 'update']);
    });
    it('clears OAuth credentials when a resolve() rewrites the credential scope on startServer', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const initialDescription = {
            name: 'asana',
            serverUrl: 'https://mcp.example.com/mcp',
            oauth: { clientId: 'old', scopes: ['old'] },
            // resolve mixed in by getDescription path; the rewrite changes the credential scope.
            resolve: async () => ({
                name: 'asana',
                serverUrl: 'https://mcp.example.com/mcp',
                oauth: { clientId: 'new', scopes: ['new'] }
            })
        };
        const server = {
            isRunning: () => false,
            stop: async () => { calls.push('stop'); },
            start: async () => { calls.push('start'); },
            getDescription: async () => initialDescription,
            update: () => { calls.push('update'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.startServer('asana');
        // clear must run before update so the previous scope's credentials are wiped before the new
        // scope-keyed credential lookups happen during server.start().
        (0, chai_1.expect)(calls).to.deep.equal(['clear', 'update', 'start']);
    });
    it('does not re-update or clear when resolve() returns the same configuration during startServer', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const sameConfiguration = {
            name: 'asana',
            serverUrl: 'https://mcp.example.com/mcp',
            oauth: { clientId: 'static' }
        };
        const server = {
            isRunning: () => false,
            stop: async () => { calls.push('stop'); },
            start: async () => { calls.push('start'); },
            // getDescription mixes in runtime status/tools/error fields; resolve() must still be considered
            // equivalent because only configuration fields are compared.
            getDescription: async () => ({
                ...sameConfiguration,
                status: 'Not Connected',
                tools: [],
                resolve: async () => ({ ...sameConfiguration })
            }),
            update: () => { calls.push('update'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.startServer('asana');
        (0, chai_1.expect)(calls).to.deep.equal(['start']);
    });
    it('does not re-update when resolve() returns the same configuration with reordered properties', async () => {
        // Order-independent equality is the reason we use deepEqual instead of JSON.stringify in
        // haveSameConfiguration: a user-authored resolve() implementation should be free to construct
        // the returned object in any insertion order without triggering a needless update() that would
        // reset this.status and clear this.error.
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => false,
            stop: async () => { calls.push('stop'); },
            start: async () => { calls.push('start'); },
            getDescription: async () => ({
                name: 'asana',
                serverUrl: 'https://mcp.example.com/mcp',
                autostart: true,
                oauth: { clientId: 'static', scopes: ['mcp.read'] },
                resolve: async () => ({
                    // Same fields, different insertion order. JSON.stringify would compare unequal.
                    oauth: { scopes: ['mcp.read'], clientId: 'static' },
                    autostart: true,
                    serverUrl: 'https://mcp.example.com/mcp',
                    name: 'asana'
                })
            }),
            update: () => { calls.push('update'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.startServer('asana');
        (0, chai_1.expect)(calls).to.deep.equal(['start']);
    });
    it('does not restart a running server when an update leaves the oauth configuration unchanged', async () => {
        // `connectionDescription` projects the oauth object by presence: an identical oauth block must
        // compare equal so a no-op preference write does not bounce the connection.
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => true,
            isStopped: () => false,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({
                name: 'asana',
                serverUrl: 'https://mcp.example.com/mcp',
                oauth: { clientId: 'static' }
            }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        // Only the non-connection `autostart` field changes; the oauth block is identical.
        await manager.addOrUpdateServer({
            name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: { clientId: 'static' }, autostart: false
        });
        (0, chai_1.expect)(calls).to.deep.equal(['update']);
    });
    it('restarts a running server when an oauth block is added (presence enables OAuth)', async () => {
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => true,
            isStopped: () => false,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp' }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.addOrUpdateServer({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: {} });
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'update']);
    });
    it('stops an in-flight server (AuthenticationRequired) before applying a connection-affecting update', async () => {
        // An edit landing while AuthenticationRequired must trigger cancel + stop, otherwise the in-flight
        // doStart continues on the OLD URL while reads see the NEW one. Only `!isStopped()` catches this state.
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => false,
            isStopped: () => false,
            isInFlight: () => true,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: {} }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        // The user changes serverUrl while mid sign-in. The connection projection differs (the URL
        // changed), so stop must run before update. cancel of the in-flight OAuth is now MCPServer.stop()'s
        // responsibility, observed at the unit level via authProvider.cancel() in the MCPServer spec.
        await manager.addOrUpdateServer({ name: 'asana', serverUrl: 'https://mcp.example.com/other', oauth: {} });
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'clear', 'update']);
    });
    it('does not stop an in-flight server when only non-connection fields change', async () => {
        // Companion case: leave the in-flight doStart alone; new description's non-connection fields apply next start.
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => false,
            isStopped: () => false,
            isInFlight: () => true,
            stop: async () => { calls.push('stop'); },
            getCachedDescription: () => ({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', autostart: true }),
            update: () => { calls.push('update'); },
            setWorkspaceRoots: () => { },
            onDidUpdateStatus: () => ({ dispose: () => { } })
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        // Only `autostart` changes — not a connection-projection field.
        await manager.addOrUpdateServer({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', autostart: false });
        (0, chai_1.expect)(calls).to.deep.equal(['update']);
    });
    it('signOut isolates credential cleanup and client notification from a failing stop()', async () => {
        // A failing stop() must not block credential wipe or UI refresh.
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => true,
            isStopped: () => false,
            isInFlight: () => false,
            stop: async () => { calls.push('stop'); throw new Error('transport hung'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        const client = { onDidUpdateMCPServers: () => ({ dispose: () => { } }), didUpdateMCPServers: () => { calls.push('notify'); } };
        manager.setClient(client);
        await manager.signOut('asana');
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'clear', 'notify']);
    });
    it('signOut stops an in-flight (AuthenticationRequired) server and clears credentials', async () => {
        // `!isStopped()` (rather than `isRunning()`) so an AuthenticationRequired sign-out drops the
        // in-flight handshake along with the stored tokens, not just the tokens.
        const calls = [];
        const manager = new mcp_server_manager_impl_1.MCPServerManagerImpl();
        manager.logger = new mock_logger_1.MockLogger();
        const server = {
            isRunning: () => false,
            isStopped: () => false,
            isInFlight: () => true,
            stop: async () => { calls.push('stop'); }
        };
        manager.servers = new Map([
            ['asana', server]
        ]);
        manager.credentialStore = {
            clear: async () => { calls.push('clear'); }
        };
        await manager.signOut('asana');
        (0, chai_1.expect)(calls).to.deep.equal(['stop', 'clear']);
    });
});
//# sourceMappingURL=mcp-server-manager-impl.spec.js.map