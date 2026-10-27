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
exports.bindCommonLogger = bindCommonLogger;
const logger_1 = require("./logger");
const logger_watcher_1 = require("./logger-watcher");
const logger_sanitizer_1 = require("./logger-sanitizer");
function bindCommonLogger(bind) {
    bind(logger_1.LoggerName).toConstantValue(logger_1.rootLoggerName);
    bind(logger_1.ILogger).to(logger_1.Logger).inSingletonScope().when(request => getName(request) === undefined);
    bind(logger_1.ILogger).toDynamicValue(ctx => {
        const logger = ctx.container.get(logger_1.ILogger);
        return logger.child(getName(ctx.currentRequest));
    }).when(request => getName(request) !== undefined);
    bind(logger_watcher_1.LoggerWatcher).toSelf().inSingletonScope();
    bind(logger_sanitizer_1.LoggerSanitizer).to(logger_sanitizer_1.DefaultLoggerSanitizer).inSingletonScope();
}
function getName(request) {
    const named = request.target.metadata.find(e => e.key === 'named');
    return named ? named.value?.toString() : undefined;
}
//# sourceMappingURL=logger-binding.js.map