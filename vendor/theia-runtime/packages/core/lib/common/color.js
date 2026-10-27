"use strict";
// *****************************************************************************
// Copyright (C) 2019 TypeFox and others.
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
exports.ColorDefaults = exports.HSLA = exports.RGBA = exports.ColorTransformation = exports.Color = void 0;
const types_1 = require("./types");
var Color;
(function (Color) {
    function rgba(r, g, b, a = 1) {
        return { r, g, b, a };
    }
    Color.rgba = rgba;
    function hsla(h, s, l, a = 1) {
        return { h, s, l, a };
    }
    Color.hsla = hsla;
    Color.white = rgba(255, 255, 255, 1);
    Color.black = rgba(0, 0, 0, 1);
    function transparent(v, f) {
        return { v, f, kind: 'transparent' };
    }
    Color.transparent = transparent;
    function lighten(v, f) {
        return { v, f, kind: 'lighten' };
    }
    Color.lighten = lighten;
    function darken(v, f) {
        return { v, f, kind: 'darken' };
    }
    Color.darken = darken;
    function is(value) {
        return typeof value === 'string' || (ColorTransformation.is(value) || RGBA.is(value) || HSLA.is(value));
    }
    Color.is = is;
})(Color || (exports.Color = Color = {}));
var ColorTransformation;
(function (ColorTransformation) {
    function is(value) {
        return (0, types_1.isObject)(value)
            && (value.kind === 'transparent' || value.kind === 'lighten' || value.kind === 'darken')
            && typeof value.v === 'string'
            && typeof value.f === 'number';
    }
    ColorTransformation.is = is;
})(ColorTransformation || (exports.ColorTransformation = ColorTransformation = {}));
var RGBA;
(function (RGBA) {
    function is(value) {
        return (0, types_1.isObject)(value) && typeof value.r === 'number' && typeof value.g === 'number' && typeof value.b === 'number' && typeof value.a === 'number';
    }
    RGBA.is = is;
})(RGBA || (exports.RGBA = RGBA = {}));
var HSLA;
(function (HSLA) {
    function is(value) {
        return (0, types_1.isObject)(value) && typeof value.h === 'number' && typeof value.s === 'number' && typeof value.l === 'number' && typeof value.a === 'number';
    }
    HSLA.is = is;
})(HSLA || (exports.HSLA = HSLA = {}));
var ColorDefaults;
(function (ColorDefaults) {
    function getLight(defaults) {
        if (Color.is(defaults)) {
            return defaults;
        }
        return defaults?.light;
    }
    ColorDefaults.getLight = getLight;
    function getDark(defaults) {
        if (Color.is(defaults)) {
            return defaults;
        }
        return defaults?.dark;
    }
    ColorDefaults.getDark = getDark;
    function getHCDark(defaults) {
        if (Color.is(defaults)) {
            return defaults;
        }
        return defaults?.hcDark ?? defaults?.hc;
    }
    ColorDefaults.getHCDark = getHCDark;
    function getHCLight(defaults) {
        if (Color.is(defaults)) {
            return defaults;
        }
        return defaults?.hcLight;
    }
    ColorDefaults.getHCLight = getHCLight;
})(ColorDefaults || (exports.ColorDefaults = ColorDefaults = {}));
//# sourceMappingURL=color.js.map