"use strict";
// *****************************************************************************
// Copyright (C) 2024 STMicroelectronics and others.
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
exports.bindTestPreferences = exports.TestPreferences = exports.TestPreferenceContribution = exports.TestConfigSchema = void 0;
exports.createTestPreferences = createTestPreferences;
const preference_proxy_1 = require("@theia/core/lib/common/preferences/preference-proxy");
const preference_scope_1 = require("@theia/core/lib/common/preferences/preference-scope");
const nls_1 = require("@theia/core/lib/common/nls");
const preference_schema_1 = require("@theia/core/lib/common/preferences/preference-schema");
const core_1 = require("@theia/core");
exports.TestConfigSchema = {
    properties: {
        'testing.openTesting': {
            type: 'string',
            enum: ['neverOpen', 'openOnTestStart'],
            enumDescriptions: [
                nls_1.nls.localizeByDefault('Never automatically open the testing views'),
                nls_1.nls.localizeByDefault('Open the test results view when tests start'),
            ],
            description: nls_1.nls.localizeByDefault('Controls when the testing view should open.'),
            default: 'neverOpen',
            scope: preference_scope_1.PreferenceScope.Folder,
        }
    }
};
exports.TestPreferenceContribution = Symbol('TestPreferenceContribution');
exports.TestPreferences = Symbol('TestPreferences');
function createTestPreferences(preferences, schema = exports.TestConfigSchema) {
    return (0, preference_proxy_1.createPreferenceProxy)(preferences, schema);
}
const bindTestPreferences = (bind) => {
    bind(exports.TestPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get(core_1.PreferenceService);
        const contribution = ctx.container.get(exports.TestPreferenceContribution);
        return createTestPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(exports.TestPreferenceContribution).toConstantValue({ schema: exports.TestConfigSchema });
    bind(preference_schema_1.PreferenceContribution).toService(exports.TestPreferenceContribution);
};
exports.bindTestPreferences = bindTestPreferences;
//# sourceMappingURL=test-preferences.js.map