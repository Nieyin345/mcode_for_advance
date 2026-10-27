"use strict";
// *****************************************************************************
// Copyright (C) 2019 Ericsson and others.
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
exports.taskPreferencesSchema = exports.taskSchemaId = void 0;
exports.bindTaskPreferences = bindTaskPreferences;
const preference_configurations_1 = require("@theia/core/lib/common/preferences/preference-configurations");
const preference_schema_1 = require("@theia/core/lib/common/preferences/preference-schema");
const preference_scope_1 = require("@theia/core/lib/common/preferences/preference-scope");
exports.taskSchemaId = 'vscode://schemas/tasks';
exports.taskPreferencesSchema = {
    scope: preference_scope_1.PreferenceScope.Folder,
    properties: {
        tasks: {
            $ref: exports.taskSchemaId,
            description: 'Task definition file',
            default: {
                version: '2.0.0',
                tasks: []
            }
        }
    }
};
function bindTaskPreferences(bind) {
    bind(preference_schema_1.PreferenceContribution).toConstantValue({ schema: exports.taskPreferencesSchema });
    bind(preference_configurations_1.PreferenceConfiguration).toConstantValue({ name: 'tasks' });
}
//# sourceMappingURL=task-preferences.js.map