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
exports.MCPOAuthClientProviderFactory = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const key_store_1 = require("@theia/core/lib/common/key-store");
const mcp_oauth_1 = require("../common/mcp-oauth");
const mcp_oauth_callback_service_1 = require("./mcp-oauth-callback-service");
const mcp_oauth_client_provider_1 = require("./mcp-oauth-client-provider");
const mcp_oauth_keystore_1 = require("./mcp-oauth-keystore");
/**
 * Connection-scoped factory for {@link MCPOAuthClientProvider}. Wires each provider to the shared
 * callback service and the connection's cached callback URL. Per-flow lifecycle (cancellation,
 * waiting for the callback) is owned by the provider; credential storage is owned by
 * `MCPOAuthCredentialStore`. This class only constructs providers.
 */
let MCPOAuthClientProviderFactory = class MCPOAuthClientProviderFactory {
    async create(serverName, serverUrl, config, options) {
        const callbackUrl = await this.getCallbackUrl();
        const state = this.callbackService.createState();
        return new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName,
            config,
            callbackUrl,
            stateValue: state,
            credentialScope: (0, mcp_oauth_keystore_1.deriveCredentialScope)(serverUrl, config),
            keyStore: this.keyStore,
            frontendDelegate: this.frontendDelegate,
            callbackService: this.callbackService,
            interactive: options.interactive
        });
    }
    getCallbackUrl() {
        // Cached for this connection-scoped factory; a new frontend connection gets a new instance.
        // On rejection we clear the cache so the next start retries instead of returning the poisoned
        // failure forever. Clearing on the cached promise lets parallel awaiters receive the rejection too.
        if (!this.callbackUrlPromise) {
            const pending = this.frontendDelegate.getEffectiveRedirectUrl();
            this.callbackUrlPromise = pending;
            pending.catch(() => {
                if (this.callbackUrlPromise === pending) {
                    this.callbackUrlPromise = undefined;
                }
            });
        }
        return this.callbackUrlPromise;
    }
};
exports.MCPOAuthClientProviderFactory = MCPOAuthClientProviderFactory;
tslib_1.__decorate([
    (0, inversify_1.inject)(key_store_1.KeyStoreService),
    tslib_1.__metadata("design:type", Object)
], MCPOAuthClientProviderFactory.prototype, "keyStore", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_oauth_1.MCPOAuthFrontendDelegate),
    tslib_1.__metadata("design:type", Object)
], MCPOAuthClientProviderFactory.prototype, "frontendDelegate", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_oauth_callback_service_1.MCPOAuthCallbackService),
    tslib_1.__metadata("design:type", mcp_oauth_callback_service_1.MCPOAuthCallbackService)
], MCPOAuthClientProviderFactory.prototype, "callbackService", void 0);
exports.MCPOAuthClientProviderFactory = MCPOAuthClientProviderFactory = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPOAuthClientProviderFactory);
//# sourceMappingURL=mcp-oauth-client-provider-factory.js.map