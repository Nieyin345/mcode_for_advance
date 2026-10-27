"use strict";
// *****************************************************************************
// Copyright (C) 2020 Ericsson and others.
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
exports.ScmPreferences = exports.ScmPreferenceContribution = exports.scmPreferenceSchema = void 0;
exports.createScmPreferences = createScmPreferences;
exports.bindScmPreferences = bindScmPreferences;
const preferences_1 = require("@theia/core/lib/common/preferences");
const nls_1 = require("@theia/core/lib/common/nls");
exports.scmPreferenceSchema = {
    properties: {
        'scm.defaultViewMode': {
            type: 'string',
            enum: ['tree', 'list'],
            enumDescriptions: [
                nls_1.nls.localizeByDefault('Show the repository changes as a tree.'),
                nls_1.nls.localizeByDefault('Show the repository changes as a list.')
            ],
            description: nls_1.nls.localizeByDefault('Controls the default Source Control repository view mode.'),
            default: 'list'
        },
        'scm.graph.badges': {
            type: 'string',
            enum: ['all', 'filter'],
            enumDescriptions: [
                nls_1.nls.localizeByDefault('Show badges of all history item groups in the Source Control Graph view.'),
                nls_1.nls.localizeByDefault('Show only the badges of history item groups used as a filter in the Source Control Graph view.')
            ],
            description: nls_1.nls.localizeByDefault(
            // eslint-disable-next-line max-len
            'Controls which badges are shown in the Source Control Graph view. The badges are shown on the right side of the graph indicating the names of history item groups.'),
            default: 'filter'
        },
        'scm.graph.pageOnScroll': {
            type: 'boolean',
            description: nls_1.nls.localizeByDefault('Controls whether the Source Control Graph view will load the next page of items when you scroll to the end of the list.'),
            default: true
        },
        'scm.graph.pageSize': {
            type: 'number',
            minimum: 1,
            maximum: 1000,
            description: nls_1.nls.localizeByDefault('The number of items to show in the Source Control Graph view by default and when loading more items.'),
            default: 50
        }
    }
};
exports.ScmPreferenceContribution = Symbol('ScmPreferenceContribution');
exports.ScmPreferences = Symbol('ScmPreferences');
function createScmPreferences(preferences, schema = exports.scmPreferenceSchema) {
    return (0, preferences_1.createPreferenceProxy)(preferences, schema);
}
function bindScmPreferences(bind) {
    bind(exports.ScmPreferences).toDynamicValue((ctx) => {
        const preferences = ctx.container.get(preferences_1.PreferenceService);
        const contribution = ctx.container.get(exports.ScmPreferenceContribution);
        return createScmPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(exports.ScmPreferenceContribution).toConstantValue({ schema: exports.scmPreferenceSchema });
    bind(preferences_1.PreferenceContribution).toService(exports.ScmPreferenceContribution);
}
//# sourceMappingURL=scm-preferences.js.map