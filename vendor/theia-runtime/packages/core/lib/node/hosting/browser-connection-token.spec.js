"use strict";
// *****************************************************************************
// Copyright (C) 2026 STMicroelectronics and others.
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
const common_1 = require("../../common");
const browser_connection_token_1 = require("./browser-connection-token");
describe('BrowserConnectionToken', () => {
    it('should generate unique tokens', () => {
        const token1 = (0, browser_connection_token_1.createBrowserConnectionToken)();
        const token2 = (0, browser_connection_token_1.createBrowserConnectionToken)();
        (0, chai_1.expect)(token1.value).to.not.equal(token2.value);
    });
    it('should generate tokens of sufficient length', () => {
        const token = (0, browser_connection_token_1.createBrowserConnectionToken)();
        (0, chai_1.expect)(token.value.length).to.be.greaterThan(16);
    });
});
describe('BrowserConnectionTokenBackendContribution', () => {
    const token = (0, browser_connection_token_1.createBrowserConnectionToken)();
    function createContribution() {
        const contribution = new browser_connection_token_1.BrowserConnectionTokenBackendContribution();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contribution['browserConnectionToken'] = token;
        return contribution;
    }
    function createRequest(cookieValue) {
        const request = {
            headers: {}
        };
        if (cookieValue !== undefined) {
            request.headers.cookie = `${browser_connection_token_1.BROWSER_TOKEN_COOKIE_NAME}=${cookieValue}`;
        }
        return request;
    }
    describe('allowWsUpgrade (WebSocket validation)', () => {
        it('should allow WebSocket with valid token cookie', () => {
            const contribution = createContribution();
            (0, chai_1.expect)(contribution.allowWsUpgrade(createRequest(token.value))).to.be.true;
        });
        it('should reject WebSocket with no cookie', () => {
            const contribution = createContribution();
            (0, chai_1.expect)(contribution.allowWsUpgrade(createRequest())).to.be.false;
        });
        it('should reject WebSocket with invalid token', () => {
            const contribution = createContribution();
            (0, chai_1.expect)(contribution.allowWsUpgrade(createRequest('wrong-token'))).to.be.false;
        });
        it('should reject WebSocket with stale token from previous server', () => {
            const contribution = createContribution();
            const staleToken = (0, browser_connection_token_1.createBrowserConnectionToken)().value;
            (0, chai_1.expect)(contribution.allowWsUpgrade(createRequest(staleToken))).to.be.false;
        });
        it('should reject WebSocket with empty token', () => {
            const contribution = createContribution();
            (0, chai_1.expect)(contribution.allowWsUpgrade(createRequest(''))).to.be.false;
        });
        it('should handle multiple cookies correctly', () => {
            const contribution = createContribution();
            const request = {
                headers: {
                    cookie: `other-cookie=foo; ${browser_connection_token_1.BROWSER_TOKEN_COOKIE_NAME}=${token.value}; another=bar`
                }
            };
            (0, chai_1.expect)(contribution.allowWsUpgrade(request)).to.be.true;
        });
    });
    describe('expressMiddleware (HTTP cookie flow)', () => {
        function callMiddleware(cookieValue, conditionalHeaders = false) {
            const contribution = createContribution();
            const req = {
                headers: {},
                socket: { remoteAddress: '127.0.0.1' }
            };
            const result = { cookieCalls: [], nextCalled: false, requestHeaders: req.headers };
            if (cookieValue !== undefined) {
                req.headers.cookie = `${browser_connection_token_1.BROWSER_TOKEN_COOKIE_NAME}=${cookieValue}`;
            }
            if (conditionalHeaders) {
                req.headers['if-none-match'] = 'W/"etag"';
                req.headers['if-modified-since'] = 'Thu, 01 Jan 2026 00:00:00 GMT';
            }
            const res = {
                cookie: (name, value, options) => {
                    result.cookieCalls.push({ name, value, options });
                }
            };
            const next = () => { result.nextCalled = true; };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            contribution.expressMiddleware(req, res, next);
            return result;
        }
        it('should set cookie and allow request when no cookie present', () => {
            const result = callMiddleware();
            (0, chai_1.expect)(result.nextCalled).to.be.true;
            (0, chai_1.expect)(result.cookieCalls).to.have.length(1);
            (0, chai_1.expect)(result.cookieCalls[0].name).to.equal(browser_connection_token_1.BROWSER_TOKEN_COOKIE_NAME);
            (0, chai_1.expect)(result.cookieCalls[0].value).to.equal(token.value);
        });
        it('should set cookie with HttpOnly, SameSite=Strict, and path=/', () => {
            const result = callMiddleware();
            const opts = result.cookieCalls[0].options;
            (0, chai_1.expect)(opts.httpOnly).to.be.true;
            (0, chai_1.expect)(opts.sameSite).to.equal('strict');
            (0, chai_1.expect)(opts.path).to.equal('/');
        });
        it('should allow request with valid cookie without re-setting it', () => {
            const result = callMiddleware(token.value);
            (0, chai_1.expect)(result.nextCalled).to.be.true;
            (0, chai_1.expect)(result.cookieCalls).to.have.length(0);
        });
        it('should refresh stale cookie and allow request', () => {
            const result = callMiddleware('stale-token-from-old-server');
            (0, chai_1.expect)(result.nextCalled).to.be.true;
            (0, chai_1.expect)(result.cookieCalls).to.have.length(1);
            (0, chai_1.expect)(result.cookieCalls[0].value).to.equal(token.value);
        });
        it('should drop conditional request headers when re-issuing the cookie (stale token)', () => {
            const result = callMiddleware('stale-token-from-old-server', true);
            (0, chai_1.expect)(result.nextCalled).to.be.true;
            (0, chai_1.expect)(result.cookieCalls).to.have.length(1);
            (0, chai_1.expect)(result.requestHeaders['if-none-match']).to.be.undefined;
            (0, chai_1.expect)(result.requestHeaders['if-modified-since']).to.be.undefined;
        });
        it('should drop conditional request headers when issuing the cookie (no cookie)', () => {
            const result = callMiddleware(undefined, true);
            (0, chai_1.expect)(result.cookieCalls).to.have.length(1);
            (0, chai_1.expect)(result.requestHeaders['if-none-match']).to.be.undefined;
            (0, chai_1.expect)(result.requestHeaders['if-modified-since']).to.be.undefined;
        });
        it('should keep conditional request headers when the cookie is valid', () => {
            const result = callMiddleware(token.value, true);
            (0, chai_1.expect)(result.cookieCalls).to.have.length(0);
            (0, chai_1.expect)(result.requestHeaders['if-none-match']).to.equal('W/"etag"');
            (0, chai_1.expect)(result.requestHeaders['if-modified-since']).to.equal('Thu, 01 Jan 2026 00:00:00 GMT');
        });
    });
    describe('validateRequest (HTTP token enforcement)', () => {
        function callValidate(cookieValue) {
            const contribution = createContribution();
            const result = { nextCalled: false };
            const req = { headers: {} };
            if (cookieValue !== undefined) {
                req.headers.cookie = `${browser_connection_token_1.BROWSER_TOKEN_COOKIE_NAME}=${cookieValue}`;
            }
            const res = {
                sendStatus: (status) => { result.sentStatus = status; }
            };
            const next = () => { result.nextCalled = true; };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            contribution.validateRequest(req, res, next);
            return result;
        }
        it('should allow request with valid token cookie', () => {
            const result = callValidate(token.value);
            (0, chai_1.expect)(result.nextCalled).to.be.true;
            (0, chai_1.expect)(result.sentStatus).to.be.undefined;
        });
        it('should reject request with no cookie', () => {
            const result = callValidate();
            (0, chai_1.expect)(result.nextCalled).to.be.false;
            (0, chai_1.expect)(result.sentStatus).to.equal(403);
        });
        it('should reject request with invalid token', () => {
            const result = callValidate('wrong-token');
            (0, chai_1.expect)(result.nextCalled).to.be.false;
            (0, chai_1.expect)(result.sentStatus).to.equal(403);
        });
        it('should reject request with stale token from previous server', () => {
            const staleToken = (0, browser_connection_token_1.createBrowserConnectionToken)().value;
            const result = callValidate(staleToken);
            (0, chai_1.expect)(result.nextCalled).to.be.false;
            (0, chai_1.expect)(result.sentStatus).to.equal(403);
        });
        it('should reject request with empty token', () => {
            const result = callValidate('');
            (0, chai_1.expect)(result.nextCalled).to.be.false;
            (0, chai_1.expect)(result.sentStatus).to.equal(403);
        });
    });
    describe('Electron deployment (no-op)', () => {
        let originalIsElectron;
        beforeEach(() => {
            originalIsElectron = common_1.environment.electron.is;
            common_1.environment.electron.is = () => true;
        });
        afterEach(() => {
            common_1.environment.electron.is = originalIsElectron;
        });
        it('validateRequest should call next() without a cookie', () => {
            const contribution = createContribution();
            let nextCalled = false;
            let sentStatus;
            const req = { headers: {} };
            const res = { sendStatus: (status) => { sentStatus = status; } };
            const next = () => { nextCalled = true; };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            contribution.validateRequest(req, res, next);
            (0, chai_1.expect)(nextCalled).to.be.true;
            (0, chai_1.expect)(sentStatus).to.be.undefined;
        });
        it('allowWsUpgrade should return true without a cookie', () => {
            const contribution = createContribution();
            (0, chai_1.expect)(contribution.allowWsUpgrade(createRequest())).to.be.true;
        });
    });
});
//# sourceMappingURL=browser-connection-token.spec.js.map