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
exports.TelemetryService = void 0;
exports.isTelemetryData = isTelemetryData;
exports.snapshotTelemetryData = snapshotTelemetryData;
const objects_1 = require("@theia/core/lib/common/objects");
const types_1 = require("@theia/core/lib/common/types");
function isTelemetryPrimitive(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
function isTelemetryArray(value) {
    if (!Array.isArray(value)) {
        return false;
    }
    if (value.length === 0) {
        return true;
    }
    if (!Object.prototype.hasOwnProperty.call(value, 0) || !isTelemetryPrimitive(value[0])) {
        return false;
    }
    const elementType = typeof value[0];
    for (let index = 1; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index) || !isTelemetryPrimitive(value[index]) || typeof value[index] !== elementType) {
            return false;
        }
    }
    return true;
}
function isTelemetryValue(value) {
    return isTelemetryPrimitive(value) || isTelemetryArray(value);
}
/** @experimental */
function isTelemetryData(data) {
    if (!(0, types_1.isObject)(data) || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) {
        return false;
    }
    return Object.values(data).every(isTelemetryValue);
}
/** @experimental */
function snapshotTelemetryData(data) {
    return data === undefined ? undefined : (0, objects_1.deepFreeze)((0, objects_1.deepClone)(data));
}
/** @experimental */
exports.TelemetryService = Symbol('TelemetryService');
//# sourceMappingURL=telemetry-service.js.map