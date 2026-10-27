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
exports.MCPOAuthCallbackBackendContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const mcp_oauth_1 = require("../common/mcp-oauth");
const mcp_oauth_callback_responder_1 = require("./mcp-oauth-callback-responder");
/**
 * Browser/hosted transport for the MCP OAuth callback: a thin Express adapter over the shared
 * {@link MCPOAuthCallbackResponder}. It only parses `req.query` into the responder's input and
 * writes the responder's output; the `state`-bound dispatch, error sanitization, and locked-down
 * headers all live in the responder.
 *
 * Unauthenticated by design: OAuth redirects from the authorization server don't carry Theia's
 * security-token cookie. Safety relies on the responder's `state`-bound dispatch, HTML escaping of
 * reflected error text, and a locked-down CSP. In Electron the redirect is delivered to the
 * loopback callback server instead, so this origin-based route is unused there.
 */
let MCPOAuthCallbackBackendContribution = class MCPOAuthCallbackBackendContribution {
    configure(app) {
        app.get(mcp_oauth_1.MCP_OAUTH_CALLBACK_PATH, (req, res) => this.handleCallback(req, res));
    }
    handleCallback(req, res) {
        const response = this.responder.renderResponse({
            state: this.getQueryParam(req.query.state),
            code: this.getQueryParam(req.query.code),
            error: this.getQueryParam(req.query.error),
            errorDescription: this.getQueryParam(req.query.error_description)
        });
        res.status(response.status).set(response.headers).send(response.body);
    }
    getQueryParam(value) {
        if (typeof value === 'string') {
            return value;
        }
        if (Array.isArray(value) && typeof value[0] === 'string') {
            return value[0];
        }
        return undefined;
    }
};
exports.MCPOAuthCallbackBackendContribution = MCPOAuthCallbackBackendContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_oauth_callback_responder_1.MCPOAuthCallbackResponder),
    tslib_1.__metadata("design:type", mcp_oauth_callback_responder_1.MCPOAuthCallbackResponder)
], MCPOAuthCallbackBackendContribution.prototype, "responder", void 0);
exports.MCPOAuthCallbackBackendContribution = MCPOAuthCallbackBackendContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPOAuthCallbackBackendContribution);
//# sourceMappingURL=mcp-oauth-callback-backend-contribution.js.map