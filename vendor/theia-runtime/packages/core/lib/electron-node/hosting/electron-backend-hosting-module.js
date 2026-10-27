"use strict";
// *****************************************************************************
// Copyright (C) 2020 Ericsson and others.
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
const inversify_1 = require("inversify");
const ws_request_validators_1 = require("../../node/ws-request-validators");
const browser_connection_token_1 = require("../../node/hosting/browser-connection-token");
const electron_ws_origin_validator_1 = require("./electron-ws-origin-validator");
exports.default = new inversify_1.ContainerModule(bind => {
    bind(electron_ws_origin_validator_1.ElectronWsOriginValidator).toSelf().inSingletonScope();
    bind(ws_request_validators_1.WsRequestValidatorContribution).toService(electron_ws_origin_validator_1.ElectronWsOriginValidator);
    // Electron uses its own `ElectronSecurityToken`, so the connection-token cookie is not used.
    // Bind a no-op validator so consumers can inject it uniformly.
    const noopValidator = {
        validateRequest: (_req, _res, next) => next()
    };
    bind(browser_connection_token_1.HttpConnectionValidator).toConstantValue(noopValidator);
});
//# sourceMappingURL=electron-backend-hosting-module.js.map