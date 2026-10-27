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
exports.MonacoThemeColor = exports.TextmateRegistryFactory = exports.OnigasmProvider = void 0;
exports.OnigasmProvider = Symbol('OnigasmProvider');
exports.TextmateRegistryFactory = Symbol('TextmateRegistryFactory');
var MonacoThemeColor;
(function (MonacoThemeColor) {
    /** Expands shorthand hex (`#RGB`, `#RGBA`) to long form; other values pass through. */
    function expandShorthandHex(color) {
        return /^#[0-9a-fA-F]{3,4}$/.test(color)
            ? '#' + [...color.slice(1)].map(digit => digit + digit).join('')
            : color;
    }
    MonacoThemeColor.expandShorthandHex = expandShorthandHex;
    /** Whether monaco accepts `color` as a token color, i.e. 6/8-digit hex (see monaco's `ColorMap.getId`). */
    function isTokenColor(color) {
        return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color);
    }
    MonacoThemeColor.isTokenColor = isTokenColor;
})(MonacoThemeColor || (exports.MonacoThemeColor = MonacoThemeColor = {}));
;
//# sourceMappingURL=monaco-theme-types.js.map