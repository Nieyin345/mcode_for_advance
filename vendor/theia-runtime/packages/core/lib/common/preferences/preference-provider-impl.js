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
exports.PreferenceProviderImpl = exports.PreferenceProviderBase = void 0;
const tslib_1 = require("tslib");
const debounce = require("p-debounce");
const inversify_1 = require("inversify");
const event_1 = require("../event");
const promise_util_1 = require("../promise-util");
const disposable_1 = require("../disposable");
const preference_language_override_service_1 = require("./preference-language-override-service");
const types_1 = require("../types");
class PreferenceProviderBase {
    constructor() {
        this.onDidPreferencesChangedEmitter = new event_1.Emitter();
        this.onDidPreferencesChanged = this.onDidPreferencesChangedEmitter.event;
        this.toDispose = new disposable_1.DisposableCollection();
        this.fireDidPreferencesChanged = debounce(() => {
            const changes = this.deferredChanges;
            this.deferredChanges = undefined;
            if (changes && Object.keys(changes).length) {
                this.onDidPreferencesChangedEmitter.fire(changes);
                return true;
            }
            return false;
        }, 0);
        this.toDispose.push(this.onDidPreferencesChangedEmitter);
    }
    /**
     * Informs the listeners that one or more preferences of this provider are changed.
     * The listeners are able to find what was changed from the emitted event.
     */
    emitPreferencesChangedEvent(changes) {
        if (Array.isArray(changes)) {
            for (const change of changes) {
                this.mergePreferenceProviderDataChange(change);
            }
        }
        else {
            for (const preferenceName of Object.keys(changes)) {
                this.mergePreferenceProviderDataChange(changes[preferenceName]);
            }
        }
        return this.fireDidPreferencesChanged();
    }
    mergePreferenceProviderDataChange(change) {
        if (!this.deferredChanges) {
            this.deferredChanges = {};
        }
        const current = this.deferredChanges[change.preferenceName];
        const { newValue, scope, domain } = change;
        if (!current) {
            // new
            this.deferredChanges[change.preferenceName] = change;
        }
        else if (current.oldValue === newValue) {
            // delete
            delete this.deferredChanges[change.preferenceName];
        }
        else {
            // update
            Object.assign(current, { newValue, scope, domain });
        }
    }
    dispose() {
        this.toDispose.dispose();
    }
}
exports.PreferenceProviderBase = PreferenceProviderBase;
/**
 * The {@link PreferenceProvider} is used to store and retrieve preference values. A {@link PreferenceProvider} does not operate in a global scope but is
 * configured for one or more {@link PreferenceScope}s. The (default implementation for the) {@link PreferenceService} aggregates all {@link PreferenceProvider}s and
 * serves as a common facade for manipulating preference values.
 */
let PreferenceProviderImpl = class PreferenceProviderImpl extends PreferenceProviderBase {
    constructor() {
        super();
        this._ready = new promise_util_1.Deferred();
    }
    get(preferenceName, resourceUri) {
        return this.resolve(preferenceName, resourceUri).value;
    }
    resolve(preferenceName, resourceUri) {
        const value = this.getPreferences(resourceUri)[preferenceName];
        if (value !== undefined) {
            return {
                value: value,
                configUri: this.getConfigUri(resourceUri)
            };
        }
        return {};
    }
    /**
     * Resolved when the preference provider is ready to provide preferences
     * It should be resolved by subclasses.
     */
    get ready() {
        return this._ready.promise;
    }
    /**
     * Retrieve the domain for this provider.
     *
     * @returns the domain or `undefined` if this provider is suitable for all domains.
     */
    getDomain() {
        return undefined;
    }
    getConfigUri(resourceUri, sectionName) {
        return undefined;
    }
    getParsedContent(jsonData) {
        const preferences = {};
        if (!(0, types_1.isObject)(jsonData)) {
            return preferences;
        }
        for (const [preferenceName, preferenceValue] of Object.entries(jsonData)) {
            if (preference_language_override_service_1.PreferenceLanguageOverrideService.testOverrideValue(preferenceName, preferenceValue)) {
                for (const [overriddenPreferenceName, overriddenValue] of Object.entries(preferenceValue)) {
                    preferences[`${preferenceName}.${overriddenPreferenceName}`] = overriddenValue;
                }
            }
            else {
                preferences[preferenceName] = preferenceValue;
            }
        }
        return preferences;
    }
    canHandleScope(scope) {
        return true;
    }
};
exports.PreferenceProviderImpl = PreferenceProviderImpl;
exports.PreferenceProviderImpl = PreferenceProviderImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], PreferenceProviderImpl);
//# sourceMappingURL=preference-provider-impl.js.map