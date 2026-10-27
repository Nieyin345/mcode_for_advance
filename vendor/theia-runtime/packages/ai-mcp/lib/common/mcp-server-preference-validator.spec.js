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
const mcp_server_preference_validator_1 = require("./mcp-server-preference-validator");
/**
 * Captures the diagnostic that `filterValidValues` writes to `console.warn` for a single probe entry.
 * Returns the diagnostic string for an invalid entry, or `undefined` for a valid entry.
 */
function reasonFor(value) {
    let captured;
    const originalWarn = console.warn;
    console.warn = (...args) => {
        if (args.length >= 2 && typeof args[1] === 'string') {
            captured = args[1];
        }
    };
    try {
        (0, mcp_server_preference_validator_1.filterValidValues)({ probe: value });
    }
    finally {
        console.warn = originalWarn;
    }
    return captured;
}
describe('MCPServersPreference validator', () => {
    describe('isHttpOrHttpsUrl', () => {
        it('accepts a fully qualified https URL', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)('https://auth.example.com')).to.be.true;
        });
        it('accepts a fully qualified http URL', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)('http://auth.example.com')).to.be.true;
        });
        it('accepts a URL with a path and query', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)('https://auth.example.com/oauth?foo=bar')).to.be.true;
        });
        it('rejects an unparseable string', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)('not a url')).to.be.false;
        });
        it('rejects an empty string', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)('')).to.be.false;
        });
        it('rejects a javascript: URL', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)('javascript:alert(1)')).to.be.false;
        });
        it('rejects a data: URL', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)('data:text/html,<script>alert(1)</script>')).to.be.false;
        });
        it('rejects a file: URL', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.isHttpOrHttpsUrl)('file:///etc/passwd')).to.be.false;
        });
    });
    describe('filterValidValues diagnostics', () => {
        it('flags a non-object value', () => {
            (0, chai_1.expect)(reasonFor('not-an-object')).to.contain('JSON object');
        });
        it('flags missing command/serverUrl', () => {
            (0, chai_1.expect)(reasonFor({})).to.contain('required');
        });
        it('flags both command and serverUrl on the same entry', () => {
            (0, chai_1.expect)(reasonFor({ command: 'node', serverUrl: 'https://mcp.example.com/mcp' })).to.contain('not both');
        });
        it('flags oauth on a local server', () => {
            (0, chai_1.expect)(reasonFor({ command: 'node', oauth: {} })).to.contain('only valid for remote');
        });
        it('flags serverAuthToken + OAuth conflict', () => {
            (0, chai_1.expect)(reasonFor({
                serverUrl: 'https://mcp.example.com/mcp',
                serverAuthToken: 'token',
                oauth: {}
            })).to.contain('not both');
        });
        it('flags an unparseable oauth.authorizationServer URL', () => {
            const reason = reasonFor({
                serverUrl: 'https://mcp.example.com/mcp',
                oauth: { authorizationServer: 'not-a-url' }
            });
            (0, chai_1.expect)(reason).to.contain('oauth.authorizationServer');
            (0, chai_1.expect)(reason).to.contain('http(s) URL');
        });
        it('flags a non-http oauth.authorizationServer URL', () => {
            const reason = reasonFor({
                serverUrl: 'https://mcp.example.com/mcp',
                oauth: { authorizationServer: 'javascript:alert(1)' }
            });
            (0, chai_1.expect)(reason).to.contain('oauth.authorizationServer');
            (0, chai_1.expect)(reason).to.contain('http(s) URL');
        });
        it('flags an unparseable oauth.resource URL', () => {
            const reason = reasonFor({
                serverUrl: 'https://mcp.example.com/mcp',
                oauth: { resource: 'not-a-url' }
            });
            (0, chai_1.expect)(reason).to.contain('oauth.resource');
            (0, chai_1.expect)(reason).to.contain('http(s) URL');
        });
        it('flags a non-string command', () => {
            (0, chai_1.expect)(reasonFor({ command: 123 })).to.contain('"command" must be a string');
        });
        it('flags a non-string oauth.clientId with the generic oauth diagnostic', () => {
            const reason = reasonFor({
                serverUrl: 'https://mcp.example.com/mcp',
                oauth: { clientId: 42 }
            });
            (0, chai_1.expect)(reason).to.contain('"oauth"');
        });
        it('flags scopes that are not all strings with the generic oauth diagnostic', () => {
            const reason = reasonFor({
                serverUrl: 'https://mcp.example.com/mcp',
                oauth: { scopes: ['read', 42] }
            });
            (0, chai_1.expect)(reason).to.contain('"oauth"');
        });
        it('produces no diagnostic for a valid entry', () => {
            (0, chai_1.expect)(reasonFor({ command: 'node' })).to.be.undefined;
        });
        it('produces no diagnostic for a remote entry with an empty oauth object (presence enables OAuth)', () => {
            (0, chai_1.expect)(reasonFor({ serverUrl: 'https://mcp.example.com/mcp', oauth: {} })).to.be.undefined;
        });
        it('treats an explicit null oauth as absent on a local server (user-authored JSON may serialize this way)', () => {
            // eslint-disable-next-line no-null/no-null
            (0, chai_1.expect)(reasonFor({ command: 'node', oauth: null })).to.be.undefined;
        });
        it('flags a non-string cwd', () => {
            (0, chai_1.expect)(reasonFor({ command: 'node', cwd: 42 })).to.contain('"cwd" must be a string');
        });
        it('flags a non-string pluginRoot', () => {
            (0, chai_1.expect)(reasonFor({ command: 'node', pluginRoot: 42 })).to.contain('"pluginRoot" must be a string');
        });
        it('flags a non-string pluginData', () => {
            (0, chai_1.expect)(reasonFor({ command: 'node', pluginData: 42 })).to.contain('"pluginData" must be a string');
        });
        it('flags a registryMetadata block that identifies neither a registry server nor an Agent Plugin', () => {
            (0, chai_1.expect)(reasonFor({ command: 'node', registryMetadata: { version: '1.0.0' } })).to.contain('registryMetadata');
        });
    });
    describe('filterValidValues', () => {
        it('keeps valid entries and drops invalid ones', () => {
            const originalConsoleWarn = console.warn;
            const warnings = [];
            console.warn = (...args) => { warnings.push(args); };
            try {
                const result = (0, mcp_server_preference_validator_1.filterValidValues)({
                    'good-local': { command: 'node' },
                    'good-remote': { serverUrl: 'https://mcp.example.com/mcp' },
                    'missing-command-and-url': { autostart: true },
                    'bad-oauth-url': {
                        serverUrl: 'https://mcp.example.com/mcp',
                        oauth: { authorizationServer: 'not-a-url' }
                    }
                });
                (0, chai_1.expect)(Object.keys(result)).to.have.members(['good-local', 'good-remote']);
                // Each invalid entry must produce a diagnostic so users can see why their config was dropped.
                (0, chai_1.expect)(warnings).to.have.length(2);
            }
            finally {
                console.warn = originalConsoleWarn;
            }
        });
        it('returns an empty object for a non-object input', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.filterValidValues)('not-an-object')).to.deep.equal({});
        });
        it('returns an empty object for undefined', () => {
            (0, chai_1.expect)((0, mcp_server_preference_validator_1.filterValidValues)(undefined)).to.deep.equal({});
        });
    });
    describe('MCPServersPreference.isValue', () => {
        it('accepts a valid local entry', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({ command: 'node' })).to.be.true;
        });
        it('accepts a valid remote OAuth entry', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({ serverUrl: 'https://mcp.example.com/mcp', oauth: {} })).to.be.true;
        });
        it('rejects an entry with both command and serverUrl', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({ command: 'node', serverUrl: 'https://mcp.example.com/mcp' })).to.be.false;
        });
        it('rejects a remote entry combining serverAuthToken with oauth', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({ serverUrl: 'https://mcp.example.com/mcp', serverAuthToken: 'token', oauth: {} })).to.be.false;
        });
        it('rejects a non-object value', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue('not-an-object')).to.be.false;
        });
        it('accepts a local entry carrying cwd, pluginRoot and pluginData', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({
                command: './bin/validator',
                cwd: '/home/alex/.agents/plugins/devtools',
                pluginRoot: '/home/alex/.agents/plugins/devtools',
                pluginData: '/home/alex/.agents/plugins/data/devtools'
            })).to.be.true;
        });
        it('accepts an entry whose registryMetadata carries a pluginId and no serverId', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({
                command: 'npx',
                registryMetadata: { pluginId: 'io.github.acme/devtools', version: '1.0.0' }
            })).to.be.true;
        });
        it('still accepts an entry whose registryMetadata carries only a serverId', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({
                command: 'npx',
                registryMetadata: { serverId: 'io.github.acme/brave-search', configHash: 'abc' }
            })).to.be.true;
        });
        it('rejects a registryMetadata block with neither serverId nor pluginId', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({ command: 'npx', registryMetadata: { version: '1.0.0' } })).to.be.false;
        });
        it('rejects a registryMetadata block whose pluginId is not a string', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({ command: 'npx', registryMetadata: { pluginId: 42 } })).to.be.false;
        });
        it('rejects a plugin-provided entry that also declares a serverUrl, keeping the local/remote discriminator intact', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({
                command: 'npx',
                serverUrl: 'https://mcp.example.com/mcp',
                registryMetadata: { pluginId: 'io.github.acme/devtools' }
            })).to.be.false;
        });
        it('rejects a plugin-provided local entry that declares oauth', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({
                command: 'npx',
                oauth: {},
                registryMetadata: { pluginId: 'io.github.acme/devtools' }
            })).to.be.false;
        });
        it('rejects a local entry whose pluginRoot is not a string', () => {
            (0, chai_1.expect)(mcp_server_preference_validator_1.MCPServersPreference.isValue({ command: 'npx', pluginRoot: 42 })).to.be.false;
        });
    });
});
//# sourceMappingURL=mcp-server-preference-validator.spec.js.map