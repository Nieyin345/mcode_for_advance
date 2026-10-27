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
exports.MCP_OAUTH_TOKEN_EXPIRY_BUFFER_MS = exports.MCP_OAUTH_KEYSTORE_SERVICE = void 0;
exports.normalizeOAuthUrl = normalizeOAuthUrl;
exports.deriveCredentialScope = deriveCredentialScope;
exports.mcpOAuthAccountPrefix = mcpOAuthAccountPrefix;
exports.mcpOAuthAccount = mcpOAuthAccount;
exports.parseStoredTokens = parseStoredTokens;
/** Keystore service name under which all MCP OAuth credentials are stored. */
exports.MCP_OAUTH_KEYSTORE_SERVICE = 'theia-ai-mcp-oauth';
/**
 * Safety margin subtracted from a token's remaining lifetime by the autostart-eligibility check
 * (`MCPOAuthCredentialStore.hasUnexpiredAccessToken`), so a server with a near-expiry token is not
 * silently autostarted. Deliberately NOT applied on the provider's runtime `tokens()` read path.
 */
exports.MCP_OAUTH_TOKEN_EXPIRY_BUFFER_MS = 30 * 1000;
/**
 * Normalizes an OAuth URL so trailing-slash variants compare equal. Shared so {@link deriveCredentialScope}
 * and `MCPServerManagerImpl`'s scope-change check use the SAME normalization — otherwise a no-op edit
 * could wipe credentials whose storage key has not changed.
 */
function normalizeOAuthUrl(url) {
    return new URL(url).toString();
}
/** The normalized keystore-key component that isolates a server's stored credentials per resource/URL. See {@link normalizeOAuthUrl}. */
function deriveCredentialScope(serverUrl, config) {
    return normalizeOAuthUrl(config.resource ?? serverUrl);
}
function mcpOAuthAccountPrefix(serverName, credentialScope) {
    // `encodeURIComponent` escapes `:` to `%3A` in both segments, so the only `:` characters in the
    // result are the two literal separators we control.
    return `${encodeURIComponent(serverName)}:${encodeURIComponent(credentialScope)}`;
}
function mcpOAuthAccount(serverName, credentialScope, key) {
    return `${mcpOAuthAccountPrefix(serverName, credentialScope)}:${key}`;
}
function parseStoredTokens(value) {
    if (!value) {
        return undefined;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=mcp-oauth-keystore.js.map