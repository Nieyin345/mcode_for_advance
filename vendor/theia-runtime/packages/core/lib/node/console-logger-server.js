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
exports.ConsoleLoggerServer = void 0;
const tslib_1 = require("tslib");
// This is the console logger itself, so it cannot log through an ILogger.
/* eslint-disable @theia/named-logger-check */
const inversify_1 = require("inversify");
const logger_watcher_1 = require("../common/logger-watcher");
const logger_cli_contribution_1 = require("./logger-cli-contribution");
const logger_protocol_1 = require("../common/logger-protocol");
const util_1 = require("util");
const os_1 = require("os");
const fs = require("fs");
let ConsoleLoggerServer = class ConsoleLoggerServer {
    init() {
        this.setLogLevel(logger_protocol_1.rootLoggerName, this.cli.defaultLogLevel);
        for (const name of Object.keys(this.cli.logLevels)) {
            this.setLogLevel(name, this.cli.logLevels[name]);
        }
        this.cli.onLogConfigChanged(() => {
            this.client?.onLogConfigChanged();
        });
    }
    async setLogLevel(name, newLogLevel) {
        const event = {
            loggerName: name,
            newLogLevel
        };
        if (this.client !== undefined) {
            this.client.onLogLevelChanged(event);
        }
    }
    async getLogLevel(name) {
        return this.cli.logLevelFor(name);
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    async log(name, logLevel, message, params) {
        const configuredLogLevel = await this.getLogLevel(name);
        if (logLevel >= configuredLogLevel) {
            const fullMessage = logger_protocol_1.ConsoleLogger.log(name, logLevel, message, params);
            this.logToFile(fullMessage, params);
        }
    }
    logToFile(message, params) {
        if (this.cli.logFile && !this.logFileStream) {
            this.logFileStream = fs.createWriteStream(this.cli.logFile, { flags: 'a' });
            // Only log errors once to avoid spamming the console
            this.logFileStream.once('error', error => {
                console.error(`Error writing to log file ${this.cli.logFile}`, error);
            });
        }
        if (this.logFileStream) {
            const formatted = (0, util_1.format)(message, ...params) + os_1.EOL;
            this.logFileStream.write(formatted);
        }
    }
    async child(name) {
        this.setLogLevel(name, this.cli.logLevelFor(name));
    }
    dispose() { }
    setClient(client) {
        this.client = client;
    }
};
exports.ConsoleLoggerServer = ConsoleLoggerServer;
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_watcher_1.LoggerWatcher),
    tslib_1.__metadata("design:type", logger_watcher_1.LoggerWatcher)
], ConsoleLoggerServer.prototype, "watcher", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_cli_contribution_1.LogLevelCliContribution),
    tslib_1.__metadata("design:type", logger_cli_contribution_1.LogLevelCliContribution)
], ConsoleLoggerServer.prototype, "cli", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ConsoleLoggerServer.prototype, "init", null);
exports.ConsoleLoggerServer = ConsoleLoggerServer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ConsoleLoggerServer);
//# sourceMappingURL=console-logger-server.js.map