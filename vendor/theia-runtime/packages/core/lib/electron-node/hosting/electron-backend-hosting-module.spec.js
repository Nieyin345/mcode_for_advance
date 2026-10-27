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
const inversify_1 = require("inversify");
const electron_backend_hosting_module_1 = require("./electron-backend-hosting-module");
const browser_connection_token_1 = require("../../node/hosting/browser-connection-token");
describe('electron-backend-hosting-module', () => {
    it('should bind a no-op HttpConnectionValidator that calls next() unconditionally', () => {
        const container = new inversify_1.Container();
        container.load(electron_backend_hosting_module_1.default);
        const validator = container.get(browser_connection_token_1.HttpConnectionValidator);
        let nextCalled = false;
        let sentStatus;
        // No cookie provided: the no-op validator must still call next() and never send a status.
        const req = { headers: {} };
        const res = { sendStatus: (status) => { sentStatus = status; } };
        const next = () => { nextCalled = true; };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validator.validateRequest(req, res, next);
        (0, chai_1.expect)(nextCalled).to.be.true;
        (0, chai_1.expect)(sentStatus).to.be.undefined;
    });
});
//# sourceMappingURL=electron-backend-hosting-module.spec.js.map