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
exports.BrowserConnectionTokenBackendContribution = exports.HttpConnectionValidator = exports.BROWSER_TOKEN_COOKIE_NAME = exports.BrowserConnectionToken = void 0;
exports.createBrowserConnectionToken = createBrowserConnectionToken;
const tslib_1 = require("tslib");
const cookie = require("cookie");
const crypto = require("crypto");
const inversify_1 = require("inversify");
const index_1 = require("../../common/index");
const backend_application_1 = require("../backend-application");
const uuid_1 = require("../../common/uuid");
const logger_1 = require("../../common/logger");
exports.BrowserConnectionToken = Symbol('BrowserConnectionToken');
exports.BROWSER_TOKEN_COOKIE_NAME = 'theia-connection-token';
exports.HttpConnectionValidator = Symbol('HttpConnectionValidator');
/**
 * Validates WebSocket and HTTP requests using a cookie-based connection token.
 *
 * In browser deployments, the server generates a random token at startup and sets it
 * as a `SameSite=Strict; HttpOnly` cookie on the first page load. Cross-origin pages
 * cannot obtain or send this cookie, so their requests are rejected.
 *
 * The cookie is *bootstrapped* for every HTTP request (via {@link expressMiddleware}) so that
 * browsers always receive it, but HTTP requests are only *rejected* on routes that opt in to
 * enforcement via {@link validateRequest} (see {@link HttpConnectionValidator}). WebSocket
 * upgrades are always validated (see {@link allowWsUpgrade}).
 *
 * This complements the origin validator: non-browser callers that omit the Origin
 * header (e.g. Node.js scripts) still cannot reach the backend without the cookie.
 *
 * Skipped in Electron deployments (which use their own `ElectronSecurityToken`).
 */
let BrowserConnectionTokenBackendContribution = class BrowserConnectionTokenBackendContribution {
    /**
     * Register the cookie middleware during `initialize()` via `EarlyExpressMiddleware`
     * so it runs before `express.static()` (which is registered later during `configure()`).
     * This ensures the browser receives the token cookie on the initial page load.
     */
    initialize() {
        if (index_1.environment.electron.is()) {
            return;
        }
        this.earlyMiddleware.handlers.push((req, res, next) => this.expressMiddleware(req, res, next));
    }
    /**
     * Validate the connection token cookie on WebSocket upgrade requests.
     * Non-browser callers that omit the Origin header (e.g. Node.js scripts)
     * cannot provide the `SameSite=Strict` cookie either, so they are rejected.
     */
    allowWsUpgrade(request) {
        if (index_1.environment.electron.is()) {
            return true;
        }
        const token = this.getTokenFromCookie(request);
        if (token) {
            return this.isTokenValid(token);
        }
        // No cookie: reject. Legitimate browsers always have the cookie
        // because it is set on the initial page load.
        return false;
    }
    /**
     * Reject the request with `403` unless it carries a valid connection-token cookie.
     * Always allows the request in Electron deployments, consistent with {@link allowWsUpgrade}.
     */
    validateRequest(req, res, next) {
        if (index_1.environment.electron.is()) {
            next();
            return;
        }
        const token = this.getTokenFromCookie(req);
        if (token && this.isTokenValid(token)) {
            next();
            return;
        }
        // No cookie or stale/invalid token: reject. Legitimate browsers always have the cookie
        // because it is set on the initial page load, and same-origin requests send it automatically.
        res.sendStatus(403);
    }
    expressMiddleware(req, res, next) {
        const existing = this.getTokenFromCookie(req);
        if (!existing || !this.isTokenValid(existing)) {
            // No cookie or stale cookie (e.g. after server restart) so (re-)issue it.
            // The browser will use the fresh token on subsequent requests.
            res.cookie(exports.BROWSER_TOKEN_COOKIE_NAME, this.browserConnectionToken.value, {
                httpOnly: true,
                sameSite: 'strict',
                path: '/'
            });
            // The static handlers would answer a revalidation of an unchanged page with a 304,
            // and reverse proxies commonly drop Set-Cookie from 304 replies or answer the
            // revalidation from their own cache. The browser would then keep the stale token
            // and every WebSocket handshake would be rejected, with no way to recover short of
            // a cache-bypassing hard reload. Force a full 200 so the cookie reaches the browser.
            delete req.headers['if-none-match'];
            delete req.headers['if-modified-since'];
        }
        next();
    }
    getTokenFromCookie(req) {
        const cookieHeader = req.headers.cookie;
        if (cookieHeader) {
            return cookie.parse(cookieHeader)[exports.BROWSER_TOKEN_COOKIE_NAME];
        }
        return undefined;
    }
    isTokenValid(token) {
        try {
            const received = Buffer.from(token, 'utf8');
            const expected = Buffer.from(this.browserConnectionToken.value, 'utf8');
            return received.byteLength === expected.byteLength && crypto.timingSafeEqual(received, expected);
        }
        catch (error) {
            this.logger.error(error);
        }
        return false;
    }
};
exports.BrowserConnectionTokenBackendContribution = BrowserConnectionTokenBackendContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.BrowserConnectionToken),
    tslib_1.__metadata("design:type", Object)
], BrowserConnectionTokenBackendContribution.prototype, "browserConnectionToken", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(backend_application_1.EarlyExpressMiddleware),
    tslib_1.__metadata("design:type", backend_application_1.EarlyExpressMiddleware)
], BrowserConnectionTokenBackendContribution.prototype, "earlyMiddleware", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('core:BrowserConnectionTokenBackendContribution'),
    tslib_1.__metadata("design:type", Object)
], BrowserConnectionTokenBackendContribution.prototype, "logger", void 0);
exports.BrowserConnectionTokenBackendContribution = BrowserConnectionTokenBackendContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserConnectionTokenBackendContribution);
/**
 * Creates a new browser connection token.
 */
function createBrowserConnectionToken() {
    return { value: (0, uuid_1.generateUuid)() };
}
//# sourceMappingURL=browser-connection-token.js.map