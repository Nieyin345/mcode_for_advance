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
exports.MergeEditorBasePane = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const observable_1 = require("@theia/core/lib/common/observable");
const merge_editor_pane_1 = require("./merge-editor-pane");
let MergeEditorBasePane = class MergeEditorBasePane extends merge_editor_pane_1.MergeEditorPane {
    constructor() {
        super();
        this.addClass('base');
    }
    getLineRangeForMergeRange(mergeRange) {
        return mergeRange.baseRange;
    }
    translateBaseRange(range) {
        return range;
    }
    onAfterMergeEditorSet() {
        super.onAfterMergeEditorSet();
        this.toDispose.push(observable_1.Autorun.create(() => {
            const { currentPane, side1Pane, side1Title, side2Pane, side2Title } = this.mergeEditor;
            this.header.description = currentPane === this ? '' : core_1.nls.localizeByDefault('Comparing with {0}', currentPane === side1Pane ? side1Title : currentPane === side2Pane ? side2Title : core_1.nls.localizeByDefault('Result'));
        }));
    }
    computeEditorDecorations() {
        const result = [];
        const { model, currentPane, side1Pane, side2Pane, currentMergeRange } = this.mergeEditor;
        for (const mergeRange of model.mergeRanges) {
            const lineRange = mergeRange.baseRange;
            result.push(this.toMergeRangeDecoration(lineRange, {
                isHandled: model.isMergeRangeHandled(mergeRange),
                isFocused: mergeRange === currentMergeRange,
                isAfterEnd: lineRange.startLineNumber > model.baseDocument.lineCount,
            }));
        }
        if (currentPane !== this) {
            const changes = currentPane === side1Pane ? model.side1Changes : currentPane === side2Pane ? model.side2Changes : model.resultChanges;
            result.push(...this.toChangeDecorations(changes, { diffSide: 'original' }));
        }
        return result;
    }
};
exports.MergeEditorBasePane = MergeEditorBasePane;
exports.MergeEditorBasePane = MergeEditorBasePane = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], MergeEditorBasePane);
//# sourceMappingURL=merge-editor-base-pane.js.map