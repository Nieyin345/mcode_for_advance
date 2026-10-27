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
const chai_1 = require("chai");
const preference_scope_1 = require("@theia/core/lib/common/preferences/preference-scope");
const telemetry_preferences_1 = require("./telemetry-preferences");
describe('telemetry preferences', () => {
    it('defines only the level and filters preference keys', () => {
        (0, chai_1.expect)(Object.keys(telemetry_preferences_1.TelemetryPreferenceSchema.properties)).to.deep.equal([telemetry_preferences_1.TELEMETRY_LEVEL, telemetry_preferences_1.TELEMETRY_FILTERS]);
    });
    it('limits telemetry preferences to user scope', () => {
        (0, chai_1.expect)(telemetry_preferences_1.TelemetryPreferenceSchema.scope).to.equal(preference_scope_1.PreferenceScope.User);
    });
    it('uses safe defaults and describes each telemetry level', () => {
        (0, chai_1.expect)(telemetry_preferences_1.TelemetryPreferenceSchema.properties[telemetry_preferences_1.TELEMETRY_LEVEL]).to.deep.include({
            type: 'string',
            enum: ['off', 'crash', 'error', 'all'],
            enumDescriptions: [
                'Disables all product telemetry.',
                'Sends OS level crash reports.',
                'Sends general error telemetry and crash reports.',
                'Sends usage data, errors, and crash reports.'
            ],
            default: 'off'
        });
        (0, chai_1.expect)(telemetry_preferences_1.TelemetryPreferenceSchema.properties[telemetry_preferences_1.TELEMETRY_FILTERS].default).to.deep.equal({});
    });
    it('defines filters as sink IDs mapped to arrays of topic patterns', () => {
        (0, chai_1.expect)(telemetry_preferences_1.TelemetryPreferenceSchema.properties[telemetry_preferences_1.TELEMETRY_FILTERS]).to.include({ type: 'object' });
        (0, chai_1.expect)(telemetry_preferences_1.TelemetryPreferenceSchema.properties[telemetry_preferences_1.TELEMETRY_FILTERS].additionalProperties).to.deep.equal({
            type: 'array',
            items: { type: 'string' }
        });
    });
});
//# sourceMappingURL=telemetry-preferences.spec.js.map