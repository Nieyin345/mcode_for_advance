"use strict";
// *****************************************************************************
// Copyright (C) 2023 STMicroelectronics and others.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryLogger = exports.TelemetryExtImpl = void 0;
exports.cleanData = cleanData;
const tslib_1 = require("tslib");
const event_1 = require("@theia/core/lib/common/event");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_types_1 = require("@theia/telemetry/lib/common/telemetry-types");
const types_1 = require("../common/types");
const types_impl_1 = require("./types-impl");
/**
 * Holds the telemetry level the user consented to and hands it to the loggers plugins create.
 *
 * @experimental
 */
let TelemetryExtImpl = class TelemetryExtImpl {
    constructor() {
        this.currentLevel = 'off';
        this.onDidChangeTelemetryEnabledEmitter = new event_1.Emitter();
        this.onDidChangeTelemetryEnabled = this.onDidChangeTelemetryEnabledEmitter.event;
        this.onDidChangeTelemetryLevelEmitter = new event_1.Emitter();
        this.onDidChangeTelemetryLevel = this.onDidChangeTelemetryLevelEmitter.event;
    }
    get level() {
        return this.currentLevel;
    }
    $onDidChangeTelemetryLevel(level) {
        this.setLevel(level);
    }
    setLevel(level) {
        if (this.currentLevel === level) {
            return;
        }
        const wasTelemetryEnabled = this.isTelemetryEnabled;
        this.currentLevel = level;
        this.onDidChangeTelemetryLevelEmitter.fire(level);
        if (this.isTelemetryEnabled !== wasTelemetryEnabled) {
            this.onDidChangeTelemetryEnabledEmitter.fire(this.isTelemetryEnabled);
        }
    }
    get isTelemetryEnabled() {
        return (0, telemetry_types_1.isKindAllowedByLevel)(this.currentLevel, 'usage');
    }
    createTelemetryLogger(sender, options) {
        return new TelemetryLogger(sender, this.currentLevel, this.onDidChangeTelemetryLevel, options);
    }
};
exports.TelemetryExtImpl = TelemetryExtImpl;
exports.TelemetryExtImpl = TelemetryExtImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TelemetryExtImpl);
class TelemetryLogger {
    constructor(sender, level, onDidChangeTelemetryLevel, options) {
        this.onDidChangeEnableStatesEmitter = new event_1.Emitter();
        this.onDidChangeEnableStates = this.onDidChangeEnableStatesEmitter.event;
        this.sender = sender;
        this.options = options;
        this.commonProperties = this.getCommonProperties();
        this._level = level;
        this._isErrorsEnabled = (0, telemetry_types_1.isKindAllowedByLevel)(level, 'error');
        this._isUsageEnabled = (0, telemetry_types_1.isKindAllowedByLevel)(level, 'usage');
        this.levelSubscription = onDidChangeTelemetryLevel(next => this.applyLevel(next));
    }
    /**
     * The telemetry level the user consented to. Must stay read-only: the object handed to a plugin is proxied with a
     * `get` trap only, so a setter here would let the plugin raise its own gate.
     */
    get level() {
        return this._level;
    }
    applyLevel(level) {
        if (this._level !== level) {
            this._level = level;
            this.updateEnableStates((0, telemetry_types_1.isKindAllowedByLevel)(level, 'usage'), (0, telemetry_types_1.isKindAllowedByLevel)(level, 'error'));
        }
    }
    get isUsageEnabled() {
        return this._isUsageEnabled;
    }
    set isUsageEnabled(isUsageEnabled) {
        if (this._isUsageEnabled !== isUsageEnabled) {
            this._isUsageEnabled = isUsageEnabled;
            this.onDidChangeEnableStatesEmitter.fire(this);
        }
    }
    get isErrorsEnabled() {
        return this._isErrorsEnabled;
    }
    set isErrorsEnabled(isErrorsEnabled) {
        if (this._isErrorsEnabled !== isErrorsEnabled) {
            this._isErrorsEnabled = isErrorsEnabled;
            this.onDidChangeEnableStatesEmitter.fire(this);
        }
    }
    updateEnableStates(isUsageEnabled, isErrorsEnabled) {
        if (this._isUsageEnabled !== isUsageEnabled || this._isErrorsEnabled !== isErrorsEnabled) {
            this._isUsageEnabled = isUsageEnabled;
            this._isErrorsEnabled = isErrorsEnabled;
            this.onDidChangeEnableStatesEmitter.fire(this);
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logUsage(eventName, data) {
        if (!(0, telemetry_types_1.isKindAllowedByLevel)(this._level, 'usage') || !this.isUsageEnabled) {
            return;
        }
        this.logEvent(eventName, data);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logError(eventNameOrException, data) {
        if (!(0, telemetry_types_1.isKindAllowedByLevel)(this._level, 'error') || !this.isErrorsEnabled || !this.sender) {
            // no sender available or error shall not be sent
            return;
        }
        if (typeof eventNameOrException === 'string') {
            this.logEvent(eventNameOrException, data);
        }
        else {
            this.sender.sendErrorData(eventNameOrException, data);
        }
    }
    dispose() {
        this.levelSubscription.dispose();
        this.onDidChangeEnableStatesEmitter.dispose();
        const sender = this.sender;
        this.sender = undefined;
        const reportFlushFailure = (error) => console.error('Failed to flush the telemetry sender.', error);
        try {
            Promise.resolve(sender?.flush?.()).catch(reportFlushFailure);
        }
        catch (error) {
            reportFlushFailure(error);
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logEvent(eventName, data) {
        // No sender means likely disposed of, we should no-op
        if (!this.sender) {
            return;
        }
        data = mixInCommonPropsAndCleanData(data || {}, this.options?.additionalCommonProperties, this.options?.ignoreBuiltInCommonProperties ? undefined : this.commonProperties);
        this.sender?.sendEventData(eventName, data);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getCommonProperties() {
        return [];
    }
}
exports.TelemetryLogger = TelemetryLogger;
// copied and modified from https://github.com/microsoft/vscode/blob/1.76.0/src/vs/workbench/api/common/extHostTelemetry.ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mixInCommonPropsAndCleanData(data, additionalProperties, commonProperties) {
    let updatedData = data.properties ?? data;
    // We don't clean measurements since they are just numbers
    updatedData = cleanData(updatedData, []);
    if (additionalProperties) {
        updatedData = (0, types_1.mixin)(updatedData, additionalProperties);
    }
    if (commonProperties) {
        updatedData = (0, types_1.mixin)(updatedData, commonProperties);
    }
    if (data.properties) {
        data.properties = updatedData;
    }
    else {
        data = updatedData;
    }
    return data;
}
// copied and modified from https://github.com/microsoft/vscode/blob/1.76.0/src/vs/platform/telemetry/common/telemetryUtils.ts#L321-L442
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Cleans a given stack of possible paths
 * @param stack The stack to sanitize
 * @param cleanupPatterns Cleanup patterns to remove from the stack
 * @returns The cleaned stack
 */
function anonymizeFilePaths(stack, cleanupPatterns) {
    // Fast check to see if it is a file path to avoid doing unnecessary heavy regex work
    if (!stack || (!stack.includes('/') && !stack.includes('\\'))) {
        return stack;
    }
    let updatedStack = stack;
    const cleanUpIndexes = [];
    for (const regexp of cleanupPatterns) {
        while (true) {
            const result = regexp.exec(stack);
            if (!result) {
                break;
            }
            cleanUpIndexes.push([result.index, regexp.lastIndex]);
        }
    }
    const nodeModulesRegex = /^[\\\/]?(node_modules|node_modules\.asar)[\\\/]/;
    const fileRegex = /(file:\/\/)?([a-zA-Z]:(\\\\|\\|\/)|(\\\\|\\|\/))?([\w-\._]+(\\\\|\\|\/))+[\w-\._]*/g;
    let lastIndex = 0;
    updatedStack = '';
    while (true) {
        const result = fileRegex.exec(stack);
        if (!result) {
            break;
        }
        // Check to see if the any cleanupIndexes partially overlap with this match
        const overlappingRange = cleanUpIndexes.some(([start, end]) => result.index < end && start < fileRegex.lastIndex);
        // anonymize user file paths that do not need to be retained or cleaned up.
        if (!nodeModulesRegex.test(result[0]) && !overlappingRange) {
            updatedStack += stack.substring(lastIndex, result.index) + '<REDACTED: user-file-path>';
            lastIndex = fileRegex.lastIndex;
        }
    }
    if (lastIndex < stack.length) {
        updatedStack += stack.substring(lastIndex);
    }
    return updatedStack;
}
/**
 * Attempts to remove commonly leaked PII
 * @param property The property which will be removed if it contains user data
 * @returns The new value for the property
 */
function removePropertiesWithPossibleUserInfo(property) {
    // If for some reason it is undefined we skip it (this shouldn't be possible);
    if (!property) {
        return property;
    }
    const value = property.toLowerCase();
    const userDataRegexes = [
        { label: 'Google API Key', regex: /AIza[0-9A-Za-z-_]{35}/ },
        { label: 'Slack Token', regex: /xox[pbar]\-[A-Za-z0-9]/ },
        { label: 'Generic Secret', regex: /(key|token|sig|secret|signature|password|passwd|pwd|android:value)[^a-zA-Z0-9]/ },
        { label: 'Email', regex: /@[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+/ } // Regex which matches @*.site
    ];
    // Check for common user data in the telemetry events
    for (const secretRegex of userDataRegexes) {
        if (secretRegex.regex.test(value)) {
            return `<REDACTED: ${secretRegex.label}>`;
        }
    }
    return property;
}
/**
 * Does a best possible effort to clean a data object from any possible PII.
 * @param data The data object to clean
 * @param paths Any additional patterns that should be removed from the data set
 * @returns A new object with the PII removed
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cleanData(data, cleanUpPatterns) {
    return (0, core_1.cloneAndChange)(data, value => {
        // If it's a trusted value it means it's okay to skip cleaning so we don't clean it
        if (value instanceof types_impl_1.TelemetryTrustedValue) {
            return value.value;
        }
        // We only know how to clean strings
        if (typeof value === 'string') {
            let updatedProperty = value.replace(/%20/g, ' ');
            // First we anonymize any possible file paths
            updatedProperty = anonymizeFilePaths(updatedProperty, cleanUpPatterns);
            // Then we do a simple regex replace with the defined patterns
            for (const regexp of cleanUpPatterns) {
                updatedProperty = updatedProperty.replace(regexp, '');
            }
            // Lastly, remove commonly leaked PII
            updatedProperty = removePropertiesWithPossibleUserInfo(updatedProperty);
            return updatedProperty;
        }
        return undefined;
    });
}
//# sourceMappingURL=telemetry-ext.js.map