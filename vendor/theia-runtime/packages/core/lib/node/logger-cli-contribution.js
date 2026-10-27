"use strict";
// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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
exports.LogLevelCliContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const logger_1 = require("../common/logger");
const fs = require("fs-extra");
const watcher_1 = require("@parcel/watcher");
const event_1 = require("../common/event");
const path = require("path");
const common_1 = require("../common");
const strings_1 = require("../common/strings");
/**
 * Parses command line switches related to log levels, then watches the log
 * levels file (if specified) for changes.  This is the source of truth for
 * what the log level per logger should be.
 */
let LogLevelCliContribution = class LogLevelCliContribution {
    get defaultLogLevel() {
        return this._defaultLogLevel;
    }
    get logLevels() {
        return this._logLevels;
    }
    get logFile() {
        return this._logFile;
    }
    constructor() {
        this._logLevels = {};
        this.wildcardRegexCache = new Map();
        this.asyncSubscriptions = [];
        this.toDispose = new common_1.DisposableCollection();
        /**
         * Log level to use for loggers not specified in `logLevels`.
         */
        this._defaultLogLevel = logger_1.LogLevel.INFO;
        this.logConfigChangedEvent = new event_1.Emitter();
        this.toDispose.push(this.logConfigChangedEvent);
    }
    configure(conf) {
        conf.option('log-level', {
            description: 'Sets the default log level',
            choices: Array.from(logger_1.LogLevel.strings.values()),
            nargs: 1,
        });
        conf.option('log-config', {
            description: 'Path to the JSON file specifying the configuration of various loggers',
            type: 'string',
            nargs: 1,
        });
        conf.option('log-file', {
            description: 'Path to the log file',
            type: 'string',
            nargs: 1
        });
    }
    async setArguments(args) {
        if (args['log-level'] !== undefined && args['log-config'] !== undefined) {
            throw new Error('--log-level and --log-config are mutually exclusive.');
        }
        if (args['log-level'] !== undefined) {
            this._defaultLogLevel = this.readLogLevelString(args['log-level'], 'Unknown log level passed to --log-level');
        }
        if (args['log-config'] !== undefined) {
            let filename = args['log-config'];
            try {
                filename = path.resolve(filename);
                await this.slurpLogConfigFile(filename);
                await this.watchLogConfigFile(filename);
            }
            catch (e) {
                console.error(`Error reading log config file ${filename}: ${e}`);
            }
        }
        if (args['log-file'] !== undefined) {
            let filename = args['log-file'];
            try {
                filename = path.resolve(filename);
                try {
                    const stat = await fs.stat(filename);
                    if (stat && stat.isFile()) {
                        // Rename the previous log file to avoid overwriting it
                        const oldFilename = `${filename}.${stat.ctime.toISOString().replace(/:/g, '-')}.old`;
                        await fs.rename(filename, oldFilename);
                    }
                }
                catch {
                    // File does not exist, just continue to create it
                }
                await fs.writeFile(filename, '');
                this._logFile = filename;
            }
            catch (e) {
                console.error(`Error creating log file ${filename}: ${e}`);
            }
        }
        // some initial loggers have already been constructed. Fire the event to notify them.
        if (args['log-level'] || args['log-config'] || args['log-file']) {
            this.logConfigChangedEvent.fire();
        }
    }
    async watchLogConfigFile(filename) {
        const dir = path.dirname(filename);
        const subscription = await (0, watcher_1.subscribe)(dir, async (err, events) => {
            if (err) {
                console.log(`Error during log file watching ${filename}: ${err}`);
                return;
            }
            try {
                for (const event of events) {
                    if (event.path === filename) {
                        switch (event.type) {
                            case 'create':
                            case 'update':
                                await this.slurpLogConfigFile(filename);
                                this.logConfigChangedEvent.fire(undefined);
                                break;
                        }
                    }
                }
            }
            catch (e) {
                console.error(`Error reading log config file ${filename}: ${e}`);
            }
        });
        this.asyncSubscriptions.push(subscription);
    }
    async dispose() {
        for (const sub of this.asyncSubscriptions) {
            sub.unsubscribe();
        }
        this.toDispose.dispose();
    }
    async slurpLogConfigFile(filename) {
        try {
            const content = await fs.readFile(filename, 'utf-8');
            const data = JSON.parse(content);
            let newDefaultLogLevel = logger_1.LogLevel.INFO;
            if ('defaultLevel' in data) {
                newDefaultLogLevel = this.readLogLevelString(data['defaultLevel'], `Unknown default log level in ${filename}`);
            }
            const newLogLevels = {};
            if ('levels' in data) {
                const loggers = data['levels'];
                for (const logger of Object.keys(loggers)) {
                    const levelStr = loggers[logger];
                    newLogLevels[logger] = this.readLogLevelString(levelStr, `Unknown log level for logger ${logger} in ${filename}`);
                }
            }
            this._defaultLogLevel = newDefaultLogLevel;
            this._logLevels = newLogLevels;
            this.wildcardRegexCache.clear();
            console.log(`Successfully read new log config from ${filename}.`);
        }
        catch (e) {
            throw new Error(`Error reading log config file ${filename}: ${e.message}`);
        }
    }
    get onLogConfigChanged() {
        return this.logConfigChangedEvent.event;
    }
    logLevelFor(loggerName) {
        if (loggerName in this._logLevels) {
            return this._logLevels[loggerName];
        }
        const keys = Object.keys(this._logLevels);
        for (let i = keys.length - 1; i >= 0; i--) {
            const pattern = keys[i];
            if (pattern.includes('*')) {
                const regex = this.getWildcardRegex(pattern);
                if (regex.test(loggerName)) {
                    return this._logLevels[pattern];
                }
            }
        }
        return this.defaultLogLevel;
    }
    /**
     * Converts the string to a `LogLevel`. Throws an error if invalid.
     */
    readLogLevelString(levelStr, errMessagePrefix) {
        const level = logger_1.LogLevel.fromString(levelStr);
        if (level === undefined) {
            throw new Error(`${errMessagePrefix}: "${levelStr}".`);
        }
        return level;
    }
    /**
     * Converts a wildcard string into a strict regular expression and caches it.
     * Example: "ai-core*" -> /^ai-core.*$/
     */
    getWildcardRegex(pattern) {
        let regex = this.wildcardRegexCache.get(pattern);
        if (!regex) {
            const escapedPattern = pattern.split('*').map(strings_1.escapeRegExpCharacters).join('.*');
            regex = new RegExp(`^${escapedPattern}$`);
            this.wildcardRegexCache.set(pattern, regex);
        }
        return regex;
    }
};
exports.LogLevelCliContribution = LogLevelCliContribution;
exports.LogLevelCliContribution = LogLevelCliContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], LogLevelCliContribution);
//# sourceMappingURL=logger-cli-contribution.js.map