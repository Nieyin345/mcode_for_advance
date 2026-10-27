"use strict";
// *****************************************************************************
// Copyright (C) 2025 TypeFox and others.
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
exports.PluginLogger = void 0;
/* eslint-disable @typescript-eslint/no-explicit-any */
const common_1 = require("../common");
class PluginLogger {
    constructor(rpc, name) {
        this.name = name;
        this.logger = rpc.getProxy(common_1.PLUGIN_RPC_CONTEXT.LOGGER_MAIN);
    }
    trace(message, ...params) {
        this.sendLog(common_1.LogLevel.Trace, message, params);
    }
    debug(message, ...params) {
        this.sendLog(common_1.LogLevel.Debug, message, params);
    }
    log(logLevel, message, ...params) {
        this.sendLog(logLevel, message, params);
    }
    info(message, ...params) {
        this.sendLog(common_1.LogLevel.Info, message, params);
    }
    warn(message, ...params) {
        this.sendLog(common_1.LogLevel.Warn, message, params);
    }
    error(message, ...params) {
        this.sendLog(common_1.LogLevel.Error, message, params);
    }
    sendLog(level, message, params) {
        this.logger.$log(level, this.name, this.toLog(message), params.map(e => this.toLog(e)));
    }
    toLog(value) {
        if (value instanceof Error) {
            return value.stack ?? value.message ?? value.toString();
        }
        return value;
    }
}
exports.PluginLogger = PluginLogger;
//# sourceMappingURL=logger.js.map