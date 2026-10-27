"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.SessionPreferenceProvider = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const preference_provider_impl_1 = require("./preference-provider-impl");
const preference_scope_1 = require("./preference-scope");
/**
 * In-memory preference provider used for process-lifetime overrides such as those
 * supplied via the `--session-preference` CLI option. Values live in memory only
 * and are dropped when the process exits.
 */
let SessionPreferenceProvider = class SessionPreferenceProvider extends preference_provider_impl_1.PreferenceProviderImpl {
    constructor() {
        super(...arguments);
        this.preferences = new Map();
    }
    init() {
        this._ready.resolve();
    }
    canHandleScope(scope) {
        return scope === preference_scope_1.PreferenceScope.Session;
    }
    getPreferences() {
        const result = {};
        for (const [name, value] of this.preferences) {
            result[name] = value;
        }
        return result;
    }
    async setPreference(key, value) {
        const oldValue = this.preferences.get(key);
        if (value === undefined) {
            if (!this.preferences.has(key)) {
                return false;
            }
            this.preferences.delete(key);
        }
        else {
            this.preferences.set(key, value);
        }
        const change = {
            preferenceName: key,
            newValue: value,
            oldValue,
            scope: preference_scope_1.PreferenceScope.Session
        };
        await this.emitPreferencesChangedEvent([change]);
        return true;
    }
};
exports.SessionPreferenceProvider = SessionPreferenceProvider;
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], SessionPreferenceProvider.prototype, "init", null);
exports.SessionPreferenceProvider = SessionPreferenceProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], SessionPreferenceProvider);
//# sourceMappingURL=session-preference-provider.js.map