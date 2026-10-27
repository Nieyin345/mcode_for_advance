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
exports.PreferenceTelemetryConsentProvider = exports.TelemetryConsentProvider = void 0;
const tslib_1 = require("tslib");
const common_1 = require("@theia/core/lib/common");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_preferences_1 = require("./telemetry-preferences");
/** @experimental */
exports.TelemetryConsentProvider = Symbol('TelemetryConsentProvider');
/** @experimental */
let PreferenceTelemetryConsentProvider = class PreferenceTelemetryConsentProvider {
    constructor() {
        this.currentLevel = 'off';
        this.onDidChangeTelemetryLevelEmitter = new common_1.Emitter();
        this.onDidChangeTelemetryLevel = this.onDidChangeTelemetryLevelEmitter.event;
        this.readyDeferred = new promise_util_1.Deferred();
        this.ready = this.readyDeferred.promise;
    }
    init() {
        this.preferences.onPreferenceChanged(change => {
            if (change.preferenceName === telemetry_preferences_1.TELEMETRY_LEVEL) {
                this.setLevel(this.preferences[telemetry_preferences_1.TELEMETRY_LEVEL]);
            }
        });
        this.preferences.ready.then(() => {
            this.setLevel(this.preferences[telemetry_preferences_1.TELEMETRY_LEVEL]);
            this.readyDeferred.resolve();
        }, () => this.readyDeferred.resolve());
    }
    setLevel(level) {
        if (level !== this.currentLevel) {
            this.currentLevel = level;
            this.onDidChangeTelemetryLevelEmitter.fire(level);
        }
    }
    get level() {
        return this.currentLevel;
    }
};
exports.PreferenceTelemetryConsentProvider = PreferenceTelemetryConsentProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(telemetry_preferences_1.TelemetryPreferences),
    tslib_1.__metadata("design:type", Object)
], PreferenceTelemetryConsentProvider.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PreferenceTelemetryConsentProvider.prototype, "init", null);
exports.PreferenceTelemetryConsentProvider = PreferenceTelemetryConsentProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceTelemetryConsentProvider);
//# sourceMappingURL=telemetry-consent-provider.js.map