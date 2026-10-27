"use strict";
// *****************************************************************************
// Copyright (C) 2021 TypeFox and others.
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
exports.coerceLocalizations = coerceLocalizations;
exports.localizeWithResolver = localizeWithResolver;
exports.localizePackage = localizePackage;
const utils_1 = require("./utils");
function isLocalizeInfo(obj) {
    return (0, utils_1.isObject)(obj) && 'message' in obj && typeof obj.message === 'string';
}
function coerceLocalizations(translations) {
    const result = {};
    for (const [key, value] of Object.entries(translations)) {
        if (typeof value === 'string') {
            result[key] = value;
        }
        else if (isLocalizeInfo(value)) {
            result[key] = value.message;
        }
        else {
            // Only strings or LocalizeInfo values are valid
            result[key] = 'INVALID TRANSLATION VALUE';
        }
    }
    return result;
}
/**
 * Recursively walks `value` and replaces strings matching `%key%` with the result of `resolve(key)`.
 * If `resolve(key)` returns `undefined` or an empty string, the original `%key%` is kept
 * (same as the former worker `localize`: `translations[key] || value`).
 */
function localizeWithResolver(value, resolve) {
    if (typeof value === 'string') {
        if (value.length > 2 && value.startsWith('%') && value.endsWith('%')) {
            const replaced = resolve(value.slice(1, -1));
            return (replaced || value);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(item => localizeWithResolver(item, resolve));
    }
    if ((0, utils_1.isObject)(value)) {
        const result = {};
        for (const [name, item] of Object.entries(value)) {
            result[name] = localizeWithResolver(item, resolve);
        }
        return result;
    }
    return value;
}
/**
 * Recursively replaces %key% strings in value with translations.
 * callback is used when only default (package.nls.json) exists; e.g. backend passes
 * Theia's Localization.localize for fallback, build-time can use (_, d) => d.
 */
function localizePackage(value, translations, callback) {
    return localizeWithResolver(value, key => {
        if (translations.translation && key in translations.translation) {
            return translations.translation[key];
        }
        if (translations.default && key in translations.default) {
            return callback(key, translations.default[key]);
        }
        return undefined;
    });
}
//# sourceMappingURL=package-nls.js.map