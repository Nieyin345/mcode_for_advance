"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
var PluginDebugSession_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginDebugSessionFactory = exports.PluginDebugSession = exports.PluginTerminalOptionsExt = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const debug_session_contribution_1 = require("@theia/debug/lib/browser/debug-session-contribution");
const debug_session_1 = require("@theia/debug/lib/browser/debug-session");
const debug_session_connection_1 = require("@theia/debug/lib/browser/debug-session-connection");
exports.PluginTerminalOptionsExt = Symbol('PluginTerminalOptionsExt');
let PluginDebugSession = PluginDebugSession_1 = class PluginDebugSession extends debug_session_1.DebugSession {
    static createContainer(parent, data, connection, terminalOptionsExt) {
        const child = debug_session_1.DebugSession.createContainer(parent, data, connection);
        child.rebind(debug_session_1.DebugSession).to(PluginDebugSession_1);
        child.bind(exports.PluginTerminalOptionsExt).toConstantValue(terminalOptionsExt);
        return child;
    }
    async doCreateTerminal(terminalWidgetOptions) {
        terminalWidgetOptions = Object.assign({}, terminalWidgetOptions, this.terminalOptionsExt);
        return super.doCreateTerminal(terminalWidgetOptions);
    }
};
exports.PluginDebugSession = PluginDebugSession;
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.PluginTerminalOptionsExt),
    tslib_1.__metadata("design:type", Object)
], PluginDebugSession.prototype, "terminalOptionsExt", void 0);
exports.PluginDebugSession = PluginDebugSession = PluginDebugSession_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PluginDebugSession);
/**
 * Session factory for a client debug session that communicates with debug adapter contributed as plugin.
 * The main difference is to use a connection factory that creates [Channel](#Channel) over Rpc channel.
 */
class PluginDebugSessionFactory extends debug_session_contribution_1.DefaultDebugSessionFactory {
    constructor(connectionFactory, terminalOptionsExt, container) {
        super(container);
        this.connectionFactory = connectionFactory;
        this.terminalOptionsExt = terminalOptionsExt;
    }
    createSession(sessionId, options, parentSession) {
        const connection = new debug_session_connection_1.DebugSessionConnection(sessionId, this.connectionFactory, this.getTraceOutputChannel());
        const data = {
            id: sessionId,
            options,
            parentSession,
        };
        const child = PluginDebugSession.createContainer(this.container, data, connection, this.terminalOptionsExt);
        return child.get(debug_session_1.DebugSession);
    }
}
exports.PluginDebugSessionFactory = PluginDebugSessionFactory;
//# sourceMappingURL=plugin-debug-session-factory.js.map