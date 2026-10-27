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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const client_1 = require("@theia/core/shared/react-dom/client");
const react_dom_1 = require("@theia/core/shared/react-dom");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const ai_configuration_category_1 = require("@theia/ai-core-ui/lib/browser/ai-configuration/ai-configuration-category");
const mcp_servers_configuration_category_1 = require("./mcp-servers-configuration-category");
disableJSDOM();
function server(name, status, tools = []) {
    return { name, command: 'run', status, tools };
}
function createCategory(servers) {
    const category = new mcp_servers_configuration_category_1.McpServersConfigurationCategory();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    category.servers = servers;
    return category;
}
/** Renders a server's detail page into a detached host, so the read-only rows and provenance links can be inspected. */
function withServerDetail(category, serverName, assertions) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = (0, client_1.createRoot)(container);
    const ctx = { scope: 'user', navigate: () => { }, update: () => { } };
    try {
        (0, react_dom_1.flushSync)(() => root.render(category.renderItemDetail(serverName, ctx)));
        assertions(container);
    }
    finally {
        (0, react_dom_1.flushSync)(() => root.unmount());
        container.remove();
    }
}
describe('McpServersConfigurationCategory', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    it('declares the mcp-servers collection metadata', () => {
        const category = createCategory([]);
        (0, chai_1.expect)(category.id).to.equal(ai_configuration_category_1.AiConfigurationCategoryId.MCP_SERVERS);
        (0, chai_1.expect)(category.kind).to.equal('collection');
    });
    it('maps server status to a tree-item status kind', () => {
        const category = createCategory([
            server('running', mcp_server_manager_1.MCPServerStatus.Running),
            server('auth', mcp_server_manager_1.MCPServerStatus.AuthenticationRequired),
            server('errored', mcp_server_manager_1.MCPServerStatus.Errored),
            server('idle', mcp_server_manager_1.MCPServerStatus.NotRunning)
        ]);
        const children = category.getTreeChildren();
        (0, chai_1.expect)(children.map(c => c.status?.kind)).to.deep.equal(['on', 'warn', 'error', 'off']);
    });
    it('indexes each server and its tools for search, all navigating to the server', () => {
        const category = createCategory([server('git', mcp_server_manager_1.MCPServerStatus.Running, [{ name: 'commit', description: 'make a commit' }])]);
        const items = category.getSearchItems();
        (0, chai_1.expect)(items).to.have.lengthOf(2);
        (0, chai_1.expect)(items[0].target).to.deep.equal({ categoryId: ai_configuration_category_1.AiConfigurationCategoryId.MCP_SERVERS, itemId: 'git' });
        (0, chai_1.expect)(items[1].label).to.equal('commit');
        (0, chai_1.expect)(items[1].target).to.deep.equal({ categoryId: ai_configuration_category_1.AiConfigurationCategoryId.MCP_SERVERS, itemId: 'git' });
    });
    it('summarizes a server by type and tool count rather than command/url', () => {
        const category = createCategory([
            server('git', mcp_server_manager_1.MCPServerStatus.Running, [{ name: 'a' }, { name: 'b' }]),
            server('empty', mcp_server_manager_1.MCPServerStatus.NotRunning)
        ]);
        const children = category.getTreeChildren();
        (0, chai_1.expect)(children[0].description).to.equal('Local · 2 tools');
        (0, chai_1.expect)(children[1].description).to.equal('Local');
    });
    it('summarizes a remote server as Remote', () => {
        const remote = { name: 'r', serverUrl: 'https://example.com', status: mcp_server_manager_1.MCPServerStatus.Connected, tools: [] };
        (0, chai_1.expect)(createCategory([remote]).getTreeChildren()[0].description).to.equal('Remote');
    });
    it('labels the server type (Local / Remote / Remote (OAuth))', () => {
        const category = createCategory([]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const typeLabel = (server_) => category.getServerTypeLabel(server_);
        (0, chai_1.expect)(typeLabel(server('local'))).to.equal('Local');
        (0, chai_1.expect)(typeLabel({ name: 'r', serverUrl: 'https://x' })).to.equal('Remote');
        (0, chai_1.expect)(typeLabel({ name: 'o', serverUrl: 'https://x', oauth: {} })).to.equal('Remote (OAuth)');
    });
    it('persists an inline field edit by patching the form and re-saving it', () => {
        const category = createCategory([server('git', mcp_server_manager_1.MCPServerStatus.Running)]);
        const saved = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        category.serverEditor = {
            toFormData: (description) => ({
                name: description.name, serverType: 'local', command: 'old', args: '', env: '', autostart: true, deferLoading: false
            }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            save: (form) => { saved.push(form); return Promise.resolve(); }
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        category.updateServer(server('git'), { command: 'npx server' });
        (0, chai_1.expect)(saved).to.have.lengthOf(1);
        (0, chai_1.expect)(saved[0]).to.include({ name: 'git', command: 'npx server', serverType: 'local' });
    });
    describe('Agent Plugin paths', () => {
        const pluginRoot = '/home/user/.agents/plugins/io.github.acme_devtools';
        const pluginData = '/home/user/.agents/plugin-data/io.github.acme_devtools';
        const pluginServer = {
            name: 'validator',
            command: './bin/validator',
            status: mcp_server_manager_1.MCPServerStatus.NotRunning,
            cwd: pluginRoot,
            pluginRoot,
            pluginData
        };
        it('shows the working directory and the plugin roots, which the user cannot author', () => {
            withServerDetail(createCategory([pluginServer]), 'validator', host => {
                const readOnly = Array.from(host.querySelectorAll('.mcp-property-readonly')).map(node => node.textContent);
                (0, chai_1.expect)(readOnly).to.have.lengthOf(3);
                (0, chai_1.expect)(readOnly[0]).to.contain(pluginRoot);
                (0, chai_1.expect)(readOnly[1]).to.contain('PLUGIN_ROOT');
                (0, chai_1.expect)(readOnly[2]).to.contain(pluginData);
                (0, chai_1.expect)(readOnly[2]).to.contain('PLUGIN_DATA');
            });
        });
        it('shows no plugin path rows for a server the user configured by hand', () => {
            withServerDetail(createCategory([server('own', mcp_server_manager_1.MCPServerStatus.NotRunning)]), 'own', host => {
                (0, chai_1.expect)(host.querySelectorAll('.mcp-property-readonly')).to.have.lengthOf(0);
            });
        });
    });
    describe('Agent Plugin provenance', () => {
        const devtools = { pluginId: 'io.github.acme/devtools', name: 'Acme Devtools' };
        const pluginServer = {
            name: 'validator',
            command: './bin/validator',
            status: mcp_server_manager_1.MCPServerStatus.NotRunning,
            registryMetadata: { pluginId: devtools.pluginId }
        };
        /** Leaves the bridge unbound when `installedPlugins` is omitted, i.e. a product without `@theia/ai-registry`. */
        function categoryWithPlugins(servers, installedPlugins, hooks = {}) {
            const category = createCategory(servers);
            if (installedPlugins) {
                const bridge = {
                    getPlugin: pluginId => installedPlugins.find(plugin => plugin.pluginId === pluginId),
                    // Only the skills page looks a plugin up by qualifier; a server carries the identifier.
                    getPluginByQualifier: () => undefined,
                    revealPlugin: pluginId => { hooks.revealed?.push(pluginId); },
                    onDidChange: core_1.Event.None
                };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                category.agentPluginBridge = bridge;
            }
            if (hooks.openedRegistryEntries) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                category.registryBridge = {
                    openRegistry: async (serverId) => { hooks.openedRegistryEntries?.push(serverId); }
                };
            }
            return category;
        }
        const bothOrigins = { ...pluginServer, registryMetadata: { serverId: 'io.github.acme/validator', pluginId: devtools.pluginId } };
        function pluginBadge(host) {
            return host.querySelector('.ai-configuration-origin-badge[title^="Open the Agent Plugin"]');
        }
        function originLabels(category) {
            return category.getTreeChildren()[0].origins?.map(origin => origin.label);
        }
        it('labels a plugin-provided server in the list, so it is told apart without being opened', () => {
            (0, chai_1.expect)(originLabels(categoryWithPlugins([pluginServer], [devtools]))).to.deep.equal(['via Acme Devtools']);
        });
        it('labels a server that carries both a registry entry and a plugin with both origins, which lead to different places', () => {
            (0, chai_1.expect)(originLabels(categoryWithPlugins([bothOrigins], [devtools], { openedRegistryEntries: [] })))
                .to.deep.equal(['From registry', 'via Acme Devtools']);
        });
        it('labels nothing rather than a bare identifier when the owning plugin is not installed', () => {
            (0, chai_1.expect)(originLabels(categoryWithPlugins([pluginServer], []))).to.equal(undefined);
        });
        it('labels nothing when no bridge is bound, i.e. without `@theia/ai-registry`', () => {
            (0, chai_1.expect)(originLabels(categoryWithPlugins([pluginServer], undefined))).to.equal(undefined);
        });
        it('still states a registry origin without a registry UI to open, but not as a link', () => {
            // Unlike a plugin, whose display name only the bridge knows, a registry entry names itself in
            // the server's own preference entry - so the fact survives even when nothing can act on it.
            const linked = { ...pluginServer, registryMetadata: { serverId: 'io.github.acme/validator' } };
            const origins = categoryWithPlugins([linked], undefined).getTreeChildren()[0].origins;
            (0, chai_1.expect)(origins?.map(origin => origin.label)).to.deep.equal(['From registry']);
            (0, chai_1.expect)(origins[0].activate).to.equal(undefined);
        });
        it('shows the same origin badges on the detail header as in the list, rather than a second design', () => {
            const category = categoryWithPlugins([bothOrigins], [devtools], { openedRegistryEntries: [] });
            withServerDetail(category, 'validator', host => {
                const badges = Array.from(host.querySelectorAll('.ai-configuration-origin-badge')).map(badge => badge.textContent);
                (0, chai_1.expect)(badges).to.deep.equal(originLabels(category));
            });
        });
        it('reveals the owning plugin rather than a registry server when the plugin badge is clicked', () => {
            const revealed = [];
            const openedRegistryEntries = [];
            const category = categoryWithPlugins([bothOrigins], [devtools], { revealed, openedRegistryEntries });
            withServerDetail(category, 'validator', host => {
                (0, react_dom_1.flushSync)(() => pluginBadge(host).click());
            });
            (0, chai_1.expect)(revealed).to.deep.equal([devtools.pluginId]);
            (0, chai_1.expect)(openedRegistryEntries).to.be.empty;
        });
        it('shows no origin badge for a server that was not contributed by a plugin', () => {
            withServerDetail(categoryWithPlugins([server('plain-local', mcp_server_manager_1.MCPServerStatus.NotRunning)], [devtools]), 'plain-local', host => {
                (0, chai_1.expect)(host.querySelector('.ai-configuration-origin-badge')).to.be.null;
            });
        });
    });
});
//# sourceMappingURL=mcp-servers-configuration-category.spec.js.map