"use strict";
// *****************************************************************************
// Copyright (C) 2026 Maksim Kachurin and others.
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
exports.isObject = isObject;
exports.isStringArray = isStringArray;
exports.flatten = flatten;
exports.isColorDefaults = isColorDefaults;
exports.isENOENT = isENOENT;
exports.deepClone = deepClone;
function isObject(value) {
    // eslint-disable-next-line no-null/no-null
    return typeof value === 'object' && value !== null;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function flatten(arrays) {
    const result = [];
    for (const arr of arrays) {
        result.push(...arr);
    }
    return result;
}
function isColorDefaults(value) {
    return isObject(value)
        && typeof value.light === 'string'
        && typeof value.dark === 'string'
        && typeof value.highContrast === 'string';
}
const ENOENT = 'ENOENT';
function isErrnoException(arg) {
    return arg instanceof Error
        && isObject(arg)
        && typeof arg.code === 'string'
        && typeof arg.errno === 'number';
}
function isENOENT(arg) {
    return isErrnoException(arg) && arg.code === ENOENT;
}
function deepClone(obj) {
    if (!isObject(obj)) {
        return obj;
    }
    if (obj instanceof RegExp) {
        return obj;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = Array.isArray(obj) ? [] : {};
    Object.keys(obj).forEach((key) => {
        const prop = obj[key];
        if (isObject(prop)) {
            result[key] = deepClone(prop);
        }
        else {
            result[key] = prop;
        }
    });
    return result;
}
//# sourceMappingURL=utils.js.map