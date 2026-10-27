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
const proxy_util_1 = require("./proxy-util");
describe('proxy-util', () => {
    describe('shouldBypassProxy', () => {
        it('should return false when targetUrl is undefined', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)(undefined, 'localhost')).to.be.false;
        });
        it('should return false when noProxyValue is undefined', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://example.com', undefined)).to.be.false;
        });
        it('should return false when noProxyValue is empty', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://example.com', '')).to.be.false;
        });
        it('should return false when targetUrl cannot be parsed', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('not-a-url', 'localhost')).to.be.false;
        });
        it('should match exact hostname (case-insensitive)', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://myhost.local/v1', 'myhost.local')).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://MyHost.Local/v1', 'myhost.local')).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://myhost.local/v1', 'MyHost.Local')).to.be.true;
        });
        it('should not match partial hostname', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://notmyhost.local', 'myhost.local')).to.be.false;
        });
        it('should match domain suffix with leading dot', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://api.example.com/v1', '.example.com')).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://deep.sub.example.com', '.example.com')).to.be.true;
        });
        it('should match exact domain for leading dot rule', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://example.com/v1', '.example.com')).to.be.true;
        });
        it('should match suffix without leading dot', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://sub.example.com/v1', 'example.com')).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://example.com/v1', 'example.com')).to.be.true;
        });
        it('should match wildcard', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://anything.com', '*')).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('https://secure.host.org/path', '*')).to.be.true;
        });
        it('should match IP addresses', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://192.168.1.100:8080/v1', '192.168.1.100')).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://192.168.1.100/v1', '192.168.1.100')).to.be.true;
        });
        it('should not match different IP addresses', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://192.168.1.101/v1', '192.168.1.100')).to.be.false;
        });
        it('should match port-specific rules', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://myhost:8080/v1', 'myhost:8080')).to.be.true;
        });
        it('should not match when port differs', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://myhost:9090/v1', 'myhost:8080')).to.be.false;
        });
        it('should not match port-specific rule when target has no port', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://myhost/v1', 'myhost:8080')).to.be.false;
        });
        it('should trim whitespace around entries', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://example.com', '  example.com  ')).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://foo.com', ' foo.com , bar.com ')).to.be.true;
        });
        it('should handle multiple comma-separated rules', () => {
            const noProxy = 'localhost,127.0.0.1,.internal.net';
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://localhost/api', noProxy)).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://127.0.0.1:3000', noProxy)).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://service.internal.net', noProxy)).to.be.true;
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://external.com', noProxy)).to.be.false;
        });
        it('should skip empty rules from consecutive commas', () => {
            (0, chai_1.expect)((0, proxy_util_1.shouldBypassProxy)('http://example.com', 'example.com,,localhost')).to.be.true;
        });
    });
});
//# sourceMappingURL=proxy-util.spec.js.map