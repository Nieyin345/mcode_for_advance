"use strict";
// *****************************************************************************
// Copyright (C) 2019 Ericsson and others.
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
exports.UserConfigsPreferenceProvider = exports.UserStorageLocationProvider = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const inversify_1 = require("@theia/core/shared/inversify");
const user_preference_provider_1 = require("../common/user-preference-provider");
const core_1 = require("@theia/core");
exports.UserStorageLocationProvider = Symbol('UserStorageLocationProvider');
/**
 * Binds together preference section prefs providers for user-level preferences.
 */
let UserConfigsPreferenceProvider = class UserConfigsPreferenceProvider extends core_1.PreferenceProviderImpl {
    constructor() {
        super(...arguments);
        this.providers = new Map();
    }
    init() {
        this.doInit();
    }
    async doInit() {
        const userStorageUri = await this.userStorageLocationProvider();
        this.createProviders(userStorageUri);
        const readyPromises = [];
        for (const provider of this.providers.values()) {
            readyPromises.push(provider.ready.catch(e => this.logger.error(e)));
        }
        Promise.all(readyPromises).then(() => this._ready.resolve());
    }
    createProviders(userStorageLocation) {
        for (const configName of [...this.configurations.getSectionNames(), this.configurations.getConfigName()]) {
            const sectionUri = userStorageLocation.resolve(configName + '.json');
            const sectionKey = sectionUri.toString();
            if (!this.providers.has(sectionKey)) {
                const provider = this.createProvider(sectionUri, configName);
                this.providers.set(sectionKey, provider);
            }
        }
    }
    getConfigUri(resourceUri, sectionName = this.configurations.getConfigName()) {
        for (const provider of this.providers.values()) {
            const configUri = provider.getConfigUri(resourceUri);
            if (configUri && this.configurations.getName(configUri) === sectionName) {
                return configUri;
            }
        }
        return undefined;
    }
    resolve(preferenceName, resourceUri) {
        const result = {};
        for (const provider of this.providers.values()) {
            const { value, configUri } = provider.resolve(preferenceName, resourceUri);
            if (configUri && value !== undefined) {
                result.configUri = configUri;
                result.value = core_1.PreferenceUtils.merge(result.value, value);
            }
        }
        return result;
    }
    getPreferences(resourceUri) {
        let result = {};
        for (const provider of this.providers.values()) {
            const preferences = provider.getPreferences();
            result = core_1.PreferenceUtils.merge(result, preferences);
        }
        return result;
    }
    async setPreference(preferenceName, value, resourceUri) {
        const sectionName = preferenceName.split('.', 1)[0];
        const defaultConfigName = this.configurations.getConfigName();
        const configName = this.configurations.isSectionName(sectionName) ? sectionName : defaultConfigName;
        const setWithConfigName = async (name) => {
            for (const provider of this.providers.values()) {
                if (this.configurations.getName(provider.getConfigUri()) === name) {
                    if (await provider.setPreference(preferenceName, value, resourceUri)) {
                        return true;
                    }
                }
            }
            return false;
        };
        if (await setWithConfigName(configName)) { // Try in the section we believe it belongs in.
            return true;
        }
        else if (configName !== defaultConfigName) { // Fall back to `settings.json` if that fails.
            return setWithConfigName(defaultConfigName);
        }
        return false;
    }
    createProvider(uri, sectionName) {
        const provider = this.providerFactory(uri, sectionName);
        this.toDispose.push(provider);
        this.toDispose.push(provider.onDidPreferencesChanged(change => this.onDidPreferencesChangedEmitter.fire(change)));
        return provider;
    }
};
exports.UserConfigsPreferenceProvider = UserConfigsPreferenceProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(user_preference_provider_1.UserPreferenceProviderFactory),
    tslib_1.__metadata("design:type", Function)
], UserConfigsPreferenceProvider.prototype, "providerFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.UserStorageLocationProvider),
    tslib_1.__metadata("design:type", Function)
], UserConfigsPreferenceProvider.prototype, "userStorageLocationProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceConfigurations),
    tslib_1.__metadata("design:type", core_1.PreferenceConfigurations)
], UserConfigsPreferenceProvider.prototype, "configurations", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('preferences:UserConfigsPreferenceProvider'),
    tslib_1.__metadata("design:type", Object)
], UserConfigsPreferenceProvider.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], UserConfigsPreferenceProvider.prototype, "init", null);
exports.UserConfigsPreferenceProvider = UserConfigsPreferenceProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], UserConfigsPreferenceProvider);
//# sourceMappingURL=user-configs-preference-provider.js.map