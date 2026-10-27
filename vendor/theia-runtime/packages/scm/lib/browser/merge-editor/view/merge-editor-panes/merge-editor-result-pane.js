"use strict";
// *****************************************************************************
// Copyright (C) 2025 1C-Soft LLC and others.
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
exports.MergeEditorResultPane = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const observable_1 = require("@theia/core/lib/common/observable");
const navigation_location_1 = require("@theia/editor/lib/browser/navigation/navigation-location");
const navigation_location_service_1 = require("@theia/editor/lib/browser/navigation/navigation-location-service");
const merge_editor_pane_1 = require("./merge-editor-pane");
let MergeEditorResultPane = class MergeEditorResultPane extends merge_editor_pane_1.MergeEditorPane {
    constructor() {
        super();
        this.addClass('result');
    }
    initContextKeys() {
        super.initContextKeys();
        this.editor.getControl().createContextKey('isMergeResultEditor', true);
    }
    initSelectionSynchronizer() {
        super.initSelectionSynchronizer();
        this.toDispose.push(observable_1.Autorun.create(() => {
            const selection = this.selectionObservable.get();
            if (selection?.length === 1) {
                this.navigationLocationService.navigate(service => service.register(navigation_location_1.NavigationLocation.create(this.editor, selection[0])));
            }
        }));
    }
    getLineRangeForMergeRange(mergeRange) {
        return this.mergeEditor.model.getLineRangeInResult(mergeRange);
    }
    translateBaseRange(range) {
        return this.mergeEditor.model.translateBaseRangeToResult(range);
    }
    goToNextUnhandledMergeRange() {
        this.mergeEditor.goToNextMergeRange(mergeRange => !this.mergeEditor.model.isMergeRangeHandled(mergeRange));
        this.mergeEditor.activate();
    }
    reset() {
        new browser_1.ConfirmDialog({
            title: core_1.nls.localize('theia/scm/mergeEditor/resetConfirmationTitle', 'Do you really want to reset the merge result in this editor?'),
            msg: core_1.nls.localizeByDefault('This action cannot be undone.'),
            ok: browser_1.Dialog.YES,
            cancel: browser_1.Dialog.NO,
        }).open().then(async (confirmed) => {
            if (confirmed) {
                this.activate();
                const { model } = this.mergeEditor;
                await model.reset();
                await observable_1.ObservableUtils.waitForState(model.isUpToDateObservable);
                this.mergeEditor.goToFirstMergeRange(mergeRange => !model.isMergeRangeHandled(mergeRange));
            }
        }).catch(e => this.logger.error(e));
    }
    getToolbarItems() {
        const { model } = this.mergeEditor;
        const { unhandledMergeRangesCount } = model;
        return [
            {
                id: 'nextConflict',
                label: unhandledMergeRangesCount === 1 ?
                    core_1.nls.localizeByDefault('{0} Conflict Remaining', unhandledMergeRangesCount) :
                    core_1.nls.localizeByDefault('{0} Conflicts Remaining ', unhandledMergeRangesCount),
                tooltip: unhandledMergeRangesCount ?
                    core_1.nls.localizeByDefault('Go to next conflict') :
                    core_1.nls.localizeByDefault('All conflicts handled, the merge can be completed now.'),
                className: browser_1.ACTION_ITEM + (unhandledMergeRangesCount ? '' : ' ' + browser_1.DISABLED_CLASS),
                onClick: unhandledMergeRangesCount ?
                    () => this.goToNextUnhandledMergeRange() :
                    undefined
            },
            {
                id: 'reset',
                tooltip: core_1.nls.localizeByDefault('Reset'),
                className: (0, browser_1.codicon)('discard', true),
                onClick: () => this.reset()
            }
        ];
    }
    computeEditorDecorations() {
        const result = [];
        const { model, currentMergeRange } = this.mergeEditor;
        for (const mergeRange of model.mergeRanges) {
            if (mergeRange) {
                const lineRange = model.getLineRangeInResult(mergeRange);
                result.push(this.toMergeRangeDecoration(lineRange, {
                    isHandled: model.isMergeRangeHandled(mergeRange),
                    isFocused: mergeRange === currentMergeRange,
                    isAfterEnd: lineRange.startLineNumber > model.resultDocument.lineCount,
                }));
            }
        }
        result.push(...this.toChangeDecorations(model.resultChanges, { diffSide: 'modified' }));
        return result;
    }
};
exports.MergeEditorResultPane = MergeEditorResultPane;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('scm:MergeEditorResultPane'),
    tslib_1.__metadata("design:type", Object)
], MergeEditorResultPane.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(navigation_location_service_1.NavigationLocationService),
    tslib_1.__metadata("design:type", navigation_location_service_1.NavigationLocationService)
], MergeEditorResultPane.prototype, "navigationLocationService", void 0);
exports.MergeEditorResultPane = MergeEditorResultPane = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], MergeEditorResultPane);
//# sourceMappingURL=merge-editor-result-pane.js.map