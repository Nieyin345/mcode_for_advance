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
exports.MCPOAuthCallbackResponder = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const nls_1 = require("@theia/core/lib/common/nls");
const mcp_oauth_callback_service_1 = require("./mcp-oauth-callback-service");
const MAX_OAUTH_ERROR_MESSAGE_LENGTH = 500;
/**
 * Transport-agnostic core of the MCP OAuth callback handler, shared by the browser Express route and
 * the Electron loopback server. It keeps the security-relevant logic in one audited place:
 * `state`-bound dispatch into {@link MCPOAuthCallbackService}, HTML-escaping and length-capping of
 * reflected authorization-server errors, and the locked-down response headers. Each transport only
 * parses its query into {@link MCPOAuthCallbackQuery} and writes the returned {@link MCPOAuthCallbackResponse}.
 */
let MCPOAuthCallbackResponder = class MCPOAuthCallbackResponder {
    renderResponse(query) {
        const { state } = query;
        if (!state) {
            return this.failedPage(nls_1.nls.localize('theia/ai/mcp/oauth/missingState', 'Missing OAuth state.'));
        }
        const callback = { state, code: query.code, error: query.error, errorDescription: query.errorDescription };
        if (!callback.code && !callback.error) {
            return this.failedPage(nls_1.nls.localize('theia/ai/mcp/oauth/missingCode', 'Missing OAuth authorization code.'));
        }
        if (!this.callbackService.acceptCallback(callback)) {
            // Only cancel/timeout/eviction paths populate the rejected-callback cache, so bogus-state floods cannot grow it.
            return this.failedPage(this.callbackService.consumeRejectedCallbackMessage(state)
                ?? nls_1.nls.localize('theia/ai/mcp/oauth/unknownState', 'Unknown or expired OAuth state.'));
        }
        if (callback.error) {
            return this.failedPage(this.authorizationServerErrorMessage(callback));
        }
        return this.page(200, nls_1.nls.localize('theia/ai/mcp/oauth/signInComplete', 'MCP sign-in complete'), nls_1.nls.localizeByDefault('All done. You can close this tab now.'));
    }
    failedPage(message) {
        return this.page(400, nls_1.nls.localize('theia/ai/mcp/oauth/signInFailed', 'MCP sign-in failed'), message);
    }
    page(status, title, message) {
        return {
            status,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                // RFC 6749 §10.6: don't cache responses carrying `code` and `state` query params.
                'Cache-Control': 'no-store'
            },
            body: this.renderPage(title, message)
        };
    }
    authorizationServerErrorMessage(callback) {
        const message = callback.errorDescription ?? callback.error ?? '';
        const codePoints = Array.from(message);
        const truncated = codePoints.length > MAX_OAUTH_ERROR_MESSAGE_LENGTH
            ? `${codePoints.slice(0, MAX_OAUTH_ERROR_MESSAGE_LENGTH).join('')}…`
            : message;
        return nls_1.nls.localize('theia/ai/mcp/oauth/authorizationServerError', 'Authorization server reported: {0}', truncated);
    }
    renderPage(title, message) {
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${this.escapeHtml(title)}</title>
<style>
body { font-family: sans-serif; margin: 2rem; color: #24292f; background-color: #ffffff; }
main { max-width: 42rem; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background-color: #0d1117; }
}
</style>
</head>
<body>
<main>
<h1>${this.escapeHtml(title)}</h1>
<p>${this.escapeHtml(message)}</p>
</main>
</body>
</html>`;
    }
    escapeHtml(value) {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
};
exports.MCPOAuthCallbackResponder = MCPOAuthCallbackResponder;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_oauth_callback_service_1.MCPOAuthCallbackService),
    tslib_1.__metadata("design:type", mcp_oauth_callback_service_1.MCPOAuthCallbackService)
], MCPOAuthCallbackResponder.prototype, "callbackService", void 0);
exports.MCPOAuthCallbackResponder = MCPOAuthCallbackResponder = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPOAuthCallbackResponder);
//# sourceMappingURL=mcp-oauth-callback-responder.js.map