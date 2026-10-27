"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const disposable_1 = require("@theia/core/lib/common/disposable");
const plugin_protocol_1 = require("../../common/plugin-protocol");
const hosted_plugin_1 = require("./hosted-plugin");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
/* eslint-disable @typescript-eslint/no-explicit-any */
function createMockDeployedPlugin(id, untrustedWorkspacesSupport) {
    return {
        metadata: {
            host: 'main',
            model: {
                id,
                name: id.split('.')[1] || id,
                publisher: id.split('.')[0] || 'test',
                version: '1.0.0',
                displayName: id,
                description: '',
                engine: { type: 'theiaPlugin', version: '1.0.0' },
                entryPoint: { backend: 'main.js' },
                packageUri: '',
                packagePath: '',
                untrustedWorkspacesSupport
            },
            lifecycle: { startMethod: 'activate', stopMethod: 'deactivate' },
            outOfSync: false
        }
    };
}
function createNoopMeasurement() {
    return {
        stop: () => 0,
        name: 'test',
        log: () => { },
        debug: () => { },
        info: () => { },
        warn: () => { },
        error: () => { }
    };
}
/**
 * Minimal concrete subclass of AbstractHostedPluginSupport for testing.
 * Overrides all abstract methods with no-ops/stubs.
 */
class TestHostedPluginSupport extends hosted_plugin_1.AbstractHostedPluginSupport {
    constructor() {
        super('test-client');
        this.logger = new mock_logger_1.MockLogger();
    }
    createTheiaReadyPromise() {
        return Promise.resolve();
    }
    acceptPlugin(_plugin) {
        return true;
    }
    handleContributions(_plugin) {
        return disposable_1.Disposable.NULL;
    }
    async obtainManager(_host, _hostContributions, _toDisconnect) {
        return undefined;
    }
    async getStoragePath() {
        return undefined;
    }
    async getHostGlobalStoragePath() {
        return '';
    }
    measure(_name) {
        return createNoopMeasurement();
    }
    /**
     * Populate the contributions map with mock deployed plugins in the given state.
     */
    addPlugin(plugin, state = hosted_plugin_1.PluginContributions.State.INITIALIZING) {
        const pluginId = plugin_protocol_1.PluginIdentifiers.componentsToUnversionedId(plugin.metadata.model);
        const contributions = new hosted_plugin_1.PluginContributions(plugin);
        contributions.state = state;
        this.contributions.set(pluginId, contributions);
    }
    /**
     * Expose the protected loadContributions for testing.
     */
    testLoadContributions() {
        const toDisconnect = new disposable_1.DisposableCollection(disposable_1.Disposable.create(() => { }));
        return this.loadContributions(toDisconnect);
    }
    setWorkspaceTrusted(trusted) {
        this.workspaceTrusted = trusted;
    }
    clearDisabledByTrust() {
        this._disabledByTrust.clear();
    }
    simulateLoadCycle() {
        this._disabledByTrust.clear();
        const result = this.testLoadContributions();
        if (this._disabledByTrust.size > 0) {
            this.onDidChangePluginsEmitter.fire(undefined);
        }
        return result;
    }
}
describe('AbstractHostedPluginSupport - workspace trust filtering', () => {
    let support;
    beforeEach(() => {
        support = new TestHostedPluginSupport();
    });
    it('should skip plugin with untrustedWorkspacesSupport: false when workspace is untrusted', () => {
        support.setWorkspaceTrusted(false);
        const plugin = createMockDeployedPlugin('test.untrusted-false', false);
        support.addPlugin(plugin);
        const result = support.testLoadContributions();
        // Plugin should not be in the returned host contributions
        let pluginFound = false;
        for (const contributions of result.values()) {
            for (const c of contributions) {
                if (c.plugin.metadata.model.id === 'test.untrusted-false') {
                    pluginFound = true;
                }
            }
        }
        (0, chai_1.expect)(pluginFound).to.equal(false);
        (0, chai_1.expect)(support.disabledByTrust.has('test.untrusted-false')).to.equal(true);
    });
    it('should load plugin with untrustedWorkspacesSupport: true when workspace is untrusted', () => {
        support.setWorkspaceTrusted(false);
        const plugin = createMockDeployedPlugin('test.untrusted-true', true);
        support.addPlugin(plugin);
        const result = support.testLoadContributions();
        let pluginFound = false;
        for (const contributions of result.values()) {
            for (const c of contributions) {
                if (c.plugin.metadata.model.id === 'test.untrusted-true') {
                    pluginFound = true;
                }
            }
        }
        (0, chai_1.expect)(pluginFound).to.equal(true);
        (0, chai_1.expect)(support.disabledByTrust.has('test.untrusted-true')).to.equal(false);
    });
    it('should load plugin with untrustedWorkspacesSupport: "limited" when workspace is untrusted', () => {
        support.setWorkspaceTrusted(false);
        const plugin = createMockDeployedPlugin('test.untrusted-limited', 'limited');
        support.addPlugin(plugin);
        const result = support.testLoadContributions();
        let pluginFound = false;
        for (const contributions of result.values()) {
            for (const c of contributions) {
                if (c.plugin.metadata.model.id === 'test.untrusted-limited') {
                    pluginFound = true;
                }
            }
        }
        (0, chai_1.expect)(pluginFound).to.equal(true);
        (0, chai_1.expect)(support.disabledByTrust.has('test.untrusted-limited')).to.equal(false);
    });
    it('should load plugin with untrustedWorkspacesSupport: undefined when workspace is untrusted', () => {
        support.setWorkspaceTrusted(false);
        const plugin = createMockDeployedPlugin('test.untrusted-undefined', undefined);
        support.addPlugin(plugin);
        const result = support.testLoadContributions();
        let pluginFound = false;
        for (const contributions of result.values()) {
            for (const c of contributions) {
                if (c.plugin.metadata.model.id === 'test.untrusted-undefined') {
                    pluginFound = true;
                }
            }
        }
        (0, chai_1.expect)(pluginFound).to.equal(true);
        (0, chai_1.expect)(support.disabledByTrust.has('test.untrusted-undefined')).to.equal(false);
    });
    it('should load plugin with untrustedWorkspacesSupport: false when workspace is trusted', () => {
        support.setWorkspaceTrusted(true);
        const plugin = createMockDeployedPlugin('test.trusted-false', false);
        support.addPlugin(plugin);
        const result = support.testLoadContributions();
        let pluginFound = false;
        for (const contributions of result.values()) {
            for (const c of contributions) {
                if (c.plugin.metadata.model.id === 'test.trusted-false') {
                    pluginFound = true;
                }
            }
        }
        (0, chai_1.expect)(pluginFound).to.equal(true);
        (0, chai_1.expect)(support.disabledByTrust.has('test.trusted-false')).to.equal(false);
    });
    it('should clear disabledByTrust when workspace becomes trusted on re-load', () => {
        // First load: untrusted workspace, plugin should be disabled
        support.setWorkspaceTrusted(false);
        const plugin = createMockDeployedPlugin('test.reload-trust', false);
        support.addPlugin(plugin);
        support.testLoadContributions();
        (0, chai_1.expect)(support.disabledByTrust.has('test.reload-trust')).to.equal(true);
        (0, chai_1.expect)(support.disabledByTrust.size).to.equal(1);
        // Second load: simulate doLoad() which clears disabledByTrust before loadContributions
        support.setWorkspaceTrusted(true);
        support.clearDisabledByTrust();
        support.testLoadContributions();
        (0, chai_1.expect)(support.disabledByTrust.size).to.equal(0);
    });
    it('should correctly populate disabledByTrust with only filtered plugins', () => {
        support.setWorkspaceTrusted(false);
        const blockedPlugin = createMockDeployedPlugin('test.blocked', false);
        const allowedPlugin = createMockDeployedPlugin('test.allowed', true);
        support.addPlugin(blockedPlugin);
        support.addPlugin(allowedPlugin);
        support.testLoadContributions();
        (0, chai_1.expect)(support.disabledByTrust.size).to.equal(1);
        (0, chai_1.expect)(support.disabledByTrust.has('test.blocked')).to.equal(true);
        (0, chai_1.expect)(support.disabledByTrust.has('test.allowed')).to.equal(false);
    });
    describe('plugins deployed after initial load (re-load cycle)', () => {
        it('should disable a newly deployed plugin with untrustedWorkspacesSupport: false on re-load', () => {
            support.setWorkspaceTrusted(false);
            const initialPlugin = createMockDeployedPlugin('test.initial', false);
            support.addPlugin(initialPlugin);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.has('test.initial')).to.equal(true);
            const newPlugin = createMockDeployedPlugin('test.new-deploy', false);
            support.addPlugin(newPlugin);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.has('test.initial')).to.equal(true);
            (0, chai_1.expect)(support.disabledByTrust.has('test.new-deploy')).to.equal(true);
            (0, chai_1.expect)(support.disabledByTrust.size).to.equal(2);
        });
        it('should re-add previously disabled plugins to disabledByTrust on each re-load cycle', () => {
            support.setWorkspaceTrusted(false);
            const plugin = createMockDeployedPlugin('test.persistent', false);
            support.addPlugin(plugin);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.has('test.persistent')).to.equal(true);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.has('test.persistent')).to.equal(true);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.has('test.persistent')).to.equal(true);
        });
        it('should not add already-started allowed plugins to disabledByTrust on re-load', () => {
            support.setWorkspaceTrusted(false);
            const startedAllowed = createMockDeployedPlugin('test.started-allowed', true);
            support.addPlugin(startedAllowed, hosted_plugin_1.PluginContributions.State.STARTED);
            const startedUndefined = createMockDeployedPlugin('test.started-undefined', undefined);
            support.addPlugin(startedUndefined, hosted_plugin_1.PluginContributions.State.STARTED);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.has('test.started-allowed')).to.equal(false);
            (0, chai_1.expect)(support.disabledByTrust.has('test.started-undefined')).to.equal(false);
            (0, chai_1.expect)(support.disabledByTrust.size).to.equal(0);
        });
        it('should add already-started plugins with untrustedWorkspacesSupport: false to disabledByTrust on re-load', () => {
            support.setWorkspaceTrusted(false);
            const startedBlocked = createMockDeployedPlugin('test.started-blocked', false);
            support.addPlugin(startedBlocked, hosted_plugin_1.PluginContributions.State.STARTED);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.has('test.started-blocked')).to.equal(true);
        });
        it('should fire onDidChangePlugins after loadContributions when a newly deployed plugin is disabled by trust', () => {
            support.setWorkspaceTrusted(false);
            const existingPlugin = createMockDeployedPlugin('test.existing', false);
            support.addPlugin(existingPlugin);
            support.simulateLoadCycle();
            const newPlugin = createMockDeployedPlugin('test.late-deploy', false);
            support.addPlugin(newPlugin);
            let eventFiredCount = 0;
            support.onDidChangePlugins(() => { eventFiredCount++; });
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.has('test.late-deploy')).to.equal(true);
            (0, chai_1.expect)(eventFiredCount).to.equal(1);
        });
        it('should not fire onDidChangePlugins when no plugins are disabled by trust', () => {
            support.setWorkspaceTrusted(false);
            const allowedPlugin = createMockDeployedPlugin('test.allowed-nodeploy', true);
            support.addPlugin(allowedPlugin);
            let eventFiredCount = 0;
            support.onDidChangePlugins(() => { eventFiredCount++; });
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.size).to.equal(0);
            (0, chai_1.expect)(eventFiredCount).to.equal(0);
        });
        it('should include both initial and newly deployed disabled plugins in disabledByTrust when workspace is untrusted', () => {
            support.setWorkspaceTrusted(false);
            const builtin = createMockDeployedPlugin('test.builtin', false);
            support.addPlugin(builtin);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.size).to.equal(1);
            const userInstalled = createMockDeployedPlugin('test.user-installed', false);
            support.addPlugin(userInstalled);
            support.simulateLoadCycle();
            (0, chai_1.expect)(support.disabledByTrust.size).to.equal(2);
            (0, chai_1.expect)(support.disabledByTrust.has('test.builtin')).to.equal(true);
            (0, chai_1.expect)(support.disabledByTrust.has('test.user-installed')).to.equal(true);
        });
    });
});
//# sourceMappingURL=hosted-plugin.spec.js.map