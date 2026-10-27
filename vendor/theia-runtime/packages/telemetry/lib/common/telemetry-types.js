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
exports.BACKEND_TELEMETRY_SESSION = void 0;
exports.isTelemetryEventKind = isTelemetryEventKind;
exports.isKindAllowedByLevel = isKindAllowedByLevel;
/** @experimental */
function isTelemetryEventKind(value) {
    return value === 'usage' || value === 'error' || value === 'crash';
}
/** @experimental */
function isKindAllowedByLevel(level, kind) {
    return level === 'all'
        || level === 'error' && (kind === 'error' || kind === 'crash')
        || level === 'crash' && kind === 'crash';
}
/** @experimental */
exports.BACKEND_TELEMETRY_SESSION = 'backend';
//# sourceMappingURL=telemetry-types.js.map