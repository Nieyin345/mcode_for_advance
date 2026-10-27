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
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
// Another spec in this package may have already set the configuration; mocha loads all
// specs into one process and `set` throws if called twice, so guard it.
try {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.get();
}
catch {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
}
const chai_1 = require("chai");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const window_service_1 = require("@theia/core/lib/browser/window/window-service");
const uri_1 = require("@theia/core/lib/common/uri");
const mcp_preferences_1 = require("../common/mcp-preferences");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const mcp_server_editor_1 = require("./mcp-server-editor");
const mcp_server_install_dialog_1 = require("./mcp-server-install-dialog");
const mcp_install_uri_configuration_1 = require("./mcp-install-uri-configuration");
const mcp_registry_ui_bridge_1 = require("./mcp-registry-ui-bridge");
const install_mcp_uri_handler_1 = require("./install-mcp-uri-handler");
after(() => disableJSDOM());
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
}
class FakeMessageService {
    constructor() {
        this.errors = [];
        this.infos = [];
    }
    error(message) {
        this.errors.push(message);
    }
    info(message) {
        this.infos.push(message);
    }
}
class FakeWindowService {
    constructor() {
        this.focusCount = 0;
    }
    focus() {
        this.focusCount++;
    }
}
class FakeRegistryBridge {
    constructor() {
        this.onDidChange = () => ({ dispose: () => undefined });
        this.entries = new Map();
        this.openedServerIds = [];
    }
    setEntry(serverId, entry) {
        this.entries.set(serverId, entry);
    }
    async ready() { }
    hasServer(serverId) {
        return this.entries.has(serverId);
    }
    getInstallEntry(serverId) {
        return this.entries.get(serverId);
    }
    async openRegistry(serverId) {
        this.openedServerIds.push(serverId);
    }
}
class FakeConfiguration extends mcp_install_uri_configuration_1.MCPInstallUriConfiguration {
    constructor(scheme, authority = 'install-mcp') {
        super();
        this.scheme = scheme;
        this.authority = authority;
    }
    getScheme() { return this.scheme; }
    getAuthority() { return this.authority; }
}
function buildHandler(options = {}) {
    const container = new inversify_1.Container();
    const prefs = options.prefs ?? new FakePreferenceService();
    const messages = options.messages ?? new FakeMessageService();
    const windowService = options.windowService ?? new FakeWindowService();
    container.bind(core_1.PreferenceService).toConstantValue(prefs);
    container.bind(core_1.MessageService).toConstantValue(messages);
    container.bind(window_service_1.WindowService).toConstantValue(windowService);
    container.bind(mcp_server_manager_1.MCPFrontendService).toConstantValue({});
    // The error-path tests never open a dialog; bind a factory that fails loudly if used,
    // unless a test supplies its own.
    container.bind(mcp_server_editor_1.MCPServerEditDialogFactory).toConstantValue(() => {
        throw new Error('MCPServerEditDialogFactory should not be invoked in these tests');
    });
    container.bind(mcp_server_install_dialog_1.MCPServerInstallDialogFactory).toConstantValue(options.installDialogFactory ?? (() => {
        throw new Error('MCPServerInstallDialogFactory should not be invoked in these tests');
    }));
    container.bind(mcp_server_editor_1.MCPServerEditorImpl).toSelf().inSingletonScope();
    container.bind(mcp_server_editor_1.MCPServerEditor).toService(mcp_server_editor_1.MCPServerEditorImpl);
    container.bind(mcp_install_uri_configuration_1.MCPInstallUriConfiguration).toConstantValue(new FakeConfiguration(options.scheme ?? 'theia'));
    if (options.bridge) {
        container.bind(mcp_registry_ui_bridge_1.MCPRegistryUiBridge).toConstantValue(options.bridge);
    }
    container.bind(install_mcp_uri_handler_1.InstallMcpUriHandler).toSelf().inSingletonScope();
    return { handler: container.get(install_mcp_uri_handler_1.InstallMcpUriHandler), messages, prefs, windowService, bridge: options.bridge };
}
describe('InstallMcpUriHandler.canHandle', () => {
    it('claims URIs whose scheme and authority both match the configuration', () => {
        const { handler } = buildHandler();
        (0, chai_1.expect)(handler.canHandle(new uri_1.default('theia://install-mcp?id=foo'))).to.equal(500);
    });
    it('does not claim URIs whose scheme does not match the configuration', () => {
        const { handler } = buildHandler({ scheme: 'theia-next' });
        // Configured scheme is `theia-next`; a `theia://` URI must not be claimed.
        (0, chai_1.expect)(handler.canHandle(new uri_1.default('theia://install-mcp?id=foo'))).to.equal(0);
    });
    it('does not claim URIs whose authority does not match the configuration', () => {
        const { handler } = buildHandler();
        (0, chai_1.expect)(handler.canHandle(new uri_1.default('theia://something-else?id=foo'))).to.equal(0);
    });
});
describe('InstallMcpUriHandler.open', () => {
    it('focuses the window and reports an error and does not write the preference when the URI carries no id', async () => {
        const { handler, messages, prefs, windowService } = buildHandler({ bridge: new FakeRegistryBridge() });
        await handler.open(new uri_1.default('theia://install-mcp'));
        (0, chai_1.expect)(windowService.focusCount).to.equal(1);
        (0, chai_1.expect)(messages.errors).to.have.length(1);
        (0, chai_1.expect)(messages.errors[0]).to.match(/missing the required "id"/i);
        (0, chai_1.expect)(prefs.get(mcp_preferences_1.MCP_SERVERS_PREF)).to.be.undefined;
    });
    it('reports an error when no AI registry bridge is bound', async () => {
        const { handler, messages } = buildHandler(); // no bridge
        await handler.open(new uri_1.default('theia://install-mcp?id=io.example/foo'));
        (0, chai_1.expect)(messages.errors).to.have.length(1);
        (0, chai_1.expect)(messages.errors[0]).to.match(/no AI registry is configured/i);
    });
    it('reports an error when the registry has no entry for the given id', async () => {
        const bridge = new FakeRegistryBridge();
        // Bridge has no entries - `getInstallEntry` returns undefined.
        const { handler, messages } = buildHandler({ bridge });
        await handler.open(new uri_1.default('theia://install-mcp?id=io.example/unknown'));
        (0, chai_1.expect)(messages.errors).to.have.length(1);
        (0, chai_1.expect)(messages.errors[0]).to.match(/is not listed in your AI registry/i);
        (0, chai_1.expect)(bridge.openedServerIds).to.be.empty;
    });
    it('trims whitespace around the id parameter and treats an empty id as missing', async () => {
        const { handler, messages } = buildHandler({ bridge: new FakeRegistryBridge() });
        await handler.open(new uri_1.default('theia://install-mcp?id=%20%20'));
        (0, chai_1.expect)(messages.errors[0]).to.match(/missing the required "id"/i);
    });
    it('focuses the window, reveals the registry search for the id, then opens the install dialog for a known id', async () => {
        const bridge = new FakeRegistryBridge();
        bridge.setEntry('io.example/foo', { localName: 'foo', config: { command: 'npx', args: [] }, serverId: 'io.example/foo' });
        let dialogOpened = false;
        // Cancel the dialog (open resolves undefined) so the test stops before the actual install.
        const installDialogFactory = (() => ({
            open: async () => { dialogOpened = true; return undefined; }
        }));
        const { handler, windowService } = buildHandler({ bridge, installDialogFactory });
        await handler.open(new uri_1.default('theia://install-mcp?id=io.example/foo'));
        (0, chai_1.expect)(windowService.focusCount).to.equal(1);
        // The registry view is revealed and the id searched before the install dialog opens.
        (0, chai_1.expect)(bridge.openedServerIds).to.deep.equal(['io.example/foo']);
        (0, chai_1.expect)(dialogOpened).to.be.true;
    });
});
//# sourceMappingURL=install-mcp-uri-handler.spec.js.map