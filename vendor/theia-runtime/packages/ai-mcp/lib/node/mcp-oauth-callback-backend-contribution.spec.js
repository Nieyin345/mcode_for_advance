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
const mcp_oauth_callback_backend_contribution_1 = require("./mcp-oauth-callback-backend-contribution");
const mcp_oauth_callback_responder_1 = require("./mcp-oauth-callback-responder");
class TestResponse {
    constructor() {
        this.statusCode = 200;
        this.body = '';
        this.headers = {};
    }
    status(statusCode) {
        this.statusCode = statusCode;
        return this;
    }
    set(headers) {
        Object.assign(this.headers, headers);
        return this;
    }
    send(body) {
        this.body = body;
        return this;
    }
}
class RecordingResponder extends mcp_oauth_callback_responder_1.MCPOAuthCallbackResponder {
    constructor() {
        super(...arguments);
        this.cannedResponse = {
            status: 207,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Test': 'yes' },
            body: '<html>stub</html>'
        };
    }
    renderResponse(query) {
        this.lastQuery = query;
        return this.cannedResponse;
    }
}
function createContribution() {
    const responder = new RecordingResponder();
    const contribution = new mcp_oauth_callback_backend_contribution_1.MCPOAuthCallbackBackendContribution();
    contribution.responder = responder;
    return { contribution, responder };
}
function handleCallback(contribution, query) {
    const response = new TestResponse();
    const request = { query };
    contribution.handleCallback(request, response);
    return response;
}
describe('MCPOAuthCallbackBackendContribution', () => {
    it('registers a fixed callback route', () => {
        const registeredRoutes = [];
        const app = {
            get: (path) => registeredRoutes.push(path)
        };
        new mcp_oauth_callback_backend_contribution_1.MCPOAuthCallbackBackendContribution().configure(app);
        (0, chai_1.expect)(registeredRoutes).to.deep.equal(['/mcp/oauth/callback']);
    });
    it('parses the OAuth query params and forwards them to the shared responder', () => {
        const { contribution, responder } = createContribution();
        handleCallback(contribution, { state: 'state', code: 'code', error: 'err', error_description: 'desc' });
        (0, chai_1.expect)(responder.lastQuery).to.deep.equal({ state: 'state', code: 'code', error: 'err', errorDescription: 'desc' });
    });
    it('takes the first value when a query param is repeated (array form)', () => {
        const { contribution, responder } = createContribution();
        handleCallback(contribution, { state: ['first', 'second'], code: 'code' });
        (0, chai_1.expect)(responder.lastQuery?.state).to.equal('first');
    });
    it('ignores non-string query params', () => {
        const { contribution, responder } = createContribution();
        handleCallback(contribution, { state: 'state', code: { nested: 'object' } });
        (0, chai_1.expect)(responder.lastQuery?.code).to.be.undefined;
    });
    it('writes the responder status, headers, and body to the response', () => {
        const { contribution } = createContribution();
        const response = handleCallback(contribution, { state: 'state', code: 'code' });
        (0, chai_1.expect)(response.statusCode).to.equal(207);
        (0, chai_1.expect)(response.headers['Content-Type']).to.equal('text/html; charset=utf-8');
        (0, chai_1.expect)(response.headers['X-Test']).to.equal('yes');
        (0, chai_1.expect)(response.body).to.equal('<html>stub</html>');
    });
});
//# sourceMappingURL=mcp-oauth-callback-backend-contribution.spec.js.map