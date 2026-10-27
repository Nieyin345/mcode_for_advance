"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.MonacoFormatterService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/workspace/lib/browser");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const languageFeatures_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/services/languageFeatures");
const monaco_editor_1 = require("./monaco-editor");
function hasFormatterMetadata(formatter) {
    const provider = formatter;
    return provider.extensionId !== undefined && provider.displayName !== undefined;
}
const PREFERENCE_NAME = 'editor.defaultFormatter';
let MonacoFormatterService = class MonacoFormatterService {
    constructor() {
        this.onDidChangeFormattersEmitter = new core_1.Emitter();
        this.onDidChangeFormatters = this.onDidChangeFormattersEmitter.event;
    }
    init() {
        const languageFeaturesService = standaloneServices_1.StandaloneServices.get(languageFeatures_1.ILanguageFeaturesService);
        languageFeaturesService.documentFormattingEditProvider.onDidChange(() => {
            this.onDidChangeFormattersEmitter.fire();
        });
        languageFeaturesService.documentRangeFormattingEditProvider.onDidChange(() => {
            this.onDidChangeFormattersEmitter.fire();
        });
        this.preferenceService.onPreferenceChanged(change => {
            if (change.preferenceName.includes(PREFERENCE_NAME)) {
                this.onDidChangeFormattersEmitter.fire();
            }
        });
    }
    getFormatterPreferenceName(languageId) {
        return this.preferenceSchema.overridePreferenceName({
            preferenceName: PREFERENCE_NAME,
            overrideIdentifier: languageId
        });
    }
    getFormatterStatus(editor) {
        const { languageId, uri: resourceUri } = editor.document;
        const formatters = this.getAvailableFormatters(editor);
        const preferenceName = this.getFormatterPreferenceName(languageId);
        const configuredStatus = this.getConfiguredFormatterStatus(preferenceName, resourceUri, formatters);
        if (configuredStatus) {
            return configuredStatus;
        }
        if (formatters.length === 1) {
            return {
                formatter: formatters[0],
                scope: 'auto',
                isInvalid: false,
                configuredFormatterId: undefined
            };
        }
        return {
            formatter: undefined,
            scope: 'none',
            isInvalid: false,
            configuredFormatterId: undefined
        };
    }
    getConfiguredFormatterStatus(preferenceName, resourceUri, formatters) {
        const inspection = this.preferenceService.inspect(preferenceName, resourceUri);
        if (!inspection) {
            return undefined;
        }
        const configuredFormatterId = inspection.workspaceFolderValue ?? inspection.workspaceValue ?? inspection.globalValue;
        if (configuredFormatterId === undefined) {
            return undefined;
        }
        const preferenceScope = this.getConfiguredScopeFromInspection(inspection);
        const scope = this.preferenceToFormatterScope(preferenceScope);
        const formatter = formatters.find(f => f.id === configuredFormatterId);
        return {
            formatter,
            scope,
            isInvalid: formatter === undefined,
            configuredFormatterId
        };
    }
    /**
     * Determines the preference scope from an inspection result.
     * In single-folder workspaces, folder and workspace scopes are equivalent,
     * so we need to check if we're in a multi-root workspace.
     */
    getConfiguredScopeFromInspection(inspection) {
        if (this.workspaceService.isMultiRootWorkspaceOpened && inspection.workspaceFolderValue !== undefined) {
            return core_1.PreferenceScope.Folder;
        }
        if (inspection.workspaceValue !== undefined) {
            return core_1.PreferenceScope.Workspace;
        }
        if (inspection.globalValue !== undefined) {
            return core_1.PreferenceScope.User;
        }
        return undefined;
    }
    preferenceToFormatterScope(scope) {
        switch (scope) {
            case core_1.PreferenceScope.Folder:
                return 'folder';
            case core_1.PreferenceScope.Workspace:
                return 'workspace';
            case core_1.PreferenceScope.User:
                return 'user';
            default:
                return 'none';
        }
    }
    getAvailableFormatters(editor) {
        const model = this.getEditorModel(editor);
        if (!model) {
            return [];
        }
        const languageFeaturesService = standaloneServices_1.StandaloneServices.get(languageFeatures_1.ILanguageFeaturesService);
        const documentFormatters = languageFeaturesService.documentFormattingEditProvider.ordered(model);
        const rangeFormatters = languageFeaturesService.documentRangeFormattingEditProvider.ordered(model);
        return this.extractUniqueFormatters([...documentFormatters, ...rangeFormatters]);
    }
    getEditorModel(editor) {
        if (editor instanceof monaco_editor_1.MonacoEditor) {
            // Cast is needed because getModel() returns the API ITextModel type
            // which differs from the internal ITextModel type we import
            return editor.getControl().getModel();
        }
        return undefined;
    }
    extractUniqueFormatters(formatters) {
        const formatterMap = new Map();
        for (const formatter of formatters) {
            if (hasFormatterMetadata(formatter)) {
                const id = formatter.extensionId.value;
                if (!formatterMap.has(id)) {
                    formatterMap.set(id, {
                        id,
                        displayName: formatter.displayName
                    });
                }
            }
        }
        return Array.from(formatterMap.values());
    }
    async setDefaultFormatter(languageIdOrEditor, formatterId, scope) {
        const isEditor = typeof languageIdOrEditor !== 'string';
        const languageId = isEditor ? languageIdOrEditor.document.languageId : languageIdOrEditor;
        const resourceUri = isEditor ? languageIdOrEditor.document.uri : undefined;
        const preferenceName = this.getFormatterPreferenceName(languageId);
        await this.preferenceService.set(preferenceName, formatterId, scope, resourceUri);
    }
    getDefaultFormatter(languageId, resourceUri) {
        const preferenceName = this.getFormatterPreferenceName(languageId);
        return this.preferenceService.get(preferenceName, undefined, resourceUri);
    }
    getConfiguredScope(editor) {
        const { languageId, uri: resourceUri } = editor.document;
        const preferenceName = this.getFormatterPreferenceName(languageId);
        const inspection = this.preferenceService.inspect(preferenceName, resourceUri);
        if (!inspection) {
            return undefined;
        }
        return this.getConfiguredScopeFromInspection(inspection);
    }
};
exports.MonacoFormatterService = MonacoFormatterService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], MonacoFormatterService.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceLanguageOverrideService),
    tslib_1.__metadata("design:type", core_1.PreferenceLanguageOverrideService)
], MonacoFormatterService.prototype, "preferenceSchema", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.WorkspaceService),
    tslib_1.__metadata("design:type", browser_1.WorkspaceService)
], MonacoFormatterService.prototype, "workspaceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MonacoFormatterService.prototype, "init", null);
exports.MonacoFormatterService = MonacoFormatterService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoFormatterService);
//# sourceMappingURL=monaco-formatter-service.js.map