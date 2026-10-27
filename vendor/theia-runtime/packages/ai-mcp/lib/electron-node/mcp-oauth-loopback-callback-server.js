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
exports.MCPOAuthLoopbackCallbackServer = exports.MCP_OAUTH_CALLBACK_PORT_ENV = exports.MCP_OAUTH_DEFAULT_ELECTRON_CALLBACK_PORT = exports.MCP_OAUTH_LOOPBACK_HOST = void 0;
const tslib_1 = require("tslib");
const http = require("http");
const inversify_1 = require("@theia/core/shared/inversify");
const mcp_oauth_1 = require("../common/mcp-oauth");
const mcp_oauth_callback_responder_1 = require("../node/mcp-oauth-callback-responder");
const core_1 = require("@theia/core");
/** RFC 8252 loopback host. `127.0.0.1` (not `localhost`) so the bound address is unambiguous and unreachable off-host. */
exports.MCP_OAUTH_LOOPBACK_HOST = '127.0.0.1';
/**
 * Default port for the loopback callback server: in the registered range, below every OS ephemeral
 * range (Linux 32768+, Windows/macOS 49152+) so a fixed bind is not stolen by a transient connection,
 * and clear of well-known service/dev ports. Override via {@link MCP_OAUTH_CALLBACK_PORT_ENV}.
 * Static-`clientId` providers must register `http://127.0.0.1:<port>/mcp/oauth/callback` exactly.
 */
exports.MCP_OAUTH_DEFAULT_ELECTRON_CALLBACK_PORT = 28932;
/**
 * Environment variable overriding {@link MCP_OAUTH_DEFAULT_ELECTRON_CALLBACK_PORT}. An env var rather
 * than a preference because this runs in the backend, where the `PreferenceService` resolves only
 * schema defaults, never user-set values.
 */
exports.MCP_OAUTH_CALLBACK_PORT_ENV = 'THEIA_MCP_OAUTH_CALLBACK_PORT';
/**
 * Electron-only RFC 8252 loopback callback server, bound to `127.0.0.1` on a fixed port and separate
 * from the main backend, so it sits outside the security-token cookie middleware that would otherwise
 * `403` the cookie-less OAuth redirect. One server multiplexes all flows and frontends through the
 * shared {@link MCPOAuthCallbackResponder} (keyed by `state`), started lazily on first use and closed
 * on shutdown.
 */
let MCPOAuthLoopbackCallbackServer = class MCPOAuthLoopbackCallbackServer {
    async getRedirectUrl() {
        const port = await this.ensureServer();
        return `http://${exports.MCP_OAUTH_LOOPBACK_HOST}:${port}${mcp_oauth_1.MCP_OAUTH_CALLBACK_PATH}`;
    }
    onStop() {
        this.server?.close();
        this.server = undefined;
        this.startPromise = undefined;
    }
    ensureServer() {
        if (!this.startPromise) {
            const pending = this.startServer();
            this.startPromise = pending;
            // Clear the cache on bind failure so the next authorization retries instead of reusing the rejected promise.
            pending.catch(() => {
                if (this.startPromise === pending) {
                    this.startPromise = undefined;
                }
            });
        }
        return this.startPromise;
    }
    startServer() {
        const port = this.getConfiguredPort();
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handleRequest(req, res));
            server.on('error', error => reject(new Error(`Failed to start the MCP OAuth loopback callback server on ${exports.MCP_OAUTH_LOOPBACK_HOST}:${port}. `
                + `Set ${exports.MCP_OAUTH_CALLBACK_PORT_ENV} to a free port and register the matching redirect URI with the `
                + `OAuth provider. Cause: ${error instanceof Error ? error.message : String(error)}`)));
            // Bind 127.0.0.1 only (never 0.0.0.0) so the server is unreachable off-host.
            server.listen(port, exports.MCP_OAUTH_LOOPBACK_HOST, () => {
                this.server = server;
                resolve(server.address().port);
            });
        });
    }
    handleRequest(req, res) {
        const url = new URL(req.url ?? '/', `http://${exports.MCP_OAUTH_LOOPBACK_HOST}`);
        if (req.method !== 'GET' || url.pathname !== mcp_oauth_1.MCP_OAUTH_CALLBACK_PATH) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end('Not found');
            return;
        }
        const response = this.responder.renderResponse({
            state: url.searchParams.get('state') ?? undefined,
            code: url.searchParams.get('code') ?? undefined,
            error: url.searchParams.get('error') ?? undefined,
            errorDescription: url.searchParams.get('error_description') ?? undefined
        });
        res.writeHead(response.status, response.headers);
        res.end(response.body);
    }
    getConfiguredPort() {
        const configured = process.env[exports.MCP_OAUTH_CALLBACK_PORT_ENV];
        if (configured) {
            const parsed = Number(configured);
            if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
                return parsed;
            }
            this.logger.warn(`Ignoring invalid ${exports.MCP_OAUTH_CALLBACK_PORT_ENV}="${configured}"; expected an integer in [0, 65535]. `
                + `Falling back to ${exports.MCP_OAUTH_DEFAULT_ELECTRON_CALLBACK_PORT}.`);
        }
        return exports.MCP_OAUTH_DEFAULT_ELECTRON_CALLBACK_PORT;
    }
};
exports.MCPOAuthLoopbackCallbackServer = MCPOAuthLoopbackCallbackServer;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_oauth_callback_responder_1.MCPOAuthCallbackResponder),
    tslib_1.__metadata("design:type", mcp_oauth_callback_responder_1.MCPOAuthCallbackResponder)
], MCPOAuthLoopbackCallbackServer.prototype, "responder", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:MCPOAuthLoopbackCallbackServer'),
    tslib_1.__metadata("design:type", Object)
], MCPOAuthLoopbackCallbackServer.prototype, "logger", void 0);
exports.MCPOAuthLoopbackCallbackServer = MCPOAuthLoopbackCallbackServer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPOAuthLoopbackCallbackServer);
//# sourceMappingURL=mcp-oauth-loopback-callback-server.js.map