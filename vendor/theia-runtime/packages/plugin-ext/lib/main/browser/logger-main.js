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
exports.LoggerMainImpl = void 0;
const common_1 = require("../../common");
const core_1 = require("@theia/core");
class LoggerMainImpl {
    constructor(container) {
        this.container = container;
    }
    $log(level, name, message, params) {
        let logger;
        if (name) {
            logger = this.container.getNamed(core_1.ILogger, name);
        }
        else {
            logger = this.container.get(core_1.ILogger);
        }
        switch (level) {
            case common_1.LogLevel.Trace:
                logger.trace(message, ...params);
                break;
            case common_1.LogLevel.Debug:
                logger.debug(message, ...params);
                break;
            case common_1.LogLevel.Info:
                logger.info(message, ...params);
                break;
            case common_1.LogLevel.Warn:
                logger.warn(message, ...params);
                break;
            case common_1.LogLevel.Error:
                logger.error(message, ...params);
                break;
        }
    }
}
exports.LoggerMainImpl = LoggerMainImpl;
//# sourceMappingURL=logger-main.js.map