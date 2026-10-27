"use strict";
// *****************************************************************************
// Copyright (C) 2026 STMicroelectronics and others.
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
exports.SimpleStopwatch = void 0;
/* eslint-disable @typescript-eslint/no-explicit-any */
const logger_1 = require("../logger");
const stopwatch_1 = require("./stopwatch");
/**
 * A simple {@link Stopwatch} that uses a caller-supplied time function and logs
 * via `console`. Usable without Inversify DI: this class does not assign nor
 * use the inherited `logger` field.
 */
class SimpleStopwatch extends stopwatch_1.Stopwatch {
    constructor(owner, now) {
        super({ owner, now });
    }
    start(name, options) {
        const now = this.defaultLogOptions.now;
        const startTime = now();
        return this.createMeasurement(name, () => ({
            startTime,
            duration: now() - startTime
        }), options);
    }
    log(measurement, activity, options) {
        const elapsed = measurement.stop();
        const level = this.logLevel(elapsed, options);
        if (Number.isNaN(elapsed)) {
            switch (level) {
                case logger_1.LogLevel.ERROR:
                case logger_1.LogLevel.FATAL:
                    break;
                default:
                    return;
            }
        }
        const origin = options.owner ?? 'application';
        const timeFromStart = `${(options.now() / 1000).toFixed(3)} s since ${origin} start`;
        const whatWasMeasured = options.context ? `[${options.context}] ${activity}` : activity;
        const message = `${whatWasMeasured}: ${elapsed.toFixed(1)} ms [${timeFromStart}]`;
        const args = options.arguments ?? [];
        switch (level) {
            case logger_1.LogLevel.FATAL:
            case logger_1.LogLevel.ERROR:
                console.error(message, ...args);
                break;
            case logger_1.LogLevel.WARN:
                console.warn(message, ...args);
                break;
            case logger_1.LogLevel.INFO:
                console.info(message, ...args);
                break;
            case logger_1.LogLevel.DEBUG:
                console.debug(message, ...args);
                break;
            case logger_1.LogLevel.TRACE:
                console.trace(message, ...args);
                break;
            default:
                console.log(message, ...args);
                break;
        }
    }
}
exports.SimpleStopwatch = SimpleStopwatch;
//# sourceMappingURL=simple-stopwatch.js.map