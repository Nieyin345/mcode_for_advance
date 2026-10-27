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
exports.getNLSMessages = exports.getNLSLanguage = void 0;
exports.localize = localize;
exports.localize2 = localize2;
/**
 * Drop-in replacement for `@theia/monaco-editor-core/esm/vs/nls` that plugs
 * Theia's localization system into every Monaco `localize` / `localize2` call.
 *
 * The bundler resolves the original module to this file via the `monacoNlsPlugin` of
 * `@theia/bundle-plugin`, which the generated esbuild configuration registers for the
 * browser build (see `bundler-generator.ts`). We import from `nls.messages` directly so
 * the redirect does not create a circular reference.
 */
// Re-export the message store — imported via a path that is NOT aliased.
var nls_messages_1 = require("@theia/monaco-editor-core/esm/vs/nls.messages");
Object.defineProperty(exports, "getNLSLanguage", { enumerable: true, get: function () { return nls_messages_1.getNLSLanguage; } });
Object.defineProperty(exports, "getNLSMessages", { enumerable: true, get: function () { return nls_messages_1.getNLSMessages; } });
const nls_1 = require("@theia/core/lib/common/nls");
const localization_1 = require("@theia/core/lib/common/i18n/localization");
function theiaLocalize(label, ...args) {
    const original = localization_1.Localization.format(label, args);
    if (nls_1.nls.locale) {
        const defaultKey = nls_1.nls.getDefaultKey(label);
        if (defaultKey) {
            return {
                original,
                value: nls_1.nls.localize(defaultKey, label, ...args)
            };
        }
    }
    return {
        original,
        value: original
    };
}
function localize(_key, label, ...args) {
    return theiaLocalize(label, ...args).value;
}
function localize2(_key, label, ...args) {
    return theiaLocalize(label, ...args);
}
//# sourceMappingURL=monaco-nls.js.map