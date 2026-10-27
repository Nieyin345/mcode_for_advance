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
exports.PreferenceScope = exports.ValidPreferenceScopes = void 0;
/**
 * An array of preference scopes that are valid in a given context, sorted from more general to more specific
 */
exports.ValidPreferenceScopes = Symbol('ValidPreferenceScopes');
var PreferenceScope;
(function (PreferenceScope) {
    PreferenceScope[PreferenceScope["Default"] = 0] = "Default";
    PreferenceScope[PreferenceScope["User"] = 1] = "User";
    PreferenceScope[PreferenceScope["Workspace"] = 2] = "Workspace";
    PreferenceScope[PreferenceScope["Folder"] = 3] = "Folder";
    /**
     * Process-lifetime, in-memory scope used by `--session-preference` CLI overrides.
     * Has the highest precedence and is never persisted to disk.
     */
    PreferenceScope[PreferenceScope["Session"] = 4] = "Session";
})(PreferenceScope || (exports.PreferenceScope = PreferenceScope = {}));
(function (PreferenceScope) {
    function is(scope) {
        return typeof scope === 'number' && getScopes().includes(scope);
    }
    PreferenceScope.is = is;
    /**
     * @returns preference scopes from broadest to narrowest: Default -> Folder.
     */
    function getScopes() {
        return Object.values(PreferenceScope).filter(nameOrIndex => !isNaN(Number(nameOrIndex)));
    }
    PreferenceScope.getScopes = getScopes;
    /**
     * @returns preference scopes from narrowest to broadest. Folder -> Default.
     */
    function getReversedScopes() {
        return getScopes().reverse();
    }
    PreferenceScope.getReversedScopes = getReversedScopes;
    function getScopeNames(scope) {
        const names = [];
        const scopes = getScopes();
        if (scope) {
            for (const scopeIndex of scopes) {
                if (scopeIndex <= scope) {
                    names.push(PreferenceScope[scopeIndex]);
                }
            }
        }
        return names;
    }
    PreferenceScope.getScopeNames = getScopeNames;
})(PreferenceScope || (exports.PreferenceScope = PreferenceScope = {}));
//# sourceMappingURL=preference-scope.js.map