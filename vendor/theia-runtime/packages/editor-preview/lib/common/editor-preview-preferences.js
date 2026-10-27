"use strict";
// *****************************************************************************
// Copyright (C) 2018 Google and others.
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
exports.EditorPreviewPreferences = exports.EditorPreviewPreferenceContribution = exports.EditorPreviewConfigSchema = exports.ENABLE_PREVIEW_PREFERENCE = void 0;
exports.createEditorPreviewPreferences = createEditorPreviewPreferences;
exports.bindEditorPreviewPreferences = bindEditorPreviewPreferences;
const common_1 = require("@theia/core/lib/common");
const nls_1 = require("@theia/core/lib/common/nls");
exports.ENABLE_PREVIEW_PREFERENCE = 'editor.enablePreview';
exports.EditorPreviewConfigSchema = {
    properties: {
        [exports.ENABLE_PREVIEW_PREFERENCE]: {
            type: 'boolean',
            // eslint-disable-next-line max-len
            description: nls_1.nls.localizeByDefault("Controls whether preview mode is used when editors open. There is a maximum of one preview mode editor per editor group. This editor displays its filename in italics on its tab or title label and in the Open Editors view. Its contents will be replaced by the next editor opened in preview mode. Making a change in a preview mode editor will persist it, as will a double-click on its label, or the 'Keep Open' option in its label context menu. Opening a file from Explorer with a double-click persists its editor immediately."),
            default: true
        },
    }
};
exports.EditorPreviewPreferenceContribution = Symbol('EditorPreviewPreferenceContribution');
exports.EditorPreviewPreferences = Symbol('EditorPreviewPreferences');
function createEditorPreviewPreferences(preferences, schema = exports.EditorPreviewConfigSchema) {
    return (0, common_1.createPreferenceProxy)(preferences, schema);
}
function bindEditorPreviewPreferences(bind) {
    bind(exports.EditorPreviewPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get(common_1.PreferenceService);
        const contribution = ctx.container.get(exports.EditorPreviewPreferenceContribution);
        return createEditorPreviewPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(exports.EditorPreviewPreferenceContribution).toConstantValue({ schema: exports.EditorPreviewConfigSchema });
    bind(common_1.PreferenceContribution).toService(exports.EditorPreviewPreferenceContribution);
}
//# sourceMappingURL=editor-preview-preferences.js.map