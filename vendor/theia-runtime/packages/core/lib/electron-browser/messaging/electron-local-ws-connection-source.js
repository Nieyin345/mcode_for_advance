"use strict";
// *****************************************************************************
// Copyright (C) 2023 TypeFox and others.
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
exports.ElectronLocalWebSocketConnectionSource = exports.CURRENT_PORT_PARAM = exports.LOCAL_PORT_PARAM = void 0;
exports.getLocalPort = getLocalPort;
exports.getCurrentPort = getCurrentPort;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const endpoint_1 = require("../../browser/endpoint");
const ws_connection_source_1 = require("../../browser/messaging/ws-connection-source");
exports.LOCAL_PORT_PARAM = 'localPort';
function getLocalPort() {
    const params = new URLSearchParams(location.search);
    return params.get(exports.LOCAL_PORT_PARAM) ?? undefined;
}
exports.CURRENT_PORT_PARAM = 'port';
function getCurrentPort() {
    const params = new URLSearchParams(location.search);
    return params.get(exports.CURRENT_PORT_PARAM) ?? undefined;
}
let ElectronLocalWebSocketConnectionSource = class ElectronLocalWebSocketConnectionSource extends ws_connection_source_1.WebSocketConnectionSource {
    createEndpoint(path) {
        const localPort = getLocalPort();
        if (!localPort) {
            throw new Error('This should only be called in case there is a local port specified!');
        }
        const endpoint = new endpoint_1.Endpoint({
            path
        }, {
            host: `localhost:${localPort}`,
            pathname: '/',
            protocol: 'http',
            search: ''
        });
        return endpoint;
    }
};
exports.ElectronLocalWebSocketConnectionSource = ElectronLocalWebSocketConnectionSource;
exports.ElectronLocalWebSocketConnectionSource = ElectronLocalWebSocketConnectionSource = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ElectronLocalWebSocketConnectionSource);
//# sourceMappingURL=electron-local-ws-connection-source.js.map