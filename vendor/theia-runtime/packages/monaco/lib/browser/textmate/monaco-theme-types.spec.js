"use strict";
// *****************************************************************************
// Copyright (C) 2026 Ehab Younes and others.
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
const chai_1 = require("chai");
const monaco_theme_types_1 = require("./monaco-theme-types");
describe('MonacoThemeColor', () => {
    // Themes may use shorthand hex, e.g. Alabaster sets 'editor.foreground': '#000', which
    // monaco rejects with 'Illegal value for token color', keeping the previous editor theme.
    it('should expand shorthand hex colors', () => {
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.expandShorthandHex('#000')).to.equal('#000000');
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.expandShorthandHex('#a1B2')).to.equal('#aa11BB22');
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.expandShorthandHex('#123456')).to.equal('#123456');
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.expandShorthandHex('#12345678')).to.equal('#12345678');
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.expandShorthandHex('red')).to.equal('red');
    });
    it('should accept only colors monaco allows as token colors', () => {
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.isTokenColor('#123456')).to.equal(true);
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.isTokenColor('#12345678')).to.equal(true);
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.isTokenColor(monaco_theme_types_1.MonacoThemeColor.expandShorthandHex('#000'))).to.equal(true);
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.isTokenColor('#123')).to.equal(false);
        (0, chai_1.expect)(monaco_theme_types_1.MonacoThemeColor.isTokenColor('red')).to.equal(false);
    });
});
//# sourceMappingURL=monaco-theme-types.spec.js.map