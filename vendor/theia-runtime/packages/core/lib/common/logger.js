"use strict";
// *****************************************************************************
// Copyright (C) 2017 Ericsson and others.
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
exports.Logger = exports.ILogger = exports.LoggerName = exports.LoggerFactory = exports.logger = exports.rootLoggerName = exports.LogLevel = void 0;
exports.unsetRootLogger = unsetRootLogger;
exports.setRootLogger = setRootLogger;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const logger_watcher_1 = require("./logger-watcher");
const logger_protocol_1 = require("./logger-protocol");
Object.defineProperty(exports, "LogLevel", { enumerable: true, get: function () { return logger_protocol_1.LogLevel; } });
Object.defineProperty(exports, "rootLoggerName", { enumerable: true, get: function () { return logger_protocol_1.rootLoggerName; } });
const logger_sanitizer_1 = require("./logger-sanitizer");
/**
 * Counterpart of the `#setRootLogger(ILogger)`. Restores the `console.xxx` bindings to the original one.
 * Invoking has no side-effect if `setRootLogger` was not called before. Multiple function invocation has
 * no side-effect either.
 */
function unsetRootLogger() {
    if (exports.logger !== undefined) {
        logger_protocol_1.ConsoleLogger.reset();
        exports.logger = undefined;
    }
}
function setRootLogger(aLogger) {
    exports.logger = aLogger;
    const log = (logLevel, message, ...optionalParams) => exports.logger.log(logLevel, message, ...optionalParams);
    console.error = log.bind(undefined, logger_protocol_1.LogLevel.ERROR);
    console.warn = log.bind(undefined, logger_protocol_1.LogLevel.WARN);
    console.info = log.bind(undefined, logger_protocol_1.LogLevel.INFO);
    console.debug = log.bind(undefined, logger_protocol_1.LogLevel.DEBUG);
    console.trace = log.bind(undefined, logger_protocol_1.LogLevel.TRACE);
    console.log = log.bind(undefined, logger_protocol_1.LogLevel.INFO);
}
/** Shared no-op {@link Log} returned for a disabled level so that callers neither block nor emit. */
const nullLogger = () => { };
exports.LoggerFactory = Symbol('LoggerFactory');
exports.LoggerName = Symbol('LoggerName');
exports.ILogger = Symbol('ILogger');
let Logger = class Logger {
    constructor() {
        this.cache = new Map();
    }
    init() {
        if (this.name !== logger_protocol_1.rootLoggerName) {
            /* Creating a child logger.  */
            this.created = this.server.child(this.name);
        }
        else {
            /* Creating the root logger (it already exists at startup).  */
            this.created = Promise.resolve();
        }
        /* Fetch the log level so it's cached in the frontend.  */
        this._logLevel = this.created.then(_ => this.server.getLogLevel(this.name));
        /* Update the log level if it changes in the backend. */
        this.loggerWatcher.onLogLevelChanged(event => {
            this.created.then(() => {
                if (event.loggerName === this.name) {
                    this._logLevel = Promise.resolve(event.newLogLevel);
                }
            });
        });
        /* Refetch log level if overall config in backend changed. */
        this.loggerWatcher.onLogConfigChanged(() => {
            this._logLevel = this.created.then(_ => this.server.getLogLevel(this.name));
        });
    }
    setLogLevel(logLevel) {
        return new Promise(resolve => {
            this.created.then(() => {
                this._logLevel.then(oldLevel => {
                    this.server.setLogLevel(this.name, logLevel).then(() => {
                        this._logLevel = Promise.resolve(logLevel);
                        resolve();
                    });
                });
            });
        });
    }
    getLogLevel() {
        return this._logLevel;
    }
    isEnabled(logLevel) {
        return this._logLevel.then(level => logLevel >= level);
    }
    ifEnabled(logLevel) {
        return new Promise(resolve => this.isEnabled(logLevel).then(enabled => {
            if (enabled) {
                resolve();
            }
        }));
    }
    log(logLevel, arg2, ...params) {
        return this.getLog(logLevel).then(log => {
            if (log === nullLogger) {
                return;
            }
            if (typeof arg2 === 'function') {
                const loggable = arg2;
                loggable(log);
            }
            else if (arg2) {
                log(arg2, ...params);
            }
        });
    }
    getLog(logLevel) {
        return this.isEnabled(logLevel).then(enabled => {
            if (!enabled) {
                return nullLogger;
            }
            return this.created.then(() => (message, ...params) => this.server.log(this.name, logLevel, this.format(message), params.map(p => this.format(p))));
        });
    }
    format(value) {
        switch (typeof value) {
            case 'object':
                if (value instanceof Error) {
                    return this.sanitize(value.stack || value.toString());
                }
                else if (!value) {
                    return value;
                }
                else if (Array.isArray(value)) {
                    return value.map(item => this.format(item));
                }
                else {
                    try {
                        const stringified = JSON.stringify(value);
                        const sanitized = this.sanitize(stringified);
                        try {
                            return JSON.parse(sanitized);
                        }
                        catch {
                            return sanitized;
                        }
                    }
                    catch {
                        return value;
                    }
                }
            case 'string':
                return this.sanitize(value);
            default:
                return value;
        }
    }
    sanitize(message) {
        return this.sanitizer?.sanitize(message) ?? message;
    }
    isTrace() {
        return this.isEnabled(logger_protocol_1.LogLevel.TRACE);
    }
    ifTrace() {
        return this.ifEnabled(logger_protocol_1.LogLevel.TRACE);
    }
    trace(arg, ...params) {
        return this.log(logger_protocol_1.LogLevel.TRACE, arg, ...params);
    }
    isDebug() {
        return this.isEnabled(logger_protocol_1.LogLevel.DEBUG);
    }
    ifDebug() {
        return this.ifEnabled(logger_protocol_1.LogLevel.DEBUG);
    }
    debug(arg, ...params) {
        return this.log(logger_protocol_1.LogLevel.DEBUG, arg, ...params);
    }
    isInfo() {
        return this.isEnabled(logger_protocol_1.LogLevel.INFO);
    }
    ifInfo() {
        return this.ifEnabled(logger_protocol_1.LogLevel.INFO);
    }
    info(arg, ...params) {
        return this.log(logger_protocol_1.LogLevel.INFO, arg, ...params);
    }
    isWarn() {
        return this.isEnabled(logger_protocol_1.LogLevel.WARN);
    }
    ifWarn() {
        return this.ifEnabled(logger_protocol_1.LogLevel.WARN);
    }
    warn(arg, ...params) {
        return this.log(logger_protocol_1.LogLevel.WARN, arg, ...params);
    }
    isError() {
        return this.isEnabled(logger_protocol_1.LogLevel.ERROR);
    }
    ifError() {
        return this.ifEnabled(logger_protocol_1.LogLevel.ERROR);
    }
    error(arg, ...params) {
        return this.log(logger_protocol_1.LogLevel.ERROR, arg, ...params);
    }
    isFatal() {
        return this.isEnabled(logger_protocol_1.LogLevel.FATAL);
    }
    ifFatal() {
        return this.ifEnabled(logger_protocol_1.LogLevel.FATAL);
    }
    fatal(arg, ...params) {
        return this.log(logger_protocol_1.LogLevel.FATAL, arg, ...params);
    }
    child(name) {
        const existing = this.cache.get(name);
        if (existing) {
            return existing;
        }
        else {
            const child = this.factory(name);
            this.cache.set(name, child);
            return child;
        }
    }
};
exports.Logger = Logger;
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_protocol_1.ILoggerServer),
    tslib_1.__metadata("design:type", Object)
], Logger.prototype, "server", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_watcher_1.LoggerWatcher),
    tslib_1.__metadata("design:type", logger_watcher_1.LoggerWatcher)
], Logger.prototype, "loggerWatcher", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.LoggerFactory),
    tslib_1.__metadata("design:type", Function)
], Logger.prototype, "factory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.LoggerName),
    tslib_1.__metadata("design:type", String)
], Logger.prototype, "name", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_sanitizer_1.LoggerSanitizer),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], Logger.prototype, "sanitizer", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], Logger.prototype, "init", null);
exports.Logger = Logger = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], Logger);
//# sourceMappingURL=logger.js.map