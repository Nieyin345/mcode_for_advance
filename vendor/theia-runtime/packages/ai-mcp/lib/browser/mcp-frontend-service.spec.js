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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const { MCPFrontendServiceImpl: MCPFrontendServiceImplConstructor, mapCallContent } = require('./mcp-frontend-service');
disableJSDOM();
class TestToolInvocationRegistry {
    constructor() {
        this.registered = [];
        this.unregisteredProviders = [];
    }
    registerTool(tool) {
        this.registered.push(tool);
    }
    unregisterAllTools(providerName) {
        this.unregisteredProviders.push(providerName);
    }
}
class TestPromptService {
    constructor() {
        this.added = [];
        this.removed = [];
    }
    addBuiltInPromptFragment(fragment) {
        this.added.push(fragment.id);
    }
    removePromptFragment(id) {
        this.removed.push(id);
    }
}
describe('MCPFrontendServiceImpl', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    let service;
    let toolRegistry;
    let promptService;
    beforeEach(() => {
        service = new MCPFrontendServiceImplConstructor();
        toolRegistry = new TestToolInvocationRegistry();
        promptService = new TestPromptService();
        service.toolInvocationRegistry = toolRegistry;
        service.promptService = promptService;
        service.mcpServerManager = {
            startServer: async () => { },
            getServerDescription: async () => ({ name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: {} }),
            hasStoredOAuthCredentials: async () => false,
            getTools: async () => ({
                tools: [{
                        name: 'create_project_confirm',
                        description: 'Create project',
                        inputSchema: { type: 'object', properties: {} }
                    }]
            })
        };
    });
    it('starts the server and registers tools', async () => {
        await service.startServer('asana');
        (0, chai_1.expect)(toolRegistry.registered.map(tool => tool.id)).to.deep.equal(['mcp_asana_create_project_confirm']);
    });
    it('unregisters existing server tools before registering current tools', async () => {
        await service.registerTools('asana');
        await service.registerTools('asana');
        (0, chai_1.expect)(toolRegistry.unregisteredProviders).to.deep.equal(['mcp_asana', 'mcp_asana']);
        (0, chai_1.expect)(promptService.removed).to.deep.equal(['mcp_asana_tools', 'mcp_asana_tools']);
        (0, chai_1.expect)(toolRegistry.registered.map(tool => tool.id)).to.deep.equal([
            'mcp_asana_create_project_confirm',
            'mcp_asana_create_project_confirm'
        ]);
    });
    describe('startServerInteractive', () => {
        // Pinning test for the widget Connect button → service → manager chain: the previous design
        // routed an explicit `preparedAuthorizationWindow=true` argument through `startServerInteractive`
        // and silently no-op'd for OAuth servers when the argument defaulted to false (the widget could
        // forget to thread it). The current design replaces that argument with the manager option
        // `{ interactive: true }` that the service ALWAYS passes — there is no way for a caller of
        // `startServerInteractive(name)` to accidentally invoke the non-interactive path. This test pins
        // that invariant so a future refactor can't reintroduce the silent-no-op regression.
        function buildServiceWithCapturingManager(captures, options = {}) {
            const target = new MCPFrontendServiceImplConstructor();
            target.toolInvocationRegistry = toolRegistry;
            target.promptService = promptService;
            target.mcpServerManager = {
                startServer: async (name, opts) => {
                    captures.startServerCalls.push({ name, options: opts });
                },
                getServerDescription: async () => ({
                    name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: {}
                }),
                getTools: async () => ({ tools: [] })
            };
            target.workspaceTrustService = {
                getWorkspaceTrust: async () => options.workspaceTrusted ?? true
            };
            target.messageService = {
                error: ((message) => { options.errorMessages?.push(String(message)); return Promise.resolve(); })
            };
            return target;
        }
        it('passes { interactive: true } to the manager for an OAuth-enabled server in a trusted workspace', async () => {
            // The widget's Connect button and the command-palette Start command both call
            // `startServerInteractive(name)` with no second argument. The service MUST always pass
            // `interactive: true` to the manager so the OAuth provider permits `redirectToAuthorization`
            // to launch the browser. The previous design relied on a `preparedAuthorizationWindow` boolean
            // argument from the caller; if the widget forgot to thread it (or it defaulted to false), the
            // service silently no-op'd for OAuth servers — a real bug fixed by anchoring the flag in the
            // service instead.
            const captures = { startServerCalls: [] };
            const target = buildServiceWithCapturingManager(captures);
            const result = await target.startServerInteractive('asana');
            (0, chai_1.expect)(result).to.be.true;
            (0, chai_1.expect)(captures.startServerCalls).to.deep.equal([{ name: 'asana', options: { interactive: true } }]);
        });
        it('returns false and surfaces an error toast when OAuth is required but workspace is untrusted', async () => {
            // The single early-return in `startServerInteractive` is the trust check; verify it produces
            // a user-visible diagnostic so the widget Connect click does not silently no-op.
            const captures = { startServerCalls: [] };
            const errorMessages = [];
            const target = buildServiceWithCapturingManager(captures, { workspaceTrusted: false, errorMessages });
            const result = await target.startServerInteractive('asana');
            (0, chai_1.expect)(result).to.be.false;
            (0, chai_1.expect)(captures.startServerCalls).to.deep.equal([]);
            (0, chai_1.expect)(errorMessages).to.have.length(1);
            (0, chai_1.expect)(errorMessages[0]).to.contain('trusted workspace');
        });
    });
    describe('signIn', () => {
        const OAUTH_DESCRIPTION = { name: 'asana', serverUrl: 'https://mcp.example.com/mcp', oauth: {} };
        function buildSignInService(options) {
            const calls = [];
            const target = new MCPFrontendServiceImplConstructor();
            target.toolInvocationRegistry = toolRegistry;
            target.promptService = promptService;
            let started = false;
            target.mcpServerManager = {
                stopServer: async (name) => { calls.push(`stop:${name}`); },
                startServer: async (name, opts) => {
                    started = true;
                    calls.push(`start:${name}:${String(!!opts?.interactive)}`);
                },
                getServerDescription: async () => started && options.description
                    ? { ...options.description, status: options.afterStartStatus }
                    : options.description
            };
            target.workspaceTrustService = {
                getWorkspaceTrust: async () => options.workspaceTrusted ?? true
            };
            target.messageService = {
                error: ((message) => { options.errorMessages?.push(String(message)); return Promise.resolve(); })
            };
            return { target, calls };
        }
        it('returns false without touching the server when the server is not OAuth-enabled', async () => {
            const { target, calls } = buildSignInService({
                description: { name: 'asana', serverUrl: 'https://mcp.example.com/mcp' }
            });
            (0, chai_1.expect)(await target.signIn('asana')).to.be.false;
            (0, chai_1.expect)(calls).to.deep.equal([]);
        });
        it('returns false and surfaces an error toast when the workspace is untrusted', async () => {
            const errorMessages = [];
            const { target, calls } = buildSignInService({
                description: OAUTH_DESCRIPTION, workspaceTrusted: false, errorMessages
            });
            (0, chai_1.expect)(await target.signIn('asana')).to.be.false;
            (0, chai_1.expect)(calls).to.deep.equal([]);
            (0, chai_1.expect)(errorMessages).to.have.length(1);
            (0, chai_1.expect)(errorMessages[0]).to.contain('trusted workspace');
        });
        it('stops, starts interactively, and stops again when the sign-in connects', async () => {
            // The leading stop cancels a stale in-flight authorization; the trailing stop leaves the
            // server offline (sign-in only stores tokens, it must not leave the server running).
            const { target, calls } = buildSignInService({
                description: OAUTH_DESCRIPTION, afterStartStatus: mcp_server_manager_1.MCPServerStatus.Connected
            });
            (0, chai_1.expect)(await target.signIn('asana')).to.be.true;
            (0, chai_1.expect)(calls).to.deep.equal(['stop:asana', 'start:asana:true', 'stop:asana']);
        });
        it('returns false without a trailing stop when the sign-in does not connect', async () => {
            const { target, calls } = buildSignInService({
                description: OAUTH_DESCRIPTION, afterStartStatus: mcp_server_manager_1.MCPServerStatus.AuthenticationRequired
            });
            (0, chai_1.expect)(await target.signIn('asana')).to.be.false;
            (0, chai_1.expect)(calls).to.deep.equal(['stop:asana', 'start:asana:true']);
        });
    });
});
describe('MCPFrontendServiceImpl html content mapping', () => {
    it('maps html content with title', () => {
        const result = mapCallContent({ type: 'html', html: '<div>App</div>', title: 'My App' });
        (0, chai_1.expect)(result).to.deep.equal({ type: 'html', html: '<div>App</div>', title: 'My App' });
    });
    it('maps html content without title', () => {
        const result = mapCallContent({ type: 'html', html: '<p>Hello</p>' });
        (0, chai_1.expect)(result).to.deep.equal({ type: 'html', html: '<p>Hello</p>', title: undefined });
    });
    it('falls back to text for unknown type without html field', () => {
        const result = mapCallContent({ type: 'unknown', data: 'foo' });
        (0, chai_1.expect)(result.type).to.equal('text');
        (0, chai_1.expect)(result.text).to.equal(JSON.stringify({ type: 'unknown', data: 'foo' }));
    });
    it('still maps text content normally', () => {
        const result = mapCallContent({ type: 'text', text: 'hello world' });
        (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: 'hello world' });
    });
    it('still maps image content normally', () => {
        const result = mapCallContent({ type: 'image', data: 'base64data', mimeType: 'image/png' });
        (0, chai_1.expect)(result).to.deep.equal({ type: 'image', base64data: 'base64data', mimeType: 'image/png' });
    });
    it('parses JSON text with type=html into an html result', () => {
        const jsonText = JSON.stringify({ type: 'html', html: '<div>Chart</div>', title: 'My Chart' });
        const result = mapCallContent({ type: 'text', text: jsonText });
        (0, chai_1.expect)(result).to.deep.equal({ type: 'html', html: '<div>Chart</div>', title: 'My Chart' });
    });
    it('does not misclassify plain JSON text without type=html', () => {
        const jsonText = JSON.stringify({ type: 'data', values: [1, 2, 3] });
        const result = mapCallContent({ type: 'text', text: jsonText });
        (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: jsonText });
    });
    it('does not misclassify text that starts with { but is not valid JSON', () => {
        const result = mapCallContent({ type: 'text', text: '{not valid json' });
        (0, chai_1.expect)(result).to.deep.equal({ type: 'text', text: '{not valid json' });
    });
    it('maps resource type to stringified text', () => {
        const result = mapCallContent({ type: 'resource', resource: { uri: 'file:///test', text: 'hello' } });
        (0, chai_1.expect)(result.type).to.equal('text');
        (0, chai_1.expect)(result.text).to.equal(JSON.stringify({ uri: 'file:///test', text: 'hello' }));
    });
});
//# sourceMappingURL=mcp-frontend-service.spec.js.map