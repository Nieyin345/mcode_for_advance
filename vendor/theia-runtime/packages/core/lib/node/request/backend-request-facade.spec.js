"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
const sinon = require("sinon");
const backend_request_facade_1 = require("./backend-request-facade");
const backend_application_config_provider_1 = require("../backend-application-config-provider");
describe('isUrlAllowed', () => {
    it('should allow a URL that matches an exact origin pattern', () => {
        const patterns = ['https://open-vsx.org'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://open-vsx.org/api/extensions', patterns)).to.be.true;
    });
    it('should allow a URL with a path when pattern has no path', () => {
        const patterns = ['https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com/some/deep/path?query=1', patterns)).to.be.true;
    });
    it('should allow a URL that exactly matches the origin', () => {
        const patterns = ['https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com', patterns)).to.be.true;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com/', patterns)).to.be.true;
    });
    it('should reject a URL with a different scheme', () => {
        const patterns = ['https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://example.com/path', patterns)).to.be.false;
    });
    it('should reject a URL with a different host', () => {
        const patterns = ['https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://evil.com/path', patterns)).to.be.false;
    });
    it('should reject a URL with a different port', () => {
        const patterns = ['https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com:8443/path', patterns)).to.be.false;
    });
    it('should allow a URL when port matches explicitly', () => {
        const patterns = ['https://example.com:8443'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com:8443/path', patterns)).to.be.true;
    });
    it('should treat default ports as equivalent', () => {
        const patterns = ['https://example.com:443'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com/path', patterns)).to.be.true;
        const httpPatterns = ['http://example.com:80'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://example.com/path', httpPatterns)).to.be.true;
        const implicitPatterns = ['http://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://example.com:80/path', implicitPatterns)).to.be.true;
    });
    it('should match wildcard subdomains', () => {
        const patterns = ['https://*.example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://foo.example.com/path', patterns)).to.be.true;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://bar.baz.example.com/path', patterns)).to.be.true;
    });
    it('should not match the bare domain with a wildcard subdomain pattern', () => {
        const patterns = ['https://*.example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com/path', patterns)).to.be.false;
    });
    it('should reject non-http(s) schemes', () => {
        const patterns = ['file:///etc/passwd'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('file:///etc/passwd', patterns)).to.be.false;
    });
    it('should reject ftp scheme', () => {
        const patterns = ['ftp://files.example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('ftp://files.example.com/data', patterns)).to.be.false;
    });
    it('should reject a URL when target uses non-http(s) scheme even if patterns exist', () => {
        const patterns = ['https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('file:///etc/passwd', patterns)).to.be.false;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('ftp://example.com/data', patterns)).to.be.false;
    });
    it('should reject all URLs when allowlist is empty', () => {
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com', [])).to.be.false;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://localhost:3000', [])).to.be.false;
    });
    it('should reject invalid URLs', () => {
        const patterns = ['https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('not a url', patterns)).to.be.false;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('', patterns)).to.be.false;
    });
    it('should allow private IPs only when explicitly in the allowlist', () => {
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://127.0.0.1:8080/secret', [])).to.be.false;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://127.0.0.1:8080/secret', ['https://example.com'])).to.be.false;
        const patternsWithLoopback = ['http://127.0.0.1:8080'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://127.0.0.1:8080/secret', patternsWithLoopback)).to.be.true;
    });
    it('should reject cloud metadata endpoint by default', () => {
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://169.254.169.254/latest/meta-data/', [])).to.be.false;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('http://169.254.169.254/latest/meta-data/', ['https://example.com'])).to.be.false;
    });
    it('should merge multiple patterns correctly', () => {
        const patterns = [
            'https://open-vsx.org',
            'https://marketplace.example.com',
            'https://*.cdn.example.com'
        ];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://open-vsx.org/api/v2/extensions', patterns)).to.be.true;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://marketplace.example.com/download', patterns)).to.be.true;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://files.cdn.example.com/ext.vsix', patterns)).to.be.true;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://evil.com/malware', patterns)).to.be.false;
    });
    it('should handle patterns with trailing slashes', () => {
        const patterns = ['https://example.com/'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com/path', patterns)).to.be.true;
    });
    it('should handle invalid patterns gracefully', () => {
        const patterns = ['not a valid pattern', 'https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com/path', patterns)).to.be.true;
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://other.com/path', patterns)).to.be.false;
    });
    it('should prevent host spoofing via subdomain prefix', () => {
        const patterns = ['https://example.com'];
        (0, chai_1.expect)((0, backend_request_facade_1.isUrlAllowed)('https://example.com.evil.com/path', patterns)).to.be.false;
    });
});
describe('BackendRequestFacade', () => {
    describe('configure', () => {
        let configProviderStub;
        beforeEach(() => {
            configProviderStub = sinon.stub(backend_application_config_provider_1.BackendApplicationConfigProvider, 'get');
        });
        afterEach(() => {
            configProviderStub.restore();
        });
        it('should be a no-op when configureProxyFromPreferences is false', async () => {
            configProviderStub.returns({
                singleInstance: true,
                frontendConnectionTimeout: 0,
                configurationFolder: '.theia',
                configureProxyFromPreferences: false
            });
            const facade = new backend_request_facade_1.BackendRequestFacade();
            const configureStub = sinon.stub().resolves();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            facade.requestService = {
                configure: configureStub
            };
            await facade.configure({ proxyUrl: 'http://evil.com', strictSSL: false });
            (0, chai_1.expect)(configureStub.called).to.be.false;
        });
        it('should pass through to the underlying request service when configureProxyFromPreferences is true', async () => {
            configProviderStub.returns({
                singleInstance: true,
                frontendConnectionTimeout: 0,
                configurationFolder: '.theia',
                configureProxyFromPreferences: true
            });
            const facade = new backend_request_facade_1.BackendRequestFacade();
            const configureStub = sinon.stub().resolves();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            facade.requestService = {
                configure: configureStub
            };
            const config = { proxyUrl: 'http://my-proxy.com:8080', strictSSL: true, proxyAuthorization: 'Bearer token' };
            await facade.configure(config);
            (0, chai_1.expect)(configureStub.calledOnce).to.be.true;
            (0, chai_1.expect)(configureStub.firstCall.args[0]).to.deep.equal(config);
        });
    });
});
//# sourceMappingURL=backend-request-facade.spec.js.map