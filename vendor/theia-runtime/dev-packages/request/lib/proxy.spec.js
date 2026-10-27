"use strict";
/********************************************************************************
 * Copyright (C) 2026 EclipseSource GmbH.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
 ********************************************************************************/
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const proxy_1 = require("./proxy");
describe('proxy', () => {
    describe('getProxyAgent', () => {
        it('should return undefined when no proxy is configured', () => {
            const agent = (0, proxy_1.getProxyAgent)('https://example.com', {});
            (0, chai_1.expect)(agent).to.be.undefined;
        });
        it('should return a dispatcher when proxy URL is provided via options', () => {
            const agent = (0, proxy_1.getProxyAgent)('https://example.com', {}, {
                proxyUrl: 'http://proxy.example.com:8080'
            });
            (0, chai_1.expect)(agent).to.not.be.undefined;
        });
        it('should return a dispatcher when HTTP_PROXY env variable is set for http URLs', () => {
            const env = { HTTP_PROXY: 'http://proxy.example.com:8080' };
            const agent = (0, proxy_1.getProxyAgent)('http://example.com', env);
            (0, chai_1.expect)(agent).to.not.be.undefined;
        });
        it('should return a dispatcher when http_proxy env variable is set for http URLs', () => {
            const env = { http_proxy: 'http://proxy.example.com:8080' };
            const agent = (0, proxy_1.getProxyAgent)('http://example.com', env);
            (0, chai_1.expect)(agent).to.not.be.undefined;
        });
        it('should return a dispatcher when HTTPS_PROXY env variable is set for https URLs', () => {
            const env = { HTTPS_PROXY: 'http://proxy.example.com:8080' };
            const agent = (0, proxy_1.getProxyAgent)('https://example.com', env);
            (0, chai_1.expect)(agent).to.not.be.undefined;
        });
        it('should fall back to HTTP_PROXY for https URLs when HTTPS_PROXY is not set', () => {
            const env = { HTTP_PROXY: 'http://proxy.example.com:8080' };
            const agent = (0, proxy_1.getProxyAgent)('https://example.com', env);
            (0, chai_1.expect)(agent).to.not.be.undefined;
        });
        it('should return undefined for invalid request URLs', () => {
            const agent = (0, proxy_1.getProxyAgent)('not-a-url', {}, {
                proxyUrl: 'http://proxy.example.com:8080'
            });
            (0, chai_1.expect)(agent).to.be.undefined;
        });
        it('should return undefined for non-http proxy protocols', () => {
            const agent = (0, proxy_1.getProxyAgent)('https://example.com', {}, {
                proxyUrl: 'socks5://proxy.example.com:1080'
            });
            (0, chai_1.expect)(agent).to.be.undefined;
        });
        it('should return undefined for invalid proxy URLs', () => {
            const agent = (0, proxy_1.getProxyAgent)('https://example.com', {}, {
                proxyUrl: 'not-a-valid-url'
            });
            (0, chai_1.expect)(agent).to.be.undefined;
        });
        it('should return an Agent (not ProxyAgent) when strictSSL is false and no proxy is set', () => {
            const agent = (0, proxy_1.getProxyAgent)('https://example.com', {}, {
                strictSSL: false
            });
            (0, chai_1.expect)(agent).to.not.be.undefined;
        });
        it('should prefer proxyUrl option over environment variables', () => {
            const env = { HTTP_PROXY: 'http://env-proxy.example.com:8080' };
            const agent = (0, proxy_1.getProxyAgent)('http://example.com', env, {
                proxyUrl: 'http://option-proxy.example.com:9090'
            });
            (0, chai_1.expect)(agent).to.not.be.undefined;
        });
    });
});
//# sourceMappingURL=proxy.spec.js.map