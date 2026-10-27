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
const ws_origin_validator_1 = require("./ws-origin-validator");
const backend_application_hosts_1 = require("./backend-application-hosts");
describe('WsOriginValidator', () => {
    function createValidator(hosts) {
        const backendHosts = new backend_application_hosts_1.BackendApplicationHosts();
        if (hosts) {
            for (const h of hosts) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                backendHosts['_hosts'].add(h);
            }
        }
        const validator = new ws_origin_validator_1.WsOriginValidator();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validator['backendApplicationHosts'] = backendHosts;
        return validator;
    }
    function createRequest(origin, host) {
        const request = {
            headers: {}
        };
        if (origin !== undefined) {
            request.headers.origin = origin;
        }
        if (host !== undefined) {
            request.headers.host = host;
        }
        return request;
    }
    describe('when THEIA_HOSTS is not set', () => {
        it('should allow same-origin requests', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://localhost:3000', 'localhost:3000'))).to.be.true;
        });
        it('should allow same-origin requests on default ports', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://myhost.com', 'myhost.com'))).to.be.true;
        });
        it('should reject cross-origin requests', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://evil.com', 'localhost:3000'))).to.be.false;
        });
        it('should allow requests with no Origin header (same-origin polling)', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest(undefined, 'localhost:3000'))).to.be.true;
        });
        it('should reject requests with no Host header when Origin is present', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://localhost:3000', undefined))).to.be.false;
        });
        it('should reject requests with malformed Origin', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('not-a-valid-url', 'localhost:3000'))).to.be.false;
        });
    });
    describe('when THEIA_HOSTS is set', () => {
        it('should allow requests from a listed host', () => {
            const validator = createValidator(['myhost.com']);
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://myhost.com', 'myhost.com'))).to.be.true;
        });
        it('should allow requests from a listed host with port', () => {
            const validator = createValidator(['myhost.com:8080']);
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://myhost.com:8080', 'myhost.com:8080'))).to.be.true;
        });
        it('should reject requests from an unlisted host', () => {
            const validator = createValidator(['myhost.com']);
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://evil.com', 'myhost.com'))).to.be.false;
        });
        it('should allow requests with no Origin header (same-origin polling)', () => {
            const validator = createValidator(['myhost.com']);
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest(undefined, 'myhost.com'))).to.be.true;
        });
        it('should allow when origin host is in the allowlist regardless of Host header', () => {
            const validator = createValidator(['myhost.com']);
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://myhost.com', 'internal-host:3000'))).to.be.true;
        });
        it('should reject malformed Origin even with THEIA_HOSTS', () => {
            const validator = createValidator(['myhost.com']);
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('not-a-valid-url', 'myhost.com'))).to.be.false;
        });
    });
    describe('edge cases', () => {
        it('should reject cross-origin with port mismatch', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://localhost:4000', 'localhost:3000'))).to.be.false;
        });
        it('should handle HTTPS origins', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('https://localhost:3000', 'localhost:3000'))).to.be.true;
        });
        it('should reject Origin: null (opaque origin from sandboxed pages)', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('null', 'localhost:3000'))).to.be.false;
        });
        it('should allow empty Origin string (treated as absent)', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('', 'localhost:3000'))).to.be.true;
        });
        it('should handle IPv6 same-origin', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://[::1]:3000', '[::1]:3000'))).to.be.true;
        });
        it('should strip credentials from Origin when comparing', () => {
            const validator = createValidator();
            // new URL('http://user:pass@localhost:3000').host === 'localhost:3000'
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://user:pass@localhost:3000', 'localhost:3000'))).to.be.true;
        });
        it('should ignore path component in Origin', () => {
            const validator = createValidator();
            (0, chai_1.expect)(validator.allowWsUpgrade(createRequest('http://localhost:3000/some/path', 'localhost:3000'))).to.be.true;
        });
    });
});
//# sourceMappingURL=ws-origin-validator.spec.js.map