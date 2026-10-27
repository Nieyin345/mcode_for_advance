"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
exports.DefaultsPreferenceProvider = void 0;
const tslib_1 = require("tslib");
const preference_scope_1 = require("./preference-scope");
const inversify_1 = require("inversify");
const preference_schema_1 = require("./preference-schema");
const promise_util_1 = require("../promise-util");
const preference_language_override_service_1 = require("./preference-language-override-service");
const preference_provider_impl_1 = require("./preference-provider-impl");
// *****************************************************************************
let DefaultsPreferenceProvider = class DefaultsPreferenceProvider extends preference_provider_impl_1.PreferenceProviderBase {
    constructor() {
        super(...arguments);
        this._ready = new promise_util_1.Deferred();
        this.ready = this._ready.promise;
    }
    init() {
        this.toDispose.push(this.preferenceSchemaService.onDidChangeDefaultValue(e => {
            const changes = {};
            if (e.overrideIdentifier) {
                changes[e.key] = this.changeFor(e.key, e.overrideIdentifier, e.oldValue, e.newValue);
            }
            else {
                changes[e.key] = this.changeFor(e.key, undefined, e.oldValue, e.newValue);
                for (const override of e.otherAffectedOverrides) {
                    const change = this.changeFor(e.key, override, e.oldValue, e.newValue);
                    changes[change.preferenceName] = change;
                }
            }
            this.emitPreferencesChangedEvent(changes);
        }));
        this._ready.resolve();
    }
    changeFor(key, overrideIdentifier, oldValue, newValue) {
        const preferenceName = overrideIdentifier ? this.preferenceOverrideService.overridePreferenceName({ preferenceName: key, overrideIdentifier }) : key;
        return {
            preferenceName: preferenceName,
            newValue: newValue,
            oldValue: oldValue,
            scope: preference_scope_1.PreferenceScope.Default
        };
    }
    canHandleScope(scope) {
        return scope === preference_scope_1.PreferenceScope.Default;
    }
    get(preferenceName, resourceUri) {
        const overrideInfo = this.preferenceOverrideService.overriddenPreferenceName(preferenceName);
        return this.preferenceSchemaService.getDefaultValue(overrideInfo?.preferenceName ?? preferenceName, overrideInfo?.overrideIdentifier);
    }
    setPreference(key, value, resourceUri) {
        return Promise.resolve(false);
    }
    resolve(preferenceName, resourceUri) {
        const overrideInfo = this.preferenceOverrideService.overriddenPreferenceName(preferenceName);
        return {
            value: this.preferenceSchemaService.inspectDefaultValue(overrideInfo?.preferenceName ?? preferenceName, overrideInfo?.overrideIdentifier),
            configUri: undefined
        };
    }
    getPreferences() {
        return this.preferenceSchemaService.getDefaultValues();
    }
};
exports.DefaultsPreferenceProvider = DefaultsPreferenceProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_schema_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], DefaultsPreferenceProvider.prototype, "preferenceSchemaService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_language_override_service_1.PreferenceLanguageOverrideService),
    tslib_1.__metadata("design:type", preference_language_override_service_1.PreferenceLanguageOverrideService)
], DefaultsPreferenceProvider.prototype, "preferenceOverrideService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DefaultsPreferenceProvider.prototype, "init", null);
exports.DefaultsPreferenceProvider = DefaultsPreferenceProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultsPreferenceProvider);
//# sourceMappingURL=defaults-preference-provider.js.map