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
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
const inversify_1 = require("@theia/core/shared/inversify");
const storage_service_1 = require("@theia/core/lib/browser/storage-service");
const plugin_paths_protocol_1 = require("../../main/common/plugin-paths-protocol");
const browser_only_plugin_server_1 = require("./browser-only-plugin-server");
const navigator_locks_test_util_1 = require("./test/navigator-locks-test-util");
class InMemoryStorageService {
    constructor() {
        this.data = new Map();
    }
    async setData(key, data) {
        this.data.set(key, JSON.stringify(data));
    }
    async getData(key, defaultValue) {
        const stored = this.data.get(key);
        return stored === undefined ? defaultValue : JSON.parse(stored);
    }
}
/**
 * Stands for `@theia/workspace`'s `WorkspaceStorageService`, to which `@theia/workspace` rebinds
 * the plain `StorageService` symbol, prefixing every key with the current workspace.
 */
class PrefixingStorageService {
    constructor(delegate, prefix) {
        this.delegate = delegate;
        this.prefix = prefix;
    }
    setData(key, data) {
        return this.delegate.setData(`${this.prefix}:${key}`, data);
    }
    getData(key, defaultValue) {
        return this.delegate.getData(`${this.prefix}:${key}`, defaultValue);
    }
}
const pluginPathsService = {
    getHostLogPath: async () => '/logs/host',
    getHostStoragePath: async (workspaceUri) => workspaceUri && `/workspace-storage/${workspaceUri}`
};
/**
 * Stand-in for the browser's `LockManager`. Like the real one, it runs requests for the same
 * lock name one after another.
 */
class FakeLockManager {
    constructor() {
        this.queues = new Map();
    }
    request(name, callback) {
        const previous = this.queues.get(name) ?? Promise.resolve();
        const run = (async () => {
            await previous.catch(() => undefined);
            return callback();
        })();
        this.queues.set(name, run.catch(() => undefined));
        return run;
    }
}
/** Installs a {@link FakeLockManager} as `navigator.locks`; see {@link installNavigatorLocks}. */
function installFakeLockManager() {
    return (0, navigator_locks_test_util_1.installFakeLockManager)(new FakeLockManager());
}
describe('BrowserOnlyPluginServer', () => {
    let storageService;
    function createServer() {
        const container = new inversify_1.Container();
        container.bind(browser_only_plugin_server_1.BrowserOnlyPluginServer).toSelf().inSingletonScope();
        container.bind(core_1.ILogger).to(mock_logger_1.MockLogger);
        container.bind(storage_service_1.LocalStorageService).toConstantValue(storageService);
        container.bind(plugin_paths_protocol_1.PluginPathsService).toConstantValue(pluginPathsService);
        return container.get(browser_only_plugin_server_1.BrowserOnlyPluginServer);
    }
    beforeEach(() => {
        storageService = new InMemoryStorageService();
    });
    it('keeps global state across sessions', async () => {
        (0, chai_1.expect)(await createServer().setStorageValue('my.plugin', { count: 1 }, undefined)).to.be.true;
        // a fresh server stands for the next session, reading from the same browser storage
        (0, chai_1.expect)(await createServer().getStorageValue('my.plugin', undefined)).to.deep.equal({ count: 1 });
    });
    it('keeps global state independent of a workspace-scoped StorageService binding', async () => {
        const container = new inversify_1.Container();
        container.bind(browser_only_plugin_server_1.BrowserOnlyPluginServer).toSelf().inSingletonScope();
        container.bind(core_1.ILogger).to(mock_logger_1.MockLogger);
        container.bind(storage_service_1.LocalStorageService).toConstantValue(storageService);
        // simulates `@theia/workspace` rebinding the plain `StorageService` symbol; `BrowserOnlyPluginServer`
        // must ignore it and inject `LocalStorageService` directly, or global state would end up
        // scoped per workspace too
        container.bind(storage_service_1.StorageService).toConstantValue(new PrefixingStorageService(storageService, 'file:///a'));
        container.bind(plugin_paths_protocol_1.PluginPathsService).toConstantValue(pluginPathsService);
        const server = container.get(browser_only_plugin_server_1.BrowserOnlyPluginServer);
        await server.setStorageValue('my.plugin', { count: 1 }, undefined);
        (0, chai_1.expect)(storageService.data.has('plugin-storage:global')).to.be.true;
        (0, chai_1.expect)(storageService.data.has('file:///a:plugin-storage:global')).to.be.false;
    });
    it('keeps workspace state per workspace', async () => {
        const server = createServer();
        await server.setStorageValue('my.plugin', { count: 1 }, { workspace: 'file:///a', roots: [] });
        await server.setStorageValue('my.plugin', { count: 2 }, { workspace: 'file:///b', roots: [] });
        (0, chai_1.expect)(await server.getStorageValue('my.plugin', { workspace: 'file:///a', roots: [] })).to.deep.equal({ count: 1 });
        (0, chai_1.expect)(await server.getStorageValue('my.plugin', { workspace: 'file:///b', roots: [] })).to.deep.equal({ count: 2 });
    });
    it('keeps global and workspace state apart', async () => {
        const server = createServer();
        await server.setStorageValue('my.plugin', { scope: 'global' }, undefined);
        await server.setStorageValue('my.plugin', { scope: 'workspace' }, { workspace: 'file:///a', roots: [] });
        (0, chai_1.expect)(await server.getStorageValue('my.plugin', undefined)).to.deep.equal({ scope: 'global' });
        (0, chai_1.expect)(await server.getAllStorageValues({ workspace: 'file:///a', roots: [] })).to.deep.equal({ 'my.plugin': { scope: 'workspace' } });
    });
    it('cannot keep workspace state while no workspace is open', async () => {
        const server = createServer();
        (0, chai_1.expect)(await server.setStorageValue('my.plugin', { count: 1 }, { workspace: undefined, roots: [] })).to.be.false;
        (0, chai_1.expect)(await server.getAllStorageValues({ workspace: undefined, roots: [] })).to.deep.equal({});
    });
    it('does not drop what another host stored in the meantime', async () => {
        const one = createServer();
        // stands for another tab of the application, running its own plugin host over the same browser storage
        const other = createServer();
        await one.setStorageValue('plugin.one', { count: 1 }, undefined);
        // as the plugin host does on start up, before the other tab writes
        await one.getAllStorageValues(undefined);
        await other.setStorageValue('plugin.other', { count: 2 }, undefined);
        await one.setStorageValue('plugin.one', { count: 3 }, undefined);
        (0, chai_1.expect)(await createServer().getAllStorageValues(undefined)).to.deep.equal({
            'plugin.one': { count: 3 },
            'plugin.other': { count: 2 }
        });
    });
    describe('concurrent writes', () => {
        async function assertNeitherUpdateIsLost(one, other) {
            // start both writes before awaiting either, so they actually overlap
            await Promise.all([
                one.setStorageValue('plugin.one', { count: 1 }, undefined),
                other.setStorageValue('plugin.other', { count: 2 }, undefined)
            ]);
            (0, chai_1.expect)(await createServer().getAllStorageValues(undefined)).to.deep.equal({
                'plugin.one': { count: 1 },
                'plugin.other': { count: 2 }
            });
        }
        it('does not lose either update from two tabs, serialized via the Web Locks API', async () => {
            const restore = installFakeLockManager();
            try {
                // one server per tab, sharing the same browser storage
                await assertNeitherUpdateIsLost(createServer(), createServer());
            }
            finally {
                restore();
            }
        });
        it('does not lose either update within one tab when the Web Locks API is unavailable', async () => {
            const server = createServer();
            await assertNeitherUpdateIsLost(server, server);
        });
    });
    it('drops a value that is set to nothing', async () => {
        const server = createServer();
        await server.setStorageValue('my.plugin', { count: 1 }, undefined);
        await server.setStorageValue('my.plugin', {}, undefined);
        (0, chai_1.expect)(await createServer().getAllStorageValues(undefined)).to.deep.equal({});
    });
    it('answers with an empty value for an unknown key', async () => {
        (0, chai_1.expect)(await createServer().getStorageValue('my.plugin', undefined)).to.deep.equal({});
    });
    it('rejects changing the deployed plugins', async () => {
        const server = createServer();
        await server.install('my.plugin').then(() => chai_1.expect.fail('should have rejected'), error => (0, chai_1.expect)(error.message).to.contain('browser-only'));
        await server.uninstall('theia.a@1.0.0').then(() => chai_1.expect.fail('should have rejected'), error => (0, chai_1.expect)(error.message).to.contain('browser-only'));
        await server.enablePlugin('theia.a').then(() => chai_1.expect.fail('should have rejected'), error => (0, chai_1.expect)(error.message).to.contain('browser-only'));
        await server.disablePlugin('theia.a').then(() => chai_1.expect.fail('should have rejected'), error => (0, chai_1.expect)(error.message).to.contain('browser-only'));
    });
});
//# sourceMappingURL=browser-only-plugin-server.spec.js.map