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
const electron_ws_origin_validator_1 = require("./electron-ws-origin-validator");
describe('ElectronWsOriginValidator', () => {
    function createValidator(isRemote = false) {
        const remoteService = { isRemoteServer: () => isRemote };
        const validator = new electron_ws_origin_validator_1.ElectronWsOriginValidator();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validator['backendRemoteService'] = remoteService;
        return validator;
    }
    function createRequest(origin) {
        const request = {
            headers: {}
        };
        if (origin !== undefined) {
            request.headers.origin = origin;
        }
        return request;
    }
    it('should allow file:// origin (standard Electron case)', () => {
        (0, chai_1.expect)(createValidator().allowWsUpgrade(createRequest('file://'))).to.be.true;
    });
    it('should allow null origin (opaque origin from file:// pages)', () => {
        (0, chai_1.expect)(createValidator().allowWsUpgrade(createRequest('null'))).to.be.true;
    });
    it('should allow absent origin (same-origin polling requests)', () => {
        (0, chai_1.expect)(createValidator().allowWsUpgrade(createRequest(undefined))).to.be.true;
    });
    it('should reject cross-origin requests', () => {
        (0, chai_1.expect)(createValidator().allowWsUpgrade(createRequest('http://evil.com'))).to.be.false;
    });
    it('should reject http://localhost origin (not expected in Electron)', () => {
        (0, chai_1.expect)(createValidator().allowWsUpgrade(createRequest('http://localhost:3000'))).to.be.false;
    });
    it('should allow empty string origin (treated as absent)', () => {
        (0, chai_1.expect)(createValidator().allowWsUpgrade(createRequest(''))).to.be.true;
    });
    it('should allow any origin when running as remote server', () => {
        (0, chai_1.expect)(createValidator(true).allowWsUpgrade(createRequest('http://remote-host.com'))).to.be.true;
    });
});
//# sourceMappingURL=electron-ws-origin-validator.spec.js.map