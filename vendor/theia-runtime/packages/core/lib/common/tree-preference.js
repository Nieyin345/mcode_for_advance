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
exports.TreePreferences = exports.TreeConfiguration = exports.treePreferencesSchema = exports.PREFERENCE_NAME_TREE_INDENT = void 0;
exports.bindTreePreferences = bindTreePreferences;
const nls_1 = require("./nls");
const preferences_1 = require("./preferences");
exports.PREFERENCE_NAME_TREE_INDENT = 'workbench.tree.indent';
exports.treePreferencesSchema = {
    properties: {
        [exports.PREFERENCE_NAME_TREE_INDENT]: {
            description: nls_1.nls.localizeByDefault('Controls tree indentation in pixels.'),
            type: 'number',
            default: 8,
            minimum: 4,
            maximum: 40
        },
    }
};
class TreeConfiguration {
}
exports.TreeConfiguration = TreeConfiguration;
exports.TreePreferences = Symbol('treePreferences');
function bindTreePreferences(bind) {
    bind(exports.TreePreferences).toDynamicValue(ctx => {
        const factory = ctx.container.get(preferences_1.PreferenceProxyFactory);
        return factory(exports.treePreferencesSchema);
    }).inSingletonScope();
    bind(preferences_1.PreferenceContribution).toConstantValue({ schema: exports.treePreferencesSchema });
}
//# sourceMappingURL=tree-preference.js.map