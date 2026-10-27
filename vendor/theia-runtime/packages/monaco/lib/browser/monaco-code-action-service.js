"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
exports.MonacoCodeActionServiceImpl = exports.MonacoCodeActionService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const languageFeatures_1 = require("@theia/monaco-editor-core/esm/vs/editor/common/services/languageFeatures");
const types_1 = require("@theia/monaco-editor-core/esm/vs/editor/contrib/codeAction/common/types");
const codeAction_1 = require("@theia/monaco-editor-core/esm/vs/editor/contrib/codeAction/browser/codeAction");
const hierarchicalKind_1 = require("@theia/monaco-editor-core/esm/vs/base/common/hierarchicalKind");
const editor_preferences_1 = require("@theia/editor/lib/common/editor-preferences");
const instantiation_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/instantiation");
exports.MonacoCodeActionService = Symbol('MonacoCodeActionService');
let MonacoCodeActionServiceImpl = class MonacoCodeActionServiceImpl {
    async applyOnSaveCodeActions(model, languageId, uri, token) {
        const codeActionSets = await this.getAllCodeActionsOnSave(model, languageId, uri, token);
        if (!codeActionSets || token.isCancellationRequested) {
            return;
        }
        await this.applyCodeActions(model, codeActionSets, token);
    }
    async getAllCodeActionsOnSave(model, languageId, uri, token) {
        const setting = this.editorPreferences.get({
            preferenceName: 'editor.codeActionsOnSave',
            overrideIdentifier: languageId
        }, undefined, uri);
        if (!setting) {
            return undefined;
        }
        const settingItems = Array.isArray(setting)
            ? setting
            : Object.keys(setting).filter(x => setting[x]);
        const codeActionsOnSave = this.createCodeActionsOnSave(settingItems);
        if (!codeActionsOnSave.length) {
            return undefined;
        }
        if (!Array.isArray(setting)) {
            codeActionsOnSave.sort((a, b) => {
                if (types_1.CodeActionKind.SourceFixAll.contains(a)) {
                    if (types_1.CodeActionKind.SourceFixAll.contains(b)) {
                        return 0;
                    }
                    return -1;
                }
                if (types_1.CodeActionKind.SourceFixAll.contains(b)) {
                    return 1;
                }
                return 0;
            });
        }
        const excludedActions = Array.isArray(setting)
            ? []
            : Object.keys(setting)
                .filter(x => setting[x] === false)
                .map(x => new hierarchicalKind_1.HierarchicalKind(x));
        const codeActionSets = [];
        for (const codeActionKind of codeActionsOnSave) {
            const actionsToRun = await this.getActionsToRun(model, codeActionKind, excludedActions, token);
            if (token.isCancellationRequested) {
                actionsToRun.dispose();
                break;
            }
            codeActionSets.push(actionsToRun);
        }
        return codeActionSets;
    }
    async applyCodeActions(model, codeActionSets, token) {
        const instantiationService = standaloneServices_1.StandaloneServices.get(instantiation_1.IInstantiationService);
        for (const codeActionSet of codeActionSets) {
            if (token.isCancellationRequested) {
                codeActionSet.dispose();
                return;
            }
            try {
                for (const action of codeActionSet.validActions) {
                    await instantiationService.invokeFunction(codeAction_1.applyCodeAction, action, codeAction_1.ApplyCodeActionReason.OnSave, {}, token);
                    if (token.isCancellationRequested) {
                        return;
                    }
                }
            }
            catch {
                // Failure to apply a code action should not block other on save actions
            }
            finally {
                codeActionSet.dispose();
            }
        }
    }
    createCodeActionsOnSave(settingItems) {
        const kinds = settingItems.map(x => new hierarchicalKind_1.HierarchicalKind(x));
        // Remove subsets
        return kinds.filter(kind => kinds.every(otherKind => otherKind.equals(kind) || !otherKind.contains(kind)));
    }
    getActionsToRun(model, codeActionKind, excludes, token) {
        const { codeActionProvider } = standaloneServices_1.StandaloneServices.get(languageFeatures_1.ILanguageFeaturesService);
        const progress = {
            report(item) {
                // empty
            },
        };
        return (0, codeAction_1.getCodeActions)(codeActionProvider, model, model.getFullModelRange(), {
            type: 2 /* CodeActionTriggerType.Auto */,
            triggerAction: types_1.CodeActionTriggerSource.OnSave,
            filter: { include: codeActionKind, excludes: excludes, includeSourceActions: true },
        }, progress, token);
    }
};
exports.MonacoCodeActionServiceImpl = MonacoCodeActionServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(editor_preferences_1.EditorPreferences),
    tslib_1.__metadata("design:type", Object)
], MonacoCodeActionServiceImpl.prototype, "editorPreferences", void 0);
exports.MonacoCodeActionServiceImpl = MonacoCodeActionServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoCodeActionServiceImpl);
//# sourceMappingURL=monaco-code-action-service.js.map