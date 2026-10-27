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
const mcp_oauth_client_provider_1 = require("./mcp-oauth-client-provider");
const mcp_oauth_errors_1 = require("./mcp-oauth-errors");
const mcp_oauth_client_provider_factory_1 = require("./mcp-oauth-client-provider-factory");
const mcp_oauth_credential_store_1 = require("./mcp-oauth-credential-store");
const mcp_oauth_callback_service_1 = require("./mcp-oauth-callback-service");
class TestKeyStore {
    constructor() {
        this.values = new Map();
    }
    async setPassword(service, account, password) {
        this.values.set(`${service}:${account}`, password);
    }
    async getPassword(service, account) {
        return this.values.get(`${service}:${account}`);
    }
    async deletePassword(service, account) {
        return this.values.delete(`${service}:${account}`);
    }
    async findPassword() {
        return undefined;
    }
    async findCredentials() {
        return [];
    }
    async keys(service) {
        const prefix = `${service}:`;
        return Array.from(this.values.keys())
            .filter(key => key.startsWith(prefix))
            .map(key => key.substring(prefix.length));
    }
}
class TestFrontendDelegate {
    setClient() { }
    disconnectClient() { }
    async clearPreparedAuthorization() { }
    async openExternal(url) {
        this.openedUrl = url;
    }
    async getCallbackUrl() {
        return 'http://localhost/mcp/oauth/callback';
    }
    async getEffectiveRedirectUrl() {
        return this.getCallbackUrl();
    }
}
const TEST_SERVER_URL = 'https://mcp.example.com/mcp';
const TEST_TOKEN_ACCOUNT = 'test%20server:https%3A%2F%2Fmcp.example.com%2Fmcp:tokens';
const TEST_CLIENT_ACCOUNT = 'test%20server:https%3A%2F%2Fmcp.example.com%2Fmcp:client';
function newFactory(keyStore, frontendDelegate, callbackService = new mcp_oauth_callback_service_1.MCPOAuthCallbackService()) {
    const factory = new mcp_oauth_client_provider_factory_1.MCPOAuthClientProviderFactory();
    factory.keyStore = keyStore;
    factory.frontendDelegate = frontendDelegate;
    factory.callbackService = callbackService;
    return factory;
}
function newCredentialStore(keyStore) {
    const store = new mcp_oauth_credential_store_1.MCPOAuthCredentialStore();
    store.keyStore = keyStore;
    return store;
}
describe('MCPOAuthClientProvider', () => {
    let keyStore;
    let frontendDelegate;
    let callbackService;
    let provider;
    beforeEach(() => {
        keyStore = new TestKeyStore();
        frontendDelegate = new TestFrontendDelegate();
        callbackService = new mcp_oauth_callback_service_1.MCPOAuthCallbackService();
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { scopes: ['mcp.read'] },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
    });
    it('provides OAuth client metadata', () => {
        (0, chai_1.expect)(provider.redirectUrl).to.equal('http://localhost/mcp/oauth/callback');
        (0, chai_1.expect)(provider.state()).to.equal('state-1');
        (0, chai_1.expect)(provider.clientMetadata.redirect_uris).to.deep.equal(['http://localhost/mcp/oauth/callback']);
        (0, chai_1.expect)(provider.clientMetadata.scope).to.equal('mcp.read');
        (0, chai_1.expect)(provider.clientMetadata.token_endpoint_auth_method).to.equal('none');
    });
    it('round-trips tokens in the key store', async () => {
        (0, chai_1.expect)(await provider.tokens()).to.be.undefined;
        await provider.saveTokens({ access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' });
        const tokens = await provider.tokens();
        (0, chai_1.expect)(tokens).to.deep.equal({ access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' });
        const storedTokens = JSON.parse((await keyStore.getPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT)));
        (0, chai_1.expect)(storedTokens).to.have.property('saved_at').that.is.a('number');
    });
    it('treats expires_in without saved_at as already expired so the SDK refreshes', async () => {
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({ access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh', expires_in: 3600 }));
        const tokens = await provider.tokens();
        (0, chai_1.expect)(tokens).to.deep.equal({ access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh', expires_in: 0 });
    });
    it('returns expires_in: 0 instead of NaN when stored expires_in is a non-finite number or non-number value', async () => {
        // Foreign / hand-edited keystore entries can carry `expires_in: "3600"` (string), `expires_in: null`,
        // `expires_in: {}` (object), or a NaN literal. Without the type guard in tokens(), the multiplication
        // and Math.floor/Math.max chain would let `NaN` reach the SDK as `expires_in: NaN`, breaking the
        // SDK's refresh-decision logic with an unhelpful downstream failure. Force a refresh on any value
        // we cannot reason about — same outcome as the missing-saved_at branch.
        const cases = [
            { description: 'object', expires_in: { not: 'a number' } },
            { description: 'array of two numbers', expires_in: [3600, 7200] },
            { description: 'true', expires_in: true }
        ];
        for (const testCase of cases) {
            await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({
                access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh',
                saved_at: Date.now(), expires_in: testCase.expires_in
            }));
            const tokens = await provider.tokens();
            (0, chai_1.expect)(tokens, `case ${testCase.description}`).to.deep.equal({
                access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh', expires_in: 0
            });
        }
    });
    it('forces refresh when a foreign entry has no saved_at AND no expires_in', async () => {
        // The exact threat model: a hand-edited / foreign entry like
        // `{ access_token: "stale", refresh_token: "..." }` has no saved_at (so we cannot reason about its
        // age) and no expires_in (so the early `expires_in === undefined -> trust forever` branch would
        // make the SDK reuse a years-old access token indefinitely). The saved_at check must run BEFORE
        // the expires_in check; missing saved_at marks the entry as untrusted and forces a refresh
        // (expires_in: 0).
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({
            access_token: 'stale', token_type: 'Bearer', refresh_token: 'refresh'
        }));
        const tokens = await provider.tokens();
        (0, chai_1.expect)(tokens).to.deep.equal({ access_token: 'stale', token_type: 'Bearer', refresh_token: 'refresh', expires_in: 0 });
    });
    it('forces refresh when stored token_type is a non-string value', async () => {
        // The SDK constructs the Authorization header as `${token_type} ${access_token}`. A foreign entry
        // with `token_type: {}` would coerce to `[object Object]` and produce a malformed request. Force
        // a refresh — if the refresh_token is usable, the SDK reissues with a well-formed token_type.
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({
            access_token: 'access', token_type: { not: 'a string' }, refresh_token: 'refresh',
            saved_at: Date.now(), expires_in: 3600
        }));
        const tokens = await provider.tokens();
        (0, chai_1.expect)(tokens?.expires_in).to.equal(0);
        (0, chai_1.expect)(tokens?.refresh_token).to.equal('refresh');
    });
    it('does not autostart on a foreign entry with usable access_token but no saved_at', async () => {
        // Companion to the runtime-read test above: the autostart gate (`hasUnexpiredAccessToken`) must
        // also check saved_at BEFORE expires_in. Otherwise `{ access_token: "stale" }` (no expires_in, no
        // saved_at) passes the autostart-eligibility check and the SDK reuses a stale token without refresh.
        const store = newCredentialStore(keyStore);
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({ access_token: 'stale', token_type: 'Bearer' }));
        (0, chai_1.expect)(await store.hasTokens('test server', TEST_SERVER_URL, {})).to.be.false;
    });
    it('uses configured static client information', async () => {
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { clientId: 'client' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        (0, chai_1.expect)(await provider.clientInformation()).to.deep.equal({ client_id: 'client' });
    });
    it('includes the configured client secret for pre-registered confidential clients', async () => {
        // Authorization servers without dynamic client registration may require confidential clients;
        // the SDK keys its token-endpoint auth method off client_secret presence in clientInformation().
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { clientId: 'client', clientSecret: 'secret' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        (0, chai_1.expect)(await provider.clientInformation()).to.deep.equal({ client_id: 'client', client_secret: 'secret' });
    });
    it('does not store dynamic client information for static client configuration', async () => {
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { clientId: 'client' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        await provider.saveClientInformation({ client_id: 'dynamic-client' });
        (0, chai_1.expect)(await keyStore.getPassword('theia-ai-mcp-oauth', TEST_CLIENT_ACCOUNT)).to.be.undefined;
    });
    it('stores dynamic public client information and keeps code verifier in memory', async () => {
        await provider.saveClientInformation({ client_id: 'dynamic-client', client_secret: 'secret' });
        await provider.saveCodeVerifier('verifier');
        (0, chai_1.expect)(await provider.clientInformation()).to.deep.equal({ client_id: 'dynamic-client' });
        (0, chai_1.expect)(await provider.codeVerifier()).to.equal('verifier');
        (0, chai_1.expect)(Array.from(keyStore.values.keys()).some(key => key.includes(':verifier'))).to.be.false;
    });
    it('invalidates the in-memory code verifier', async () => {
        await provider.saveCodeVerifier('verifier');
        await provider.invalidateCredentials('verifier');
        try {
            await provider.codeVerifier();
            throw new Error('Expected verifier to be cleared');
        }
        catch (error) {
            // Typed so MCPServer.doStart routes a missing verifier to AuthenticationRequired, not the SSE fallback.
            (0, chai_1.expect)(error).to.be.instanceOf(mcp_oauth_errors_1.MCPOAuthAuthorizationRequiredError);
        }
    });
    it('preserves the in-flight code verifier when invalidating all stored credentials', async () => {
        // The SDK self-heals invalid_client/unauthorized_client by invalidating 'all' and retrying the code
        // exchange; the retry still needs the in-memory PKCE verifier of the in-flight round-trip.
        await provider.saveClientInformation({ client_id: 'dynamic-client' });
        await provider.saveTokens({ access_token: 'access', token_type: 'Bearer' });
        await provider.saveCodeVerifier('verifier');
        await provider.invalidateCredentials('all');
        (0, chai_1.expect)(await provider.codeVerifier()).to.equal('verifier');
        (0, chai_1.expect)(await provider.clientInformation()).to.be.undefined;
        (0, chai_1.expect)(await provider.tokens()).to.be.undefined;
    });
    it('scopes stored tokens by server URL', async () => {
        const otherProvider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: {},
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: 'https://other.example.com/mcp',
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        await provider.saveTokens({ access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' });
        (0, chai_1.expect)(await otherProvider.tokens()).to.be.undefined;
    });
    it('treats expiring tokens without issuance time or refresh token as not usable for non-interactive starts', async () => {
        const store = newCredentialStore(keyStore);
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({ access_token: 'access', token_type: 'Bearer', expires_in: 3600 }));
        (0, chai_1.expect)(await store.hasTokens('test server', TEST_SERVER_URL, {})).to.be.false;
    });
    it('treats unexpired access tokens as usable for non-interactive starts', async () => {
        const store = newCredentialStore(keyStore);
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({
            access_token: 'access', token_type: 'Bearer', expires_in: 3600, saved_at: Date.now()
        }));
        (0, chai_1.expect)(await store.hasTokens('test server', TEST_SERVER_URL, {})).to.be.true;
    });
    it('treats expired access tokens without refresh token as not usable for non-interactive starts', async () => {
        const store = newCredentialStore(keyStore);
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({
            access_token: 'access', token_type: 'Bearer', expires_in: 3600, saved_at: Date.now() - 7200 * 1000
        }));
        (0, chai_1.expect)(await store.hasTokens('test server', TEST_SERVER_URL, {})).to.be.false;
    });
    it('treats refreshable tokens as usable for non-interactive starts', async () => {
        const store = newCredentialStore(keyStore);
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, JSON.stringify({ access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' }));
        (0, chai_1.expect)(await store.hasTokens('test server', TEST_SERVER_URL, {})).to.be.true;
    });
    it('opens authorization URL externally', async () => {
        await provider.redirectToAuthorization(new URL('https://auth.example/authorize'));
        (0, chai_1.expect)(frontendDelegate.openedUrl).to.equal('https://auth.example/authorize');
    });
    it('rejects authorization redirects after disposal', async () => {
        provider.markInactive();
        try {
            await provider.redirectToAuthorization(new URL('https://auth.example/authorize'));
            throw new Error('Expected redirect to be rejected');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal('MCP OAuth authorization is required. Start the server from the UI to sign in.');
        }
    });
    it('does not keep code verifier after disposal', async () => {
        provider.markInactive();
        await provider.saveCodeVerifier('verifier');
        try {
            await provider.codeVerifier();
            throw new Error('Expected verifier to be missing');
        }
        catch (error) {
            (0, chai_1.expect)(error).to.be.instanceOf(mcp_oauth_errors_1.MCPOAuthAuthorizationRequiredError);
        }
    });
    it('clears a previously stored code verifier on disposal', async () => {
        await provider.saveCodeVerifier('verifier');
        provider.markInactive();
        try {
            await provider.codeVerifier();
            throw new Error('Expected verifier to be cleared on disposal');
        }
        catch (error) {
            (0, chai_1.expect)(error).to.be.instanceOf(mcp_oauth_errors_1.MCPOAuthAuthorizationRequiredError);
        }
    });
    it('cancel() rejects a pending waitForAuthorization with MCPOAuthCancelledError', async () => {
        const waiting = provider.waitForAuthorization();
        provider.cancel();
        try {
            await waiting;
            throw new Error('Expected waitForAuthorization to be cancelled');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal(mcp_oauth_callback_service_1.MCP_OAUTH_AUTHORIZATION_CANCELLED);
        }
    });
    it('cancel() records a rejection message for the late browser callback', async () => {
        // waitForAuthorization must be called first so the deferred is "claimed"; without that the entry
        // would already be empty and callbackService.cancel would early-return without recording.
        provider.waitForAuthorization().catch(() => undefined);
        provider.cancel();
        (0, chai_1.expect)(callbackService.consumeRejectedCallbackMessage(provider.getState()))
            .to.equal('OAuth authorization was cancelled. You can close this tab.');
    });
    it('returns undefined discovery state for authorization server override without stored discovery', async () => {
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { authorizationServer: 'https://auth.example.com' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        (0, chai_1.expect)(await provider.discoveryState()).to.be.undefined;
    });
    it('rejects discovery state when authorization server override does not match', async () => {
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { authorizationServer: 'https://auth.example.com' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        try {
            await provider.saveDiscoveryState({ authorizationServerUrl: 'https://other.example.com' });
            throw new Error('Expected mismatched authorization server to be rejected');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal('Discovered MCP OAuth authorization server https://other.example.com does not match configured authorization server https://auth.example.com.');
        }
    });
    it('returns stored discovery state when authorization server override still matches', async () => {
        await provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.com' });
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { authorizationServer: 'https://auth.example.com' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        (0, chai_1.expect)(await provider.discoveryState()).to.deep.equal({ authorizationServerUrl: 'https://auth.example.com' });
    });
    it('returns undefined discovery state when authorization server override changed', async () => {
        await provider.saveDiscoveryState({ authorizationServerUrl: 'https://old.example.com' });
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { authorizationServer: 'https://auth.example.com' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        (0, chai_1.expect)(await provider.discoveryState()).to.be.undefined;
    });
    it('deletes corrupt stored OAuth values and treats them as missing', async () => {
        await keyStore.setPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT, '{not-json');
        (0, chai_1.expect)(await provider.tokens()).to.be.undefined;
        (0, chai_1.expect)(await keyStore.getPassword('theia-ai-mcp-oauth', TEST_TOKEN_ACCOUNT)).to.be.undefined;
    });
    it('returns the canonical MCP server URL when no resource metadata is provided', async () => {
        const resource = await provider.validateResourceURL('https://mcp.example.com/mcp#fragment');
        (0, chai_1.expect)(resource?.toString()).to.equal('https://mcp.example.com/mcp');
    });
    it('accepts compatible configured resources', async () => {
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { resource: 'https://mcp.example.com' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        const resource = await provider.validateResourceURL('https://mcp.example.com/mcp');
        (0, chai_1.expect)(resource?.toString()).to.equal('https://mcp.example.com/');
    });
    it('rejects incompatible configured resources', async () => {
        provider = new mcp_oauth_client_provider_1.MCPOAuthClientProvider({
            serverName: 'test server',
            config: { resource: 'https://other.example.com' },
            callbackUrl: 'http://localhost/mcp/oauth/callback',
            stateValue: 'state-1',
            credentialScope: TEST_SERVER_URL,
            keyStore,
            frontendDelegate,
            callbackService,
            interactive: true
        });
        try {
            await provider.validateResourceURL('https://mcp.example.com/mcp');
            throw new Error('Expected incompatible resource to be rejected');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal('Configured MCP OAuth resource https://other.example.com does not match https://mcp.example.com/mcp.');
        }
    });
    it('accepts compatible protected resource metadata', async () => {
        const resource = await provider.validateResourceURL('https://mcp.example.com/mcp', 'https://mcp.example.com');
        (0, chai_1.expect)(resource?.toString()).to.equal('https://mcp.example.com/');
    });
    it('rejects incompatible protected resource metadata', async () => {
        try {
            await provider.validateResourceURL('https://mcp.example.com/mcp', 'https://other.example.com');
            throw new Error('Expected incompatible resource metadata to be rejected');
        }
        catch (error) {
            (0, chai_1.expect)(error.message).to.equal('Protected MCP OAuth resource https://other.example.com does not match https://mcp.example.com/mcp.');
        }
    });
    it('factory returns the same active state for repeated state calls in one authorization round', async () => {
        const factory = newFactory(keyStore, frontendDelegate, callbackService);
        const createdProvider = await factory.create('test server', 'https://mcp.example.com/mcp', {}, { interactive: true });
        (0, chai_1.expect)(createdProvider.state()).to.equal(createdProvider.state());
    });
    it('credential store clear() wipes credentials without aborting in-flight authorizations', async () => {
        // The store only wipes credentials; cancellation is the caller's responsibility (e.g.
        // MCPServer.stop() calls authProvider.cancel() first). A provider created by the factory shares
        // the same keystore, so clear() removes its tokens but does not touch the callback service.
        const factory = newFactory(keyStore, frontendDelegate, callbackService);
        const store = newCredentialStore(keyStore);
        const createdProvider = await factory.create('test server', 'https://mcp.example.com/mcp', {}, { interactive: true });
        await createdProvider.saveTokens({ access_token: 'access', token_type: 'Bearer' });
        const otherProvider = await factory.create('other server', 'https://mcp.example.com/mcp', {}, { interactive: true });
        await otherProvider.saveTokens({ access_token: 'other-access', token_type: 'Bearer' });
        await store.clear('test server');
        (0, chai_1.expect)(await createdProvider.tokens()).to.be.undefined;
        (0, chai_1.expect)(await otherProvider.tokens()).to.deep.include({ access_token: 'other-access', token_type: 'Bearer' });
    });
});
//# sourceMappingURL=mcp-oauth-client-provider.spec.js.map