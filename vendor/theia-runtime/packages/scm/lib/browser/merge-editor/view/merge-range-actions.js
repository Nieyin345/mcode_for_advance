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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/view/conflictActions.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.MergeRangeActions = void 0;
const observable_1 = require("@theia/core/lib/common/observable");
const merge_range_1 = require("../model/merge-range");
const core_1 = require("@theia/core");
class MergeRangeActions {
    get hasSideActions() { return this.hasSideActionsObservable.get(); }
    get hasResultActions() { return this.hasResultActionsObservable.get(); }
    constructor(mergeEditor, mergeRange) {
        this.mergeEditor = mergeEditor;
        this.mergeRange = mergeRange;
        this.side1ActionsObservable = observable_1.DerivedObservable.create(() => this.getActionsForSide(1));
        this.side2ActionsObservable = observable_1.DerivedObservable.create(() => this.getActionsForSide(2));
        this.resultActionsObservable = observable_1.DerivedObservable.create(() => this.getResultActions());
        this.hasSideActionsObservable = observable_1.DerivedObservable.create(() => this.side1ActionsObservable.get().length + this.side2ActionsObservable.get().length > 0);
        this.hasResultActionsObservable = observable_1.DerivedObservable.create(() => this.resultActionsObservable.get().length > 0);
    }
    getActionsForSide(side) {
        const { mergeEditor, mergeRange } = this;
        const { model, side1Title, side2Title } = mergeEditor;
        if (!model.hasMergeRange(mergeRange)) {
            return [];
        }
        const result = [];
        const sideTitle = side === 1 ? side1Title : side2Title;
        const state = model.getMergeRangeResultState(mergeRange);
        if (state !== 'Unrecognized' && !state.includes('Side' + side) && mergeRange.getChanges(side).length &&
            (state === 'Base' || !(mergeRange.isEqualChange || mergeRange.getModifiedRange(side).isEmpty))) {
            result.push({
                text: core_1.nls.localizeByDefault('Accept {0}', sideTitle),
                tooltip: core_1.nls.localizeByDefault('Accept {0} in the result document.', sideTitle),
                run: () => this.applyMergeRangeAcceptedState(mergeRange, merge_range_1.MergeRangeAcceptedState.addSide(state, side))
            });
            if (mergeRange.canBeSmartCombined(side)) {
                result.push({
                    text: mergeRange.isSmartCombinationOrderRelevant ?
                        core_1.nls.localizeByDefault('Accept Combination ({0} First)', sideTitle) :
                        core_1.nls.localizeByDefault('Accept Combination'),
                    tooltip: core_1.nls.localizeByDefault('Accept an automatic combination of both sides in the result document.'),
                    run: () => this.applyMergeRangeAcceptedState(mergeRange, merge_range_1.MergeRangeAcceptedState.addSide(side === 1 ? 'Side1' : 'Side2', side === 1 ? 2 : 1, { smartCombination: true }))
                });
            }
        }
        return result;
    }
    getResultActions() {
        const { mergeEditor, mergeRange } = this;
        const { model, side1Title, side2Title } = mergeEditor;
        if (!model.hasMergeRange(mergeRange)) {
            return [];
        }
        const result = [];
        const state = model.getMergeRangeResultState(mergeRange);
        if (state === 'Unrecognized') {
            result.push({
                text: core_1.nls.localizeByDefault('Manual Resolution'),
                tooltip: core_1.nls.localizeByDefault('This conflict has been resolved manually.')
            });
            result.push({
                text: core_1.nls.localizeByDefault('Reset to base'),
                tooltip: core_1.nls.localizeByDefault('Reset this conflict to the common ancestor of both the right and left changes.'),
                run: () => this.applyMergeRangeAcceptedState(mergeRange, 'Base')
            });
        }
        else if (state === 'Base') {
            result.push({
                text: core_1.nls.localizeByDefault('No Changes Accepted'),
                tooltip: core_1.nls.localizeByDefault('The current resolution of this conflict equals the common ancestor of both the right and left changes.')
            });
            if (!model.isMergeRangeHandled(mergeRange)) {
                result.push({
                    text: core_1.nls.localizeByDefault('Mark as Handled'),
                    run: () => this.markMergeRangeAsHandled(mergeRange)
                });
            }
        }
        else if (mergeRange.isEqualChange) {
            result.push({
                text: side1Title + ' = ' + side2Title
            });
            result.push({
                text: core_1.nls.localizeByDefault('Reset to base'),
                tooltip: core_1.nls.localizeByDefault('Reset this conflict to the common ancestor of both the right and left changes.'),
                run: () => this.applyMergeRangeAcceptedState(mergeRange, 'Base')
            });
        }
        else {
            const labels = [];
            const stateToggles = [];
            if (state.includes('Side1')) {
                labels.push(side1Title);
                stateToggles.push({
                    text: core_1.nls.localizeByDefault('Remove {0}', side1Title),
                    tooltip: core_1.nls.localizeByDefault('Remove {0} from the result document.', side1Title),
                    run: () => this.applyMergeRangeAcceptedState(mergeRange, merge_range_1.MergeRangeAcceptedState.removeSide(state, 1))
                });
            }
            if (state.includes('Side2')) {
                labels.push(side2Title);
                stateToggles.push({
                    text: core_1.nls.localizeByDefault('Remove {0}', side2Title),
                    tooltip: core_1.nls.localizeByDefault('Remove {0} from the result document.', side2Title),
                    run: () => this.applyMergeRangeAcceptedState(mergeRange, merge_range_1.MergeRangeAcceptedState.removeSide(state, 2))
                });
            }
            if (state.startsWith('Side2')) {
                labels.reverse();
                stateToggles.reverse();
            }
            if (labels.length) {
                result.push({
                    text: labels.join(' + ')
                });
            }
            result.push(...stateToggles);
        }
        return result;
    }
    async applyMergeRangeAcceptedState(mergeRange, state) {
        const { model, resultPane } = this.mergeEditor;
        resultPane.activate();
        await observable_1.ObservableUtils.waitForState(model.isUpToDateObservable);
        resultPane.goToMergeRange(mergeRange, { reveal: false }); // set the cursor state that will be restored when undoing the operation
        model.applyMergeRangeAcceptedState(mergeRange, state);
        await observable_1.ObservableUtils.waitForState(model.isUpToDateObservable);
        resultPane.goToMergeRange(mergeRange, { reveal: false }); // set the resulting cursor state
    }
    async markMergeRangeAsHandled(mergeRange) {
        const { model, resultPane } = this.mergeEditor;
        resultPane.activate();
        await observable_1.ObservableUtils.waitForState(model.isUpToDateObservable);
        resultPane.goToMergeRange(mergeRange, { reveal: false });
        const { cursor } = resultPane.editor;
        const editorRef = new WeakRef(resultPane.editor);
        const revealMergeRange = () => {
            const editor = editorRef.deref();
            if (editor && !editor.isDisposed()) {
                editor.cursor = cursor;
                editor.revealPosition(cursor, { vertical: 'auto' });
            }
        };
        model.markMergeRangeAsHandled(mergeRange, {
            undoRedo: {
                callback: {
                    didUndo() {
                        revealMergeRange();
                    },
                    didRedo() {
                        revealMergeRange();
                    }
                }
            }
        });
    }
}
exports.MergeRangeActions = MergeRangeActions;
//# sourceMappingURL=merge-range-actions.js.map