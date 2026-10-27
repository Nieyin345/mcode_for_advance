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
exports.WsOriginValidator = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const backend_application_hosts_1 = require("./backend-application-hosts");
let WsOriginValidator = class WsOriginValidator {
    allowWsUpgrade(request) {
        if (!request.headers.origin) {
            // Browsers omit the Origin header for same-origin requests (e.g. Socket.IO polling).
            // Absent Origin is safe: cross-origin browser requests always include it.
            return true;
        }
        let originHost;
        try {
            originHost = new URL(request.headers.origin).host;
        }
        catch {
            return false;
        }
        if (this.backendApplicationHosts.hasKnownHosts()) {
            // When THEIA_HOSTS is configured, validate against the explicit allowlist.
            return this.backendApplicationHosts.hosts.has(originHost);
        }
        // When THEIA_HOSTS is not configured (the common development/default case),
        // enforce same-origin: the Origin's host must match the request's Host header.
        const hostHeader = request.headers.host;
        if (!hostHeader) {
            return false;
        }
        return originHost === hostHeader;
    }
};
exports.WsOriginValidator = WsOriginValidator;
tslib_1.__decorate([
    (0, inversify_1.inject)(backend_application_hosts_1.BackendApplicationHosts),
    tslib_1.__metadata("design:type", backend_application_hosts_1.BackendApplicationHosts)
], WsOriginValidator.prototype, "backendApplicationHosts", void 0);
exports.WsOriginValidator = WsOriginValidator = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WsOriginValidator);
//# sourceMappingURL=ws-origin-validator.js.map