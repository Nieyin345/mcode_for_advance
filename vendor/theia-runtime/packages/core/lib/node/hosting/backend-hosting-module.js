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
const backend_application_1 = require("../backend-application");
const ws_request_validators_1 = require("../ws-request-validators");
const backend_application_hosts_1 = require("./backend-application-hosts");
const browser_connection_token_1 = require("./browser-connection-token");
const ws_origin_validator_1 = require("./ws-origin-validator");
exports.default = new inversify_1.ContainerModule(bind => {
    bind(backend_application_hosts_1.BackendApplicationHosts).toSelf().inSingletonScope();
    bind(ws_origin_validator_1.WsOriginValidator).toSelf().inSingletonScope();
    bind(ws_request_validators_1.WsRequestValidatorContribution).toService(ws_origin_validator_1.WsOriginValidator);
    // Cookie-based connection token. It is validated on WebSocket upgrades and bootstrapped
    // (set as a cookie) on every HTTP request; HTTP enforcement is opt-in per route via
    // `HttpConnectionValidator`.
    bind(browser_connection_token_1.BrowserConnectionToken).toConstantValue((0, browser_connection_token_1.createBrowserConnectionToken)());
    bind(browser_connection_token_1.BrowserConnectionTokenBackendContribution).toSelf().inSingletonScope();
    bind(backend_application_1.BackendApplicationContribution).toService(browser_connection_token_1.BrowserConnectionTokenBackendContribution);
    bind(ws_request_validators_1.WsRequestValidatorContribution).toService(browser_connection_token_1.BrowserConnectionTokenBackendContribution);
    bind(browser_connection_token_1.HttpConnectionValidator).toService(browser_connection_token_1.BrowserConnectionTokenBackendContribution);
});
//# sourceMappingURL=backend-hosting-module.js.map