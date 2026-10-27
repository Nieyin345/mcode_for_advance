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
exports.setupPluginHostLogger = setupPluginHostLogger;
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const logger_1 = require("../../plugin/logger");
const util_1 = require("util");
function setupPluginHostLogger(rpc) {
    const logger = new logger_1.PluginLogger(rpc, 'plugin-host');
    function createLog(level) {
        return (message, ...params) => {
            // Format the messages beforehand
            // This ensures that we don't accidentally send objects that are not serializable
            const formatted = (0, util_1.format)(message, ...params);
            logger.log(level, formatted);
        };
    }
    console.log = console.info = createLog(plugin_api_rpc_1.LogLevel.Info);
    console.debug = createLog(plugin_api_rpc_1.LogLevel.Debug);
    console.warn = createLog(plugin_api_rpc_1.LogLevel.Warn);
    console.error = createLog(plugin_api_rpc_1.LogLevel.Error);
    console.trace = createLog(plugin_api_rpc_1.LogLevel.Trace);
}
//# sourceMappingURL=plugin-host-logger.js.map