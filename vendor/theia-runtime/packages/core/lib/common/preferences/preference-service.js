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
exports.PreferenceServiceImpl = exports.PreferenceProviderProvider = exports.PreferenceService = exports.PreferenceChangeImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const disposable_1 = require("../disposable");
const event_1 = require("../event");
const promise_util_1 = require("../promise-util");
const uri_1 = require("../uri");
const preference_language_override_service_1 = require("./preference-language-override-service");
const preference_provider_1 = require("./preference-provider");
const preference_schema_1 = require("./preference-schema");
const preference_scope_1 = require("./preference-scope");
const preference_configurations_1 = require("./preference-configurations");
const objects_1 = require("../objects");
const types_1 = require("../types");
const logger_1 = require("../logger");
class PreferenceChangeImpl {
    constructor(change) {
        this.change = (0, objects_1.deepFreeze)(change);
    }
    get preferenceName() {
        return this.change.preferenceName;
    }
    get scope() {
        return this.change.scope;
    }
    get domain() {
        return this.change.domain;
    }
    // TODO add tests
    affects(resourceUri) {
        const resourcePath = resourceUri && new uri_1.default(resourceUri).path;
        const domain = this.change.domain;
        return !resourcePath || !domain || domain.some(uri => new uri_1.default(uri).path.relativity(resourcePath) >= 0);
    }
}
exports.PreferenceChangeImpl = PreferenceChangeImpl;
exports.PreferenceService = Symbol('PreferenceService');
/**
 * We cannot load providers directly in the case if they depend on `PreferenceService` somehow.
 * It allows to load them lazily after DI is configured.
 */
exports.PreferenceProviderProvider = Symbol('PreferenceProviderProvider');
let PreferenceServiceImpl = class PreferenceServiceImpl {
    constructor() {
        this.onPreferenceChangedEmitter = new event_1.Emitter();
        this.onPreferenceChanged = this.onPreferenceChangedEmitter.event;
        this.onPreferencesChangedEmitter = new event_1.Emitter();
        this.onPreferencesChanged = this.onPreferencesChangedEmitter.event;
        this.toDispose = new disposable_1.DisposableCollection(this.onPreferenceChangedEmitter, this.onPreferencesChangedEmitter);
        this.preferenceProviders = new Map();
        this._ready = new promise_util_1.Deferred();
        this._isReady = false;
    }
    async initializeProviders() {
        try {
            for (const scope of this.schemaService.validScopes) {
                const provider = this.providerProvider(scope);
                if (provider) {
                    this.preferenceProviders.set(scope, provider);
                    this.toDispose.push(provider.onDidPreferencesChanged(changes => this.reconcilePreferences(changes)));
                    await provider.ready;
                }
                else {
                    this.logger.warn(`No preference provider bound for ${preference_scope_1.PreferenceScope[scope]}`);
                }
            }
            this._ready.resolve();
            this._isReady = true;
        }
        catch (e) {
            this._ready.reject(e);
        }
    }
    init() {
        this.toDispose.push(disposable_1.Disposable.create(() => this._ready.reject(new Error('preference service is disposed'))));
        this.initializeProviders();
    }
    dispose() {
        this.toDispose.dispose();
    }
    get ready() {
        return this._ready.promise;
    }
    get isReady() {
        return this._isReady;
    }
    reconcilePreferences(changes) {
        const changesToEmit = {};
        const acceptChange = (change) => {
            this.getAffectedPreferenceNames(change, preferenceName => changesToEmit[preferenceName] = new PreferenceChangeImpl({ ...change, preferenceName }));
        };
        for (const preferenceName of Object.keys(changes)) {
            let change = changes[preferenceName];
            const overridden = this.overriddenPreferenceName(change.preferenceName);
            if (change.newValue === undefined) {
                if (overridden) {
                    change = {
                        ...change, newValue: this.doGet(overridden.preferenceName)
                    };
                }
            }
            for (const scope of [...this.schemaService.validScopes].reverse()) {
                const provider = this.getProvider(scope);
                if (provider) {
                    const scopeValue = provider.get(preferenceName);
                    if (scope > change.scope && scopeValue !== undefined) {
                        const preference = this.schemaService.getSchemaProperty(change.preferenceName);
                        if (!preference?.type || preference.type === 'object' || preference.type === 'array'
                            || Array.isArray(preference.type) && preference.type.some(candidate => candidate === 'object' || candidate === 'array')) {
                            // Merge object/array preferences
                            acceptChange(change);
                        }
                        break;
                    }
                    // Handle changes in the same scope
                    if (scope === change.scope) {
                        const hasNewValue = change.newValue !== undefined || scope === preference_scope_1.PreferenceScope.Default;
                        const isResetToUndefined = change.newValue === undefined && scopeValue === undefined; // is reset to undefined (no default value)
                        if (hasNewValue || isResetToUndefined) {
                            acceptChange(change);
                            break;
                        }
                    }
                    // Handle fallback to more general scope when preference is reset
                    if (scope < change.scope && change.newValue === undefined && scopeValue !== undefined) {
                        // preference is changed to `undefined`, use the value from a more general scope
                        change = {
                            ...change,
                            newValue: scopeValue,
                            scope
                        };
                        acceptChange(change);
                        break;
                    }
                }
            }
        }
        // emit the changes
        const changedPreferenceNames = Object.keys(changesToEmit);
        if (changedPreferenceNames.length > 0) {
            this.onPreferencesChangedEmitter.fire(changesToEmit);
        }
        changedPreferenceNames.forEach(preferenceName => this.onPreferenceChangedEmitter.fire(changesToEmit[preferenceName]));
    }
    getAffectedPreferenceNames(change, accept) {
        const overridden = this.preferenceOverrideService.overriddenPreferenceName(change.preferenceName);
        accept(change.preferenceName);
        if (!overridden?.overrideIdentifier) { // changes to overrides never affect other overrides
            const preference = this.schemaService.getSchemaProperty(change.preferenceName);
            if (preference && preference.overridable) {
                for (const overrideId of this.schemaService.overrideIdentifiers) {
                    const overridePreferenceName = this.preferenceOverrideService.overridePreferenceName({
                        overrideIdentifier: overrideId,
                        preferenceName: change.preferenceName
                    });
                    if (!this.doHas(overridePreferenceName)) {
                        accept(overridePreferenceName);
                    }
                }
            }
        }
    }
    getProvider(scope) {
        return this.preferenceProviders.get(scope);
    }
    has(preferenceName, resourceUri) {
        return this.get(preferenceName, undefined, resourceUri) !== undefined;
    }
    get(preferenceName, defaultValue, resourceUri) {
        return this.resolve(preferenceName, defaultValue, resourceUri).value;
    }
    resolve(preferenceName, defaultValue, resourceUri) {
        const { value, configUri } = this.doResolve(preferenceName, defaultValue, resourceUri);
        if (value === undefined) {
            const overridden = this.overriddenPreferenceName(preferenceName);
            if (overridden) {
                return this.doResolve(overridden.preferenceName, defaultValue, resourceUri);
            }
        }
        return { value, configUri };
    }
    async set(preferenceName, value, scope, resourceUri) {
        const resolvedScope = scope ?? (!resourceUri ? preference_scope_1.PreferenceScope.Workspace : preference_scope_1.PreferenceScope.Folder);
        if (resolvedScope === preference_scope_1.PreferenceScope.Folder && !resourceUri) {
            throw new Error('Unable to write to Folder Settings because no resource is provided.');
        }
        const provider = this.getProvider(resolvedScope);
        if (provider && await provider.setPreference(preferenceName, value, resourceUri)) {
            await this.evictSessionOverride(preferenceName, resolvedScope);
            return;
        }
        throw new Error(`Unable to write to ${preference_scope_1.PreferenceScope[resolvedScope]} Settings.`);
    }
    /**
     * When a preference is written to a persistent scope, drop any in-memory session
     * override (set via `--session-preference`) for the same key so that the explicit
     * change takes effect for the remainder of the session. Without this, the session
     * scope would keep shadowing the user's change because it has higher precedence.
     *
     * Note: this fires for any write to a persistent scope, including programmatic
     * writes from extensions. Extensions that race with startup CLI overrides will
     * therefore clear them. This is intentional: a programmatic write is "explicit"
     * from the preference system's point of view, but consumers should be aware.
     *
     * Session preferences are global (no per-resource scoping), so `resourceUri` is
     * not threaded through.
     */
    async evictSessionOverride(preferenceName, writtenScope) {
        if (writtenScope === preference_scope_1.PreferenceScope.Session || writtenScope === preference_scope_1.PreferenceScope.Default) {
            return;
        }
        const sessionProvider = this.getProvider(preference_scope_1.PreferenceScope.Session);
        if (sessionProvider && sessionProvider.get(preferenceName) !== undefined) {
            // Passing `undefined` clears the value in the session provider.
            await sessionProvider.setPreference(preferenceName, undefined);
        }
    }
    getBoolean(preferenceName, defaultValue, resourceUri) {
        const value = resourceUri ? this.get(preferenceName, defaultValue, resourceUri) : this.get(preferenceName, defaultValue);
        // eslint-disable-next-line no-null/no-null
        return value !== null && value !== undefined ? !!value : defaultValue;
    }
    getString(preferenceName, defaultValue, resourceUri) {
        const value = resourceUri ? this.get(preferenceName, defaultValue, resourceUri) : this.get(preferenceName, defaultValue);
        // eslint-disable-next-line no-null/no-null
        if (value === null || value === undefined) {
            return defaultValue;
        }
        return value.toString();
    }
    getNumber(preferenceName, defaultValue, resourceUri) {
        const value = resourceUri ? this.get(preferenceName, defaultValue, resourceUri) : this.get(preferenceName, defaultValue);
        // eslint-disable-next-line no-null/no-null
        if (value === null || value === undefined) {
            return defaultValue;
        }
        if (typeof value === 'number') {
            return value;
        }
        return Number(value);
    }
    inspect(preferenceName, resourceUri, forceLanguageOverride) {
        const defaultValue = this.inspectInScope(preferenceName, preference_scope_1.PreferenceScope.Default, resourceUri, forceLanguageOverride);
        const globalValue = this.inspectInScope(preferenceName, preference_scope_1.PreferenceScope.User, resourceUri, forceLanguageOverride);
        const workspaceValue = this.inspectInScope(preferenceName, preference_scope_1.PreferenceScope.Workspace, resourceUri, forceLanguageOverride);
        const workspaceFolderValue = this.inspectInScope(preferenceName, preference_scope_1.PreferenceScope.Folder, resourceUri, forceLanguageOverride);
        const sessionValue = this.inspectInScope(preferenceName, preference_scope_1.PreferenceScope.Session, resourceUri, forceLanguageOverride);
        const valueApplied = sessionValue ?? workspaceFolderValue ?? workspaceValue ?? globalValue ?? defaultValue;
        return { preferenceName, defaultValue, globalValue, workspaceValue, workspaceFolderValue, sessionValue, value: valueApplied };
    }
    inspectInScope(preferenceName, scope, resourceUri, forceLanguageOverride) {
        const value = this.doInspectInScope(preferenceName, scope, resourceUri);
        if (value === undefined && !forceLanguageOverride) {
            const overridden = this.overriddenPreferenceName(preferenceName);
            if (overridden) {
                return this.doInspectInScope(overridden.preferenceName, scope, resourceUri);
            }
        }
        return value;
    }
    getScopedValueFromInspection(inspection, scope) {
        switch (scope) {
            case preference_scope_1.PreferenceScope.Default:
                return inspection.defaultValue;
            case preference_scope_1.PreferenceScope.User:
                return inspection.globalValue;
            case preference_scope_1.PreferenceScope.Workspace:
                return inspection.workspaceValue;
            case preference_scope_1.PreferenceScope.Folder:
                return inspection.workspaceFolderValue;
            case preference_scope_1.PreferenceScope.Session:
                return inspection.sessionValue;
        }
        (0, types_1.unreachable)(scope, 'Not all PreferenceScope enum variants handled.');
    }
    async updateValue(preferenceName, value, resourceUri) {
        const inspection = this.inspect(preferenceName, resourceUri);
        if (inspection) {
            const scopesToChange = this.getScopesToChange(inspection, value);
            const isDeletion = value === undefined
                || (scopesToChange.length === 1
                    && scopesToChange[0] === preference_scope_1.PreferenceScope.User
                    && preference_provider_1.PreferenceUtils.deepEqual(value, inspection.defaultValue));
            const effectiveValue = isDeletion ? undefined : value;
            await Promise.all(scopesToChange.map(scope => this.set(preferenceName, effectiveValue, scope, resourceUri)));
        }
    }
    getScopesToChange(inspection, intendedValue) {
        if (preference_provider_1.PreferenceUtils.deepEqual(inspection.value, intendedValue)) {
            return [];
        }
        // Scopes in ascending order of scope breadth.
        const allScopes = [...this.schemaService.validScopes].reverse()
            // Default is read-only, and Session is populated only by `--session-preference`,
            // so neither is a valid target for a regular user edit.
            .filter(scope => scope !== preference_scope_1.PreferenceScope.Default && scope !== preference_scope_1.PreferenceScope.Session);
        const isScopeDefined = (scope) => this.getScopedValueFromInspection(inspection, scope) !== undefined;
        if (intendedValue === undefined) {
            return allScopes.filter(isScopeDefined);
        }
        return [allScopes.find(isScopeDefined) ?? preference_scope_1.PreferenceScope.User];
    }
    overridePreferenceName(options) {
        return this.preferenceOverrideService.overridePreferenceName(options);
    }
    overriddenPreferenceName(preferenceName) {
        return this.preferenceOverrideService.overriddenPreferenceName(preferenceName);
    }
    doHas(preferenceName, resourceUri) {
        return this.doGet(preferenceName, undefined, resourceUri) !== undefined;
    }
    doInspectInScope(preferenceName, scope, resourceUri) {
        const provider = this.getProvider(scope);
        return provider && provider.get(preferenceName, resourceUri);
    }
    doGet(preferenceName, defaultValue, resourceUri) {
        return this.doResolve(preferenceName, defaultValue, resourceUri).value;
    }
    doResolve(preferenceName, defaultValue, resourceUri) {
        const result = {};
        for (const scope of this.schemaService.validScopes) {
            const provider = this.getProvider(scope);
            if (provider?.canHandleScope(scope)) {
                const { configUri, value } = provider.resolve(preferenceName, resourceUri);
                if (value !== undefined) {
                    result.configUri = configUri;
                    result.value = preference_provider_1.PreferenceUtils.merge(result.value, value);
                }
            }
        }
        return {
            configUri: result.configUri,
            value: result.value !== undefined ? (0, objects_1.deepFreeze)(result.value) : defaultValue
        };
    }
    getConfigUri(scope, resourceUri, sectionName = this.configurations.getConfigName()) {
        const provider = this.getProvider(scope);
        if (!provider || !this.configurations.isAnyConfig(sectionName)) {
            return undefined;
        }
        const configUri = provider.getConfigUri && provider.getConfigUri(resourceUri, sectionName);
        if (configUri) {
            return configUri;
        }
        return provider.getContainingConfigUri && provider.getContainingConfigUri(resourceUri, sectionName);
    }
};
exports.PreferenceServiceImpl = PreferenceServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_schema_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], PreferenceServiceImpl.prototype, "schemaService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.PreferenceProviderProvider),
    tslib_1.__metadata("design:type", Function)
], PreferenceServiceImpl.prototype, "providerProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_configurations_1.PreferenceConfigurations),
    tslib_1.__metadata("design:type", preference_configurations_1.PreferenceConfigurations)
], PreferenceServiceImpl.prototype, "configurations", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_language_override_service_1.PreferenceLanguageOverrideService),
    tslib_1.__metadata("design:type", preference_language_override_service_1.PreferenceLanguageOverrideService)
], PreferenceServiceImpl.prototype, "preferenceOverrideService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('core:PreferenceServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], PreferenceServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PreferenceServiceImpl.prototype, "init", null);
exports.PreferenceServiceImpl = PreferenceServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceServiceImpl);
//# sourceMappingURL=preference-service.js.map