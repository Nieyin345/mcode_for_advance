"use strict";
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
exports.MCPServerManagerPath = exports.MCPServerStatus = exports.MCPServerManager = exports.MCPFrontendNotificationService = exports.MCPFrontendService = void 0;
exports.isLocalMCPServerDescription = isLocalMCPServerDescription;
exports.isRemoteMCPServerDescription = isRemoteMCPServerDescription;
exports.MCPFrontendService = Symbol('MCPFrontendService');
exports.MCPFrontendNotificationService = Symbol('MCPFrontendNotificationService');
exports.MCPServerManager = Symbol('MCPServerManager');
var MCPServerStatus;
(function (MCPServerStatus) {
    MCPServerStatus["NotRunning"] = "Not Running";
    MCPServerStatus["NotConnected"] = "Not Connected";
    MCPServerStatus["Starting"] = "Starting";
    MCPServerStatus["Connecting"] = "Connecting";
    MCPServerStatus["Running"] = "Running";
    MCPServerStatus["Connected"] = "Connected";
    MCPServerStatus["AuthenticationRequired"] = "Authentication Required";
    MCPServerStatus["Errored"] = "Errored";
})(MCPServerStatus || (exports.MCPServerStatus = MCPServerStatus = {}));
function isLocalMCPServerDescription(description) {
    return 'command' in description;
}
function isRemoteMCPServerDescription(description) {
    return 'serverUrl' in description;
}
exports.MCPServerManagerPath = '/services/mcpservermanager';
//# sourceMappingURL=mcp-server-manager.js.map