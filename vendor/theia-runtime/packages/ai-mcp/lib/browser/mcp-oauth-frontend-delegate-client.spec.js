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
const core_1 = require("@theia/core");
const mcp_oauth_frontend_delegate_client_1 = require("./mcp-oauth-frontend-delegate-client");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
disableJSDOM();
describe('MCPOAuthFrontendDelegateClientImpl', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    function createClient(openCalls = [], options = {}) {
        const client = new mcp_oauth_frontend_delegate_client_1.MCPOAuthFrontendDelegateClientImpl();
        client.logger = new mock_logger_1.MockLogger();
        const windowService = {
            openNewWindow(url, options2) {
                openCalls.push({ url, external: options2?.external });
                return undefined;
            }
        };
        client.windowService = windowService;
        const messageService = {
            // Mirrors the real toast: the result only settles when the user picks an action.
            showProgress: async (message) => {
                const action = options.onShowProgress?.(message);
                return {
                    id: 'test-progress',
                    report: () => { },
                    cancel: () => options.onPromptCancel?.(message),
                    result: action !== undefined ? Promise.resolve(action) : new Promise(() => { })
                };
            }
        };
        client.messageService = messageService;
        const serverUpdateEmitter = options.serverUpdateEmitter ?? new core_1.Emitter();
        client.mcpNotificationService = {
            onDidUpdateMCPServers: serverUpdateEmitter.event,
            didUpdateMCPServers: () => serverUpdateEmitter.fire()
        };
        // `@postConstruct` only runs under an inversify container; wire the subscription manually.
        client.init();
        return client;
    }
    async function flushToastHandlers() {
        // openExternal resolves before the toast promise chain runs; flush the microtask chain.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }
    describe('getCallbackUrl', () => {
        it('creates callback URLs at the origin root', async () => {
            window.history.pushState(undefined, '', '/');
            (0, chai_1.expect)(await createClient().getCallbackUrl()).to.equal('http://localhost/mcp/oauth/callback');
        });
        it('preserves the browser pathname base for reverse-proxy deployments', async () => {
            window.history.pushState(undefined, '', '/theia/');
            (0, chai_1.expect)(await createClient().getCallbackUrl()).to.equal('http://localhost/theia/mcp/oauth/callback');
        });
        it('preserves an extension-less browser pathname base', async () => {
            window.history.pushState(undefined, '', '/theia');
            (0, chai_1.expect)(await createClient().getCallbackUrl()).to.equal('http://localhost/theia/mcp/oauth/callback');
        });
    });
    describe('openExternal', () => {
        it('launches the URL via WindowService.openNewWindow with external: true', async () => {
            // `external: true` routes to `shell.openExternal` in Electron and to a popup in browser. The
            // delegate-client doesn't differentiate between deployments here: the backend's OAuth provider
            // already gated the call via its `interactive` flag (autostart's non-interactive provider
            // rejects authorization before reaching this method).
            const openCalls = [];
            const client = createClient(openCalls);
            await client.openExternal('https://auth.example.com/authorize?state=abc&code_challenge=xyz');
            (0, chai_1.expect)(openCalls).to.deep.equal([{ url: 'https://auth.example.com/authorize?state=abc&code_challenge=xyz', external: true }]);
        });
        it('re-opens the sign-in URL when the user clicks the popup-blocked fallback toast action', async () => {
            // The RPC-initiated window.open carries no user activation and may be popup-blocked (undetectable
            // with 'noopener'); the toast action click carries fresh activation.
            const openCalls = [];
            let prompt;
            const client = createClient(openCalls, {
                onShowProgress: message => {
                    prompt = message;
                    return 'Open';
                }
            });
            await client.openExternal('https://auth.example.com/authorize?state=abc');
            await flushToastHandlers();
            (0, chai_1.expect)(prompt?.text).to.contain('browser may have blocked');
            (0, chai_1.expect)(prompt?.actions).to.deep.equal(['Open']);
            // The user must be able to dismiss the toast manually; progress notifications have no close button.
            (0, chai_1.expect)(prompt?.options?.cancelable).to.be.true;
            (0, chai_1.expect)(openCalls).to.deep.equal([
                { url: 'https://auth.example.com/authorize?state=abc', external: true },
                { url: 'https://auth.example.com/authorize?state=abc', external: true }
            ]);
        });
        it('does not re-open the sign-in URL when the fallback toast is dismissed', async () => {
            const openCalls = [];
            const client = createClient(openCalls, {
                onShowProgress: () => undefined
            });
            await client.openExternal('https://auth.example.com/authorize');
            await flushToastHandlers();
            (0, chai_1.expect)(openCalls).to.have.length(1);
        });
        it('dismisses the fallback toast when an MCP server update arrives', async () => {
            // A server update after the sign-in page was opened means the OAuth flow progressed (the user
            // completed or aborted the sign-in), so the toast is no longer relevant.
            const cancelled = [];
            const serverUpdateEmitter = new core_1.Emitter();
            const client = createClient([], {
                onShowProgress: () => undefined,
                onPromptCancel: message => cancelled.push(message),
                serverUpdateEmitter
            });
            await client.openExternal('https://auth.example.com/authorize');
            await flushToastHandlers();
            (0, chai_1.expect)(cancelled).to.deep.equal([]);
            serverUpdateEmitter.fire();
            (0, chai_1.expect)(cancelled).to.have.length(1);
            (0, chai_1.expect)(cancelled[0].text).to.contain('browser may have blocked');
        });
        it('does not require any prepare / arm step before the call', async () => {
            // The simplified design has no `prepareAuthorizationSync` / `armInteractiveAuthorization` step
            // on the delegate-client. The interactive gating lives in the backend OAuth provider's
            // `interactive` flag, not as runtime state on the delegate.
            const client = createClient();
            // Two consecutive calls work without any setup between them.
            await client.openExternal('https://auth.example.com/first');
            await client.openExternal('https://auth.example.com/second');
        });
    });
});
//# sourceMappingURL=mcp-oauth-frontend-delegate-client.spec.js.map