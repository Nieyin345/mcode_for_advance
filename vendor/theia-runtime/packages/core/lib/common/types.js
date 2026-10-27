"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.MapUtils = exports.Prioritizeable = exports.ArrayUtils = void 0;
exports.isBoolean = isBoolean;
exports.isString = isString;
exports.isNumber = isNumber;
exports.isError = isError;
exports.isErrorLike = isErrorLike;
exports.isFunction = isFunction;
exports.isEmptyObject = isEmptyObject;
exports.isObject = isObject;
exports.isUndefined = isUndefined;
exports.isArray = isArray;
exports.isStringArray = isStringArray;
exports.nullToUndefined = nullToUndefined;
exports.unreachable = unreachable;
exports.isDefined = isDefined;
exports.isUndefinedOrNull = isUndefinedOrNull;
var array_utils_1 = require("./array-utils");
Object.defineProperty(exports, "ArrayUtils", { enumerable: true, get: function () { return array_utils_1.ArrayUtils; } });
var prioritizeable_1 = require("./prioritizeable");
Object.defineProperty(exports, "Prioritizeable", { enumerable: true, get: function () { return prioritizeable_1.Prioritizeable; } });
function isBoolean(value) {
    return value === true || value === false;
}
function isString(value) {
    return typeof value === 'string' || value instanceof String;
}
function isNumber(value) {
    return typeof value === 'number' || value instanceof Number;
}
function isError(value) {
    return value instanceof Error;
}
function isErrorLike(value) {
    return isObject(value) && isString(value.name) && isString(value.message) && (isUndefined(value.stack) || isString(value.stack));
}
// eslint-disable-next-line space-before-function-paren
function isFunction(value) {
    return typeof value === 'function';
}
/**
 * @returns whether the provided parameter is an empty JavaScript Object or not.
 */
function isEmptyObject(obj) {
    if (!isObject(obj)) {
        return false;
    }
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            return false;
        }
    }
    return true;
}
function isObject(value) {
    // eslint-disable-next-line no-null/no-null
    return typeof value === 'object' && value !== null;
}
function isUndefined(value) {
    return typeof value === 'undefined';
}
/**
 * @param value value to check.
 * @param every optional predicate ran on every element of the array.
 * @param thisArg value to substitute `this` with when invoking in the predicate.
 * @returns whether or not `value` is an array.
 */
function isArray(value, every, thisArg) {
    return Array.isArray(value) && (!isFunction(every) || value.every(every, thisArg));
}
function isStringArray(value) {
    return isArray(value, isString);
}
/**
 * Creates a shallow copy with all ownkeys of the original object that are `null` made `undefined`
 */
function nullToUndefined(nullable) {
    const undefinable = { ...nullable };
    for (const key in nullable) {
        // eslint-disable-next-line no-null/no-null
        if (nullable[key] === null && Object.prototype.hasOwnProperty.call(nullable, key)) {
            undefinable[key] = undefined;
        }
    }
    return undefinable;
}
/**
 * Throws when called and statically makes sure that all variants of a type were consumed.
 */
function unreachable(_never, message = 'unhandled case') {
    throw new Error(message);
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation and others. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/Microsoft/vscode/blob/master/LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/
// Copied from https://github.com/microsoft/vscode/blob/1.72.2/src/vs/base/common/types.ts
/**
 * @returns whether the provided parameter is defined.
 */
function isDefined(arg) {
    return !isUndefinedOrNull(arg);
}
/**
 * @returns whether the provided parameter is undefined or null.
 */
function isUndefinedOrNull(obj) {
    // eslint-disable-next-line no-null/no-null
    return (isUndefined(obj) || obj === null);
}
var MapUtils;
(function (MapUtils) {
    function addOrInsertWith(container, key, ...values) {
        const existing = container.get(key);
        if (existing) {
            existing.push(...values);
        }
        else {
            container.set(key, values);
        }
    }
    MapUtils.addOrInsertWith = addOrInsertWith;
})(MapUtils || (exports.MapUtils = MapUtils = {}));
//# sourceMappingURL=types.js.map