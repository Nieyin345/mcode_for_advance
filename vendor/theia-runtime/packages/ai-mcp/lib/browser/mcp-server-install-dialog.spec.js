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
// Another spec in this package may have already set the configuration; mocha loads all
// specs into one process and `set` throws if called twice, so guard it.
try {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.get();
}
catch {
    frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
}
const chai_1 = require("chai");
const mcp_server_install_dialog_1 = require("./mcp-server-install-dialog");
// Balance the import-time enable; the suite re-enables JSDOM around its own tests so it
// is robust to other specs in the package toggling the shared JSDOM globals.
disableJSDOM();
/** Exposes the protected validation hook and credential fields so we can assert on them directly. */
class TestInstallDialog extends mcp_server_install_dialog_1.MCPServerInstallDialog {
    setToken(token) {
        this.serverAuthToken = token;
    }
    setOAuthCredentials(clientId, clientSecret) {
        this.oauthClientId = clientId;
        this.oauthClientSecret = clientSecret;
    }
    runValidation() {
        return this.isValid(this.value, 'open');
    }
}
function dialog(options = {}) {
    return new TestInstallDialog({ name: 'example', ...options });
}
describe('MCPServerInstallDialog.isValid', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    it('accepts any input when the server does not require an auth token', () => {
        const d = dialog({ requireAuthToken: false });
        (0, chai_1.expect)(d.runValidation()).to.equal('');
    });
    it('rejects an empty token when the server requires one', () => {
        const d = dialog({ requireAuthToken: true });
        (0, chai_1.expect)(d.runValidation()).to.match(/auth token is required/i);
    });
    it('rejects a whitespace-only token when the server requires one', () => {
        const d = dialog({ requireAuthToken: true });
        d.setToken('   ');
        (0, chai_1.expect)(d.runValidation()).to.match(/auth token is required/i);
    });
    it('accepts a non-empty token when the server requires one', () => {
        const d = dialog({ requireAuthToken: true });
        d.setToken('real-token');
        (0, chai_1.expect)(d.runValidation()).to.equal('');
    });
    it('rejects missing OAuth credentials when the server requires OAuth', () => {
        const d = dialog({ requireOAuth: true });
        (0, chai_1.expect)(d.runValidation()).to.match(/client ID and client secret are required/i);
        d.setOAuthCredentials('client-id', '');
        (0, chai_1.expect)(d.runValidation()).to.match(/client ID and client secret are required/i);
    });
    it('accepts and returns OAuth credentials when both are provided', () => {
        const d = dialog({ requireOAuth: true });
        d.setOAuthCredentials('client-id', 'client-secret');
        (0, chai_1.expect)(d.runValidation()).to.equal('');
        (0, chai_1.expect)(d.value).to.deep.include({ oauthClientId: 'client-id', oauthClientSecret: 'client-secret' });
    });
});
//# sourceMappingURL=mcp-server-install-dialog.spec.js.map