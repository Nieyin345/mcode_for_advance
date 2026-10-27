"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
const telemetry_types_1 = require("./telemetry-types");
describe('telemetry types', () => {
    it('validates telemetry event kinds', () => {
        (0, chai_1.expect)(['usage', 'error', 'crash'].every(telemetry_types_1.isTelemetryEventKind)).to.be.true;
        (0, chai_1.expect)((0, telemetry_types_1.isTelemetryEventKind)('invalid')).to.be.false;
    });
    it('maps telemetry levels to event kinds', () => {
        const kinds = ['usage', 'error', 'crash'];
        const levels = ['off', 'crash', 'error', 'all'];
        (0, chai_1.expect)(levels.map(level => kinds.filter(kind => (0, telemetry_types_1.isKindAllowedByLevel)(level, kind)))).to.deep.equal([
            [],
            ['crash'],
            ['error', 'crash'],
            ['usage', 'error', 'crash']
        ]);
    });
});
//# sourceMappingURL=telemetry-types.spec.js.map