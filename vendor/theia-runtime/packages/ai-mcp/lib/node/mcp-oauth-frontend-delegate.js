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
exports.MCPOAuthFrontendDelegateImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const mcp_oauth_callback_endpoint_1 = require("./mcp-oauth-callback-endpoint");
const core_1 = require("@theia/core");
let MCPOAuthFrontendDelegateImpl = class MCPOAuthFrontendDelegateImpl {
    setClient(client) {
        if (this.client && this.client !== client) {
            throw new Error('MCP OAuth frontend delegate is scoped to a single frontend connection.');
        }
        this.client = client;
    }
    disconnectClient(client) {
        if (this.client !== undefined && this.client !== client) {
            this.logger.warn('MCP OAuth frontend delegate received disconnectClient for a non-current client; ignoring (one-client-per-container invariant violation).');
            return;
        }
        if (this.client === client) {
            this.client = undefined;
        }
    }
    async openExternal(url) {
        return this.requireClient().openExternal(url);
    }
    async getCallbackUrl() {
        return this.requireClient().getCallbackUrl();
    }
    async getEffectiveRedirectUrl() {
        return this.callbackEndpoint
            ? this.callbackEndpoint.getRedirectUrl()
            : this.requireClient().getCallbackUrl();
    }
    requireClient() {
        if (!this.client) {
            throw new Error('MCP OAuth frontend delegate client not set.');
        }
        return this.client;
    }
};
exports.MCPOAuthFrontendDelegateImpl = MCPOAuthFrontendDelegateImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_oauth_callback_endpoint_1.MCPOAuthCallbackEndpoint),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], MCPOAuthFrontendDelegateImpl.prototype, "callbackEndpoint", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:MCPOAuthFrontendDelegateImpl'),
    tslib_1.__metadata("design:type", Object)
], MCPOAuthFrontendDelegateImpl.prototype, "logger", void 0);
exports.MCPOAuthFrontendDelegateImpl = MCPOAuthFrontendDelegateImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPOAuthFrontendDelegateImpl);
//# sourceMappingURL=mcp-oauth-frontend-delegate.js.map