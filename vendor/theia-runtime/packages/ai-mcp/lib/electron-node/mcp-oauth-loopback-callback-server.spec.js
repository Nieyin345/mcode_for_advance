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
const http = require("http");
const mock_logger_1 = require("@theia/core/lib/common/test/mock-logger");
const mcp_oauth_callback_service_1 = require("../node/mcp-oauth-callback-service");
const mcp_oauth_callback_responder_1 = require("../node/mcp-oauth-callback-responder");
const mcp_oauth_loopback_callback_server_1 = require("./mcp-oauth-loopback-callback-server");
class TestableMCPOAuthLoopbackCallbackServer extends mcp_oauth_loopback_callback_server_1.MCPOAuthLoopbackCallbackServer {
    getConfiguredPort() {
        return this.portOverride ?? super.getConfiguredPort();
    }
    configuredPort() {
        return this.getConfiguredPort();
    }
    boundAddress() {
        return this.server?.address();
    }
}
function createServer() {
    const callbackService = new mcp_oauth_callback_service_1.MCPOAuthCallbackService();
    const responder = new mcp_oauth_callback_responder_1.MCPOAuthCallbackResponder();
    responder.callbackService = callbackService;
    const server = new TestableMCPOAuthLoopbackCallbackServer();
    server.responder = responder;
    server.logger = new mock_logger_1.MockLogger();
    // Bind an OS-assigned port to avoid clashing with the fixed default port in CI.
    server.portOverride = 0;
    return { server, callbackService };
}
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        }).on('error', reject);
    });
}
describe('MCPOAuthLoopbackCallbackServer', () => {
    describe('server', () => {
        let server;
        let callbackService;
        beforeEach(() => {
            ({ server, callbackService } = createServer());
        });
        afterEach(() => {
            server.onStop();
        });
        it('binds 127.0.0.1 and advertises the loopback callback URL on the bound port', async () => {
            const redirectUrl = await server.getRedirectUrl();
            const address = server.boundAddress();
            (0, chai_1.expect)(address?.address).to.equal(mcp_oauth_loopback_callback_server_1.MCP_OAUTH_LOOPBACK_HOST);
            (0, chai_1.expect)(redirectUrl).to.equal(`http://${mcp_oauth_loopback_callback_server_1.MCP_OAUTH_LOOPBACK_HOST}:${address?.port}/mcp/oauth/callback`);
        });
        it('dispatches a GET with state+code to the callback service and renders the done page', async () => {
            const base = await server.getRedirectUrl();
            const state = callbackService.createState();
            const pending = callbackService.waitForCallback(state);
            const response = await httpGet(`${base}?state=${encodeURIComponent(state)}&code=authorization-code`);
            (0, chai_1.expect)(response.status).to.equal(200);
            (0, chai_1.expect)(response.body).to.contain('All done. You can close this tab now.');
            (0, chai_1.expect)(response.headers['content-security-policy']).to.equal("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
            (0, chai_1.expect)(response.headers['cache-control']).to.equal('no-store');
            const callback = await pending;
            (0, chai_1.expect)(callback.code).to.equal('authorization-code');
        });
        it('renders the generic rejection page for a bogus state', async () => {
            const base = await server.getRedirectUrl();
            const response = await httpGet(`${base}?state=bogus-state&code=authorization-code`);
            (0, chai_1.expect)(response.status).to.equal(400);
            (0, chai_1.expect)(response.body).to.contain('Unknown or expired OAuth state.');
        });
        it('returns 404 for a request that is not the OAuth callback path', async () => {
            const base = await server.getRedirectUrl();
            const origin = new URL(base);
            const response = await httpGet(`http://${mcp_oauth_loopback_callback_server_1.MCP_OAUTH_LOOPBACK_HOST}:${origin.port}/not/the/callback`);
            (0, chai_1.expect)(response.status).to.equal(404);
        });
    });
    describe('getConfiguredPort', () => {
        const originalEnv = process.env[mcp_oauth_loopback_callback_server_1.MCP_OAUTH_CALLBACK_PORT_ENV];
        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env[mcp_oauth_loopback_callback_server_1.MCP_OAUTH_CALLBACK_PORT_ENV];
            }
            else {
                process.env[mcp_oauth_loopback_callback_server_1.MCP_OAUTH_CALLBACK_PORT_ENV] = originalEnv;
            }
        });
        it('returns the fixed default port when the environment variable is unset', () => {
            delete process.env[mcp_oauth_loopback_callback_server_1.MCP_OAUTH_CALLBACK_PORT_ENV];
            const server = new TestableMCPOAuthLoopbackCallbackServer();
            server.logger = new mock_logger_1.MockLogger();
            (0, chai_1.expect)(server.configuredPort()).to.equal(mcp_oauth_loopback_callback_server_1.MCP_OAUTH_DEFAULT_ELECTRON_CALLBACK_PORT);
        });
        it('honors a valid environment-variable override', () => {
            process.env[mcp_oauth_loopback_callback_server_1.MCP_OAUTH_CALLBACK_PORT_ENV] = '40123';
            const server = new TestableMCPOAuthLoopbackCallbackServer();
            server.logger = new mock_logger_1.MockLogger();
            (0, chai_1.expect)(server.configuredPort()).to.equal(40123);
        });
        it('falls back to the default for an invalid environment-variable value', () => {
            process.env[mcp_oauth_loopback_callback_server_1.MCP_OAUTH_CALLBACK_PORT_ENV] = 'not-a-port';
            const server = new TestableMCPOAuthLoopbackCallbackServer();
            server.logger = new mock_logger_1.MockLogger();
            (0, chai_1.expect)(server.configuredPort()).to.equal(mcp_oauth_loopback_callback_server_1.MCP_OAUTH_DEFAULT_ELECTRON_CALLBACK_PORT);
        });
    });
});
//# sourceMappingURL=mcp-oauth-loopback-callback-server.spec.js.map