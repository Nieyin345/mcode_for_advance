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
exports.AbstractResourcePreferenceProvider = exports.PreferenceStorageFactory = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-null/no-null */
const jsoncparser = require("jsonc-parser");
const inversify_1 = require("@theia/core/shared/inversify");
const disposable_1 = require("@theia/core/lib/common/disposable");
const common_1 = require("@theia/core/lib/common");
const uri_1 = require("@theia/core/lib/common/uri");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const core_1 = require("@theia/core");
;
exports.PreferenceStorageFactory = Symbol('PreferenceStorageFactory');
let AbstractResourcePreferenceProvider = class AbstractResourcePreferenceProvider extends common_1.PreferenceProviderImpl {
    constructor() {
        super(...arguments);
        this.preferences = {};
        this._fileExists = false;
        this.loading = new promise_util_1.Deferred();
        this.onDidChangeValidityEmitter = new core_1.Emitter();
    }
    set fileExists(exists) {
        if (exists !== this._fileExists) {
            this._fileExists = exists;
            this.onDidChangeValidityEmitter.fire(exists);
        }
    }
    get onDidChangeValidity() {
        return this.onDidChangeValidityEmitter.event;
    }
    init() {
        this.doInit();
    }
    async doInit() {
        const uri = this.getUri();
        this.toDispose.push(disposable_1.Disposable.create(() => this.loading.reject(new Error(`Preference provider for '${uri}' was disposed.`))));
        this.preferenceStorage = this.preferenceStorageFactory(uri, this.getScope());
        this.toDispose.push(this.preferenceStorage);
        this.preferenceStorage.onDidChangeFileContent(async ({ content, fileOK }) => {
            this.fileExists = fileOK;
            this.readPreferencesFromContent(content);
            await this.fireDidPreferencesChanged(); // Ensure all consumers of the event have received it.¨
            return true;
        });
        await this.readPreferencesFromFile();
        this._ready.resolve();
        this.loading.resolve();
        this.toDispose.pushAll([
            disposable_1.Disposable.create(() => this.reset()),
        ]);
    }
    get valid() {
        return this._fileExists;
    }
    getConfigUri(resourceUri) {
        if (!resourceUri) {
            return this.getUri();
        }
        return this.valid && this.contains(resourceUri) ? this.getUri() : undefined;
    }
    contains(resourceUri) {
        if (!resourceUri) {
            return true;
        }
        const domain = this.getDomain();
        if (!domain) {
            return true;
        }
        const resourcePath = new uri_1.default(resourceUri).path;
        return domain.some(uri => new uri_1.default(uri).path.relativity(resourcePath) >= 0);
    }
    getPreferences(resourceUri) {
        return this.valid && this.contains(resourceUri) ? this.preferences : {};
    }
    async setPreference(key, value, resourceUri) {
        let path;
        if (this.toDispose.disposed || !(path = this.getPath(key)) || !this.contains(resourceUri)) {
            return false;
        }
        return this.doSetPreference(key, path, value);
    }
    doSetPreference(key, path, value) {
        return this.preferenceStorage.writeValue(key, path, value);
    }
    getPath(preferenceName) {
        const asOverride = this.preferenceOverrideService.overriddenPreferenceName(preferenceName);
        if (asOverride?.overrideIdentifier) {
            return [this.preferenceOverrideService.markLanguageOverride(asOverride.overrideIdentifier), asOverride.preferenceName];
        }
        return [preferenceName];
    }
    readPreferencesFromFile() {
        return this.preferenceStorage.read().then(value => {
            this.fileExists = true;
            this.readPreferencesFromContent(value);
        }).catch(() => {
            this.fileExists = false;
            this.readPreferencesFromContent('');
        });
    }
    readPreferencesFromContent(content) {
        let preferencesInJson;
        try {
            preferencesInJson = this.parse(content);
        }
        catch {
            preferencesInJson = {};
        }
        const parsedPreferences = this.getParsedContent(preferencesInJson);
        this.handlePreferenceChanges(parsedPreferences);
    }
    parse(content) {
        content = content.trim();
        if (!content) {
            return undefined;
        }
        const strippedContent = jsoncparser.stripComments(content);
        return jsoncparser.parse(strippedContent);
    }
    handlePreferenceChanges(newPrefs) {
        const oldPrefs = Object.assign({}, this.preferences);
        this.preferences = newPrefs;
        const prefNames = new Set([...Object.keys(oldPrefs), ...Object.keys(newPrefs)]);
        const prefChanges = [];
        const uri = this.getUri();
        for (const prefName of prefNames.values()) {
            const oldValue = oldPrefs[prefName];
            const newValue = newPrefs[prefName];
            const schemaProperty = this.schemaProvider.getSchemaProperty(prefName);
            if (schemaProperty && schemaProperty.included) {
                const scope = schemaProperty.scope;
                // do not emit the change event if the change is made out of the defined preference scope
                if (!this.schemaProvider.isValidInScope(prefName, this.getScope())) {
                    this.logger.warn(`Preference ${prefName} in ${uri} can only be defined in scopes: ${common_1.PreferenceScope.getScopeNames(scope).join(', ')}.`);
                    continue;
                }
            }
            if (!common_1.PreferenceUtils.deepEqual(newValue, oldValue)) {
                prefChanges.push({
                    preferenceName: prefName, newValue, oldValue, scope: this.getScope(), domain: this.getDomain()
                });
            }
        }
        if (prefChanges.length > 0) {
            this.emitPreferencesChangedEvent(prefChanges);
        }
    }
    reset() {
        const preferences = this.preferences;
        this.preferences = {};
        const changes = [];
        for (const prefName of Object.keys(preferences)) {
            const value = preferences[prefName];
            if (value !== undefined) {
                changes.push({
                    preferenceName: prefName, newValue: undefined, oldValue: value, scope: this.getScope(), domain: this.getDomain()
                });
            }
        }
        if (changes.length > 0) {
            this.emitPreferencesChangedEvent(changes);
        }
    }
};
exports.AbstractResourcePreferenceProvider = AbstractResourcePreferenceProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], AbstractResourcePreferenceProvider.prototype, "schemaProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceConfigurations),
    tslib_1.__metadata("design:type", common_1.PreferenceConfigurations)
], AbstractResourcePreferenceProvider.prototype, "configurations", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceLanguageOverrideService),
    tslib_1.__metadata("design:type", common_1.PreferenceLanguageOverrideService)
], AbstractResourcePreferenceProvider.prototype, "preferenceOverrideService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.PreferenceStorageFactory),
    tslib_1.__metadata("design:type", Function)
], AbstractResourcePreferenceProvider.prototype, "preferenceStorageFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('preferences:AbstractResourcePreferenceProvider'),
    tslib_1.__metadata("design:type", Object)
], AbstractResourcePreferenceProvider.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], AbstractResourcePreferenceProvider.prototype, "init", null);
exports.AbstractResourcePreferenceProvider = AbstractResourcePreferenceProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AbstractResourcePreferenceProvider);
//# sourceMappingURL=abstract-resource-preference-provider.js.map