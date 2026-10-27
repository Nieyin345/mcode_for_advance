"use strict";
// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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
exports.EditorPreferences = exports.EditorPreferenceContribution = exports.editorPreferenceSchema = void 0;
exports.createEditorPreferences = createEditorPreferences;
exports.bindEditorPreferences = bindEditorPreferences;
const preferences_1 = require("@theia/core/lib/common/preferences");
const nls_1 = require("@theia/core/lib/common/nls");
const core_1 = require("@theia/core");
const editor_generated_preference_schema_1 = require("./editor-generated-preference-schema");
/* eslint-disable max-len,no-null/no-null */
// #region src/vs/workbench/contrib/codeActions/browser/codeActionsContribution.ts
const codeActionsContributionSchema = {
    'editor.codeActionsOnSave': {
        oneOf: [
            {
                type: 'object',
                properties: {
                    'source.fixAll': {
                        type: 'boolean',
                        description: nls_1.nls.localizeByDefault('Controls whether \'{0}\' actions should be run on file save.', 'quickfix')
                    }
                },
                additionalProperties: {
                    type: 'boolean'
                },
            },
            {
                type: 'array',
                items: { type: 'string' }
            }
        ],
        default: {},
        markdownDescription: nls_1.nls.localizeByDefault('Run Code Actions for the editor on save. Code Actions must be specified and the editor must not be shutting down. When {0} is set to `afterDelay`, Code Actions will only be run when the file is saved explicitly. Example: `"source.organizeImports": "explicit" `'),
        scope: preferences_1.PreferenceScope.Folder,
        overridable: true
    }
};
// #endregion
// #region src/vs/workbench/contrib/files/browser/files.contribution.ts
const fileContributionSchema = {
    'editor.formatOnSave': {
        'type': 'boolean',
        'description': nls_1.nls.localizeByDefault('Format a file on save. A formatter must be available and the editor must not be shutting down. When {0} is set to `afterDelay`, the file will only be formatted when saved explicitly.', '`#files.autoSave#`'),
        'scope': preferences_1.PreferenceScope.Folder,
        overridable: true
    },
    'editor.formatOnSaveMode': {
        'type': 'string',
        'default': 'file',
        'enum': [
            'file',
            'modifications',
            'modificationsIfAvailable'
        ],
        'enumDescriptions': [
            nls_1.nls.localizeByDefault('Format the whole file.'),
            nls_1.nls.localizeByDefault("Format modifications. Requires source control and a formatter that supports 'Format Selection'."),
            nls_1.nls.localizeByDefault('Will attempt to format modifications only (requires source control and a formatter that supports \'Format Selection\'). If source control can\'t be used, then the whole file will be formatted.'),
        ],
        'markdownDescription': nls_1.nls.localizeByDefault('Controls if format on save formats the whole file or only modifications. Only applies when `#editor.formatOnSave#` is enabled.'),
        'scope': preferences_1.PreferenceScope.Folder,
        overridable: true
    },
    // Include this, even though it is not strictly an `editor`preference.
    'files.eol': {
        'type': 'string',
        'enum': [
            '\n',
            '\r\n',
            'auto'
        ],
        'enumDescriptions': [
            nls_1.nls.localizeByDefault('LF'),
            nls_1.nls.localizeByDefault('CRLF'),
            nls_1.nls.localizeByDefault('Uses operating system specific end of line character.')
        ],
        'default': 'auto',
        'description': nls_1.nls.localizeByDefault('The default end of line character.'),
        scope: preferences_1.PreferenceScope.Folder,
        overridable: true
    },
    // We used to call these `editor.autoSave` and `editor.autoSaveDelay`.
    'files.autoSave': {
        'type': 'string',
        'enum': ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'],
        'markdownEnumDescriptions': [
            nls_1.nls.localizeByDefault('An editor with changes is never automatically saved.'),
            nls_1.nls.localizeByDefault('An editor with changes is automatically saved after the configured `#files.autoSaveDelay#`.'),
            nls_1.nls.localizeByDefault('An editor with changes is automatically saved when the editor loses focus.'),
            nls_1.nls.localizeByDefault('An editor with changes is automatically saved when the window loses focus.')
        ],
        'default': core_1.environment.electron.is() ? 'off' : 'afterDelay',
        'markdownDescription': nls_1.nls.localizeByDefault('Controls [auto save](https://code.visualstudio.com/docs/editor/codebasics#_save-auto-save) of editors that have unsaved changes.')
    },
    'files.autoSaveDelay': {
        'type': 'number',
        'default': 1000,
        'minimum': 0,
        'markdownDescription': nls_1.nls.localizeByDefault('Controls the delay in milliseconds after which an editor with unsaved changes is saved automatically. Only applies when `#files.autoSave#` is set to `{0}`.', 'afterDelay')
    },
    'files.autoSaveWhenNoErrors': {
        'type': 'boolean',
        'default': false,
        'markdownDescription': nls_1.nls.localize('theia/editor/autoSaveWhenNoErrors', 'When enabled, will limit auto save of editors to files that have no errors reported in them at the time the auto save is triggered. Only applies when {0} is enabled.', '`#files.autoSave#`')
    },
    'files.refactoring.autoSave': {
        'type': 'boolean',
        'default': true,
        'description': nls_1.nls.localizeByDefault('Controls if files that were part of a refactoring are saved automatically')
    }
};
// #endregion
// #region src/vs/workbench/contrib/format/browser/formatActionsMultiple.ts
// This schema depends on a lot of private stuff in the file, so this is a stripped down version.
const formatActionsMultipleSchema = {
    'editor.defaultFormatter': {
        description: nls_1.nls.localizeByDefault('Defines a default formatter which takes precedence over all other formatter settings. Must be the identifier of an extension contributing a formatter.'),
        type: ['string', 'null'],
        default: null,
    }
};
// #endregion
// #region Custom Theia extensions to editor preferences
const theiaEditorSchema = {
    'editor.formatOnSaveTimeout': {
        'type': 'number',
        'default': 750,
        'description': nls_1.nls.localize('theia/editor/formatOnSaveTimeout', 'Timeout in milliseconds after which the formatting that is run on file save is cancelled.')
    },
    'editor.history.persistClosedEditors': {
        'type': 'boolean',
        'default': false,
        'description': nls_1.nls.localize('theia/editor/persistClosedEditors', 'Controls whether to persist closed editor history for the workspace across window reloads.')
    },
};
// #endregion
const combinedProperties = {
    ...editor_generated_preference_schema_1.editorGeneratedPreferenceProperties,
    ...codeActionsContributionSchema,
    ...fileContributionSchema,
    ...formatActionsMultipleSchema,
    ...theiaEditorSchema
};
exports.editorPreferenceSchema = {
    scope: preferences_1.PreferenceScope.Folder,
    defaultOverridable: true,
    properties: combinedProperties,
};
exports.EditorPreferenceContribution = Symbol('EditorPreferenceContribution');
exports.EditorPreferences = Symbol('EditorPreferences');
/**
 * @deprecated @since 1.23.0
 *
 * By default, editor preferences now use a validated preference proxy created by the PreferenceProxyFactory binding.
 * This function will create an unvalidated preference proxy.
 * See {@link bindEditorPreferences}
 */
function createEditorPreferences(preferences, schema = exports.editorPreferenceSchema) {
    return (0, preferences_1.createPreferenceProxy)(preferences, schema);
}
function bindEditorPreferences(bind) {
    bind(exports.EditorPreferences).toDynamicValue(ctx => {
        const factory = ctx.container.get(preferences_1.PreferenceProxyFactory);
        return factory(exports.editorPreferenceSchema);
    }).inSingletonScope();
    bind(exports.EditorPreferenceContribution).toConstantValue({ schema: exports.editorPreferenceSchema });
    bind(preferences_1.PreferenceContribution).toService(exports.EditorPreferenceContribution);
}
//# sourceMappingURL=editor-preferences.js.map