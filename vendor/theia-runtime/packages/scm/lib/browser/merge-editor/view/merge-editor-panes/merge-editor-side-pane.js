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
exports.MergeEditorSide2Pane = exports.MergeEditorSide1Pane = exports.MergeEditorSidePane = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const observable_1 = require("@theia/core/lib/common/observable");
const browser_1 = require("@theia/core/lib/browser");
const merge_range_1 = require("../../model/merge-range");
const merge_editor_pane_1 = require("./merge-editor-pane");
let MergeEditorSidePane = class MergeEditorSidePane extends merge_editor_pane_1.MergeEditorPane {
    constructor() {
        super();
        this.addClass('side');
    }
    getLineRangeForMergeRange(mergeRange) {
        return mergeRange.getModifiedRange(this.mergeSide);
    }
    translateBaseRange(range) {
        return this.mergeEditor.model.translateBaseRangeToSide(range, this.mergeSide);
    }
    async acceptAllChanges() {
        const { model, resultPane } = this.mergeEditor;
        resultPane.activate();
        const selections = resultPane.editor.getControl().getSelections();
        for (const mergeRange of model.mergeRanges) {
            await observable_1.ObservableUtils.waitForState(model.isUpToDateObservable);
            resultPane.goToMergeRange(mergeRange, { reveal: false });
            let state = model.getMergeRangeResultState(mergeRange);
            if (state === 'Unrecognized') {
                state = 'Base';
            }
            model.applyMergeRangeAcceptedState(mergeRange, merge_range_1.MergeRangeAcceptedState.addSide(state, this.mergeSide));
        }
        if (selections) {
            resultPane.editor.getControl().setSelections(selections);
        }
    }
    compareWithBase() {
        let label = this.labelProvider.getName(this.editor.uri);
        if (label) {
            label += ': ';
        }
        label += `${core_1.nls.localizeByDefault('Base')} ⟷ ${this.header.title.label}`;
        const options = { selection: { start: this.editor.cursor } };
        (0, browser_1.open)(this.openerService, browser_1.DiffUris.encode(this.mergeEditor.baseUri, this.editor.uri, label), options).catch(e => {
            this.logger.error(e);
        });
    }
    getToolbarItems() {
        return [
            {
                id: 'acceptAllChanges',
                tooltip: core_1.nls.localizeByDefault(this.mergeSide === 1 ? 'Accept All Changes from Left' : 'Accept All Changes from Right'),
                className: (0, browser_1.codicon)('check-all', true),
                onClick: () => this.acceptAllChanges()
            },
            {
                id: 'compareWithBase',
                tooltip: core_1.nls.localizeByDefault('Compare With Base'),
                className: (0, browser_1.codicon)('compare-changes', true),
                onClick: () => this.compareWithBase()
            }
        ];
    }
    computeEditorDecorations() {
        const result = [];
        const { model, currentMergeRange } = this.mergeEditor;
        const document = this.mergeSide === 1 ? model.side1Document : model.side2Document;
        for (const mergeRange of model.mergeRanges) {
            const lineRange = mergeRange.getModifiedRange(this.mergeSide);
            result.push(this.toMergeRangeDecoration(lineRange, {
                isHandled: model.isMergeRangeHandled(mergeRange),
                isFocused: mergeRange === currentMergeRange,
                isAfterEnd: lineRange.startLineNumber > document.lineCount,
            }));
        }
        const changes = this.mergeSide === 1 ? model.side1Changes : model.side2Changes;
        result.push(...this.toChangeDecorations(changes, { diffSide: 'modified' }));
        return result;
    }
};
exports.MergeEditorSidePane = MergeEditorSidePane;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.LabelProvider),
    tslib_1.__metadata("design:type", browser_1.LabelProvider)
], MergeEditorSidePane.prototype, "labelProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.OpenerService),
    tslib_1.__metadata("design:type", Object)
], MergeEditorSidePane.prototype, "openerService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('scm:MergeEditorSidePane'),
    tslib_1.__metadata("design:type", Object)
], MergeEditorSidePane.prototype, "logger", void 0);
exports.MergeEditorSidePane = MergeEditorSidePane = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], MergeEditorSidePane);
let MergeEditorSide1Pane = class MergeEditorSide1Pane extends MergeEditorSidePane {
    constructor() {
        super();
        this.mergeSide = 1;
        this.addClass('side1');
    }
};
exports.MergeEditorSide1Pane = MergeEditorSide1Pane;
exports.MergeEditorSide1Pane = MergeEditorSide1Pane = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], MergeEditorSide1Pane);
let MergeEditorSide2Pane = class MergeEditorSide2Pane extends MergeEditorSidePane {
    constructor() {
        super();
        this.mergeSide = 2;
        this.addClass('side2');
    }
};
exports.MergeEditorSide2Pane = MergeEditorSide2Pane;
exports.MergeEditorSide2Pane = MergeEditorSide2Pane = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], MergeEditorSide2Pane);
//# sourceMappingURL=merge-editor-side-pane.js.map