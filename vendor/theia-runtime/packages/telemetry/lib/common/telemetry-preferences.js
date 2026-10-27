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
exports.TelemetryPreferences = exports.TelemetryPreferenceContribution = exports.TelemetryPreferenceSchema = exports.TELEMETRY_FILTERS = exports.TELEMETRY_LEVEL = void 0;
exports.createTelemetryPreferences = createTelemetryPreferences;
exports.bindTelemetryPreferences = bindTelemetryPreferences;
const nls_1 = require("@theia/core/lib/common/nls");
const preference_scope_1 = require("@theia/core/lib/common/preferences/preference-scope");
const preference_proxy_1 = require("@theia/core/lib/common/preferences/preference-proxy");
const preference_schema_1 = require("@theia/core/lib/common/preferences/preference-schema");
const preference_service_1 = require("@theia/core/lib/common/preferences/preference-service");
/** @experimental */
exports.TELEMETRY_LEVEL = 'telemetry.telemetryLevel';
/** @experimental */
exports.TELEMETRY_FILTERS = 'telemetry.filters';
/** @experimental */
exports.TelemetryPreferenceSchema = {
    scope: preference_scope_1.PreferenceScope.User,
    properties: {
        [exports.TELEMETRY_LEVEL]: {
            type: 'string',
            enum: ['off', 'crash', 'error', 'all'],
            enumDescriptions: [
                nls_1.nls.localizeByDefault('Disables all product telemetry.'),
                nls_1.nls.localizeByDefault('Sends OS level crash reports.'),
                nls_1.nls.localizeByDefault('Sends general error telemetry and crash reports.'),
                nls_1.nls.localizeByDefault('Sends usage data, errors, and crash reports.')
            ],
            default: 'off',
            description: nls_1.nls.localizeByDefault('Controls the level of telemetry.')
        },
        [exports.TELEMETRY_FILTERS]: {
            type: 'object',
            additionalProperties: {
                type: 'array',
                items: {
                    type: 'string'
                }
            },
            default: {},
            description: nls_1.nls.localize('theia/telemetry/filters', 'Restrict the topic patterns delivered to each telemetry sink. Missing entries allow all sink interests; empty arrays disable a sink.')
        }
    }
};
/** @experimental */
exports.TelemetryPreferenceContribution = Symbol('TelemetryPreferenceContribution');
/** @experimental */
exports.TelemetryPreferences = Symbol('TelemetryPreferences');
/** @experimental */
function createTelemetryPreferences(preferences, schema = exports.TelemetryPreferenceSchema) {
    return (0, preference_proxy_1.createPreferenceProxy)(preferences, schema);
}
/** @experimental */
function bindTelemetryPreferences(bind) {
    bind(exports.TelemetryPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get(preference_service_1.PreferenceService);
        const contribution = ctx.container.get(exports.TelemetryPreferenceContribution);
        return createTelemetryPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(exports.TelemetryPreferenceContribution).toConstantValue({ schema: exports.TelemetryPreferenceSchema });
    bind(preference_schema_1.PreferenceContribution).toService(exports.TelemetryPreferenceContribution);
}
//# sourceMappingURL=telemetry-preferences.js.map