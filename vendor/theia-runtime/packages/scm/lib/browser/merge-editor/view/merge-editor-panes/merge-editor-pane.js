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
exports.MergeEditorPane = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const observable_1 = require("@theia/core/lib/common/observable");
const browser_1 = require("@theia/core/lib/browser");
const browser_2 = require("@theia/editor/lib/browser");
const monaco_editor_1 = require("@theia/monaco/lib/browser/monaco-editor");
const monaco_to_protocol_converter_1 = require("@theia/monaco/lib/browser/monaco-to-protocol-converter");
const monaco_editor_core_1 = require("@theia/monaco-editor-core");
const merge_editor_pane_header_1 = require("./merge-editor-pane-header");
const range_utils_1 = require("../../model/range-utils");
const scm_colors_1 = require("../../../scm-colors");
let MergeEditorPane = class MergeEditorPane extends browser_1.BoxPanel {
    get editor() {
        return monaco_editor_1.MonacoEditor.get(this.editorWidget);
    }
    constructor() {
        super({ spacing: 0 });
        this.toDispose = new core_1.DisposableCollection();
        this.addClass('editor-pane');
    }
    init() {
        this.cursorPositionObservable = observable_1.ObservableFromEvent.create(this.editor.onCursorPositionChanged, () => this.editor.cursor);
        this.cursorLineObservable = observable_1.DerivedObservable.create(() => this.cursorPositionObservable.get().line);
        this.selectionObservable = observable_1.ObservableFromEvent.create(this.editor.getControl().onDidChangeCursorSelection, () => {
            const selections = this.editor.getControl().getSelections();
            return selections?.map(selection => this.m2p.asRange(selection));
        });
        browser_1.BoxPanel.setStretch(this.header, 0);
        browser_1.BoxPanel.setStretch(this.editorWidget, 1);
        this.addWidget(this.header);
        this.addWidget(this.editorWidget);
    }
    dispose() {
        super.dispose();
        this.toDispose.dispose();
    }
    get mergeEditor() {
        return this._mergeEditor;
    }
    set mergeEditor(mergeEditor) {
        if (this._mergeEditor) {
            throw new Error('Merge editor has already been set');
        }
        this._mergeEditor = mergeEditor;
        this.onAfterMergeEditorSet();
    }
    onAfterMergeEditorSet() {
        this.initContextKeys();
        const toolbarItems = observable_1.DerivedObservable.create(() => this.getToolbarItems());
        this.toDispose.push(observable_1.Autorun.create(() => {
            this.header.toolbarItems = toolbarItems.get();
        }));
        this.initSelectionSynchronizer();
        let decorationIds = [];
        const decorations = observable_1.DerivedObservable.create(() => this.computeEditorDecorations());
        const isVisible = observable_1.ObservableFromEvent.create(this.editorWidget.onDidChangeVisibility, () => this.editorWidget.isVisible);
        this.toDispose.push(observable_1.Autorun.create(() => {
            if (this.mergeEditor.isShown && isVisible.get()) {
                decorationIds = this.editor.deltaDecorations({ oldDecorations: decorationIds, newDecorations: decorations.get() });
            }
        }));
        this.toDispose.push(core_1.Disposable.create(() => decorationIds = this.editor.deltaDecorations({ oldDecorations: decorationIds, newDecorations: [] })));
    }
    get cursorPosition() {
        return this.cursorPositionObservable.get();
    }
    get cursorLine() {
        return this.cursorLineObservable.get();
    }
    get selection() {
        return this.selectionObservable.get();
    }
    goToMergeRange(mergeRange, options) {
        const { editor } = this;
        const { startLineNumber } = this.getLineRangeForMergeRange(mergeRange);
        editor.cursor = { line: startLineNumber, character: 0 };
        const reveal = options?.reveal ?? true;
        if (reveal) {
            editor.getControl().setScrollTop(editor.getControl().getTopForLineNumber(startLineNumber + 1, true));
        }
    }
    getToolbarItems() {
        return [];
    }
    computeEditorDecorations() {
        return [];
    }
    toMergeRangeDecoration(lineRange, { isHandled, isFocused, isAfterEnd }) {
        const blockClassNames = ['merge-range'];
        let blockPadding = [0, 0, 0, 0];
        if (isHandled) {
            blockClassNames.push('handled');
        }
        if (isFocused) {
            blockClassNames.push('focused');
            blockPadding = [0, 2, 0, 2];
        }
        return {
            range: lineRange.toInclusiveRangeOrEmpty(),
            options: {
                blockClassName: blockClassNames.join(' '),
                blockPadding,
                blockIsAfterEnd: isAfterEnd,
                minimap: {
                    position: browser_2.MinimapPosition.Gutter,
                    color: { id: isHandled ? scm_colors_1.ScmColors.handledConflictMinimapOverviewRulerColor : scm_colors_1.ScmColors.unhandledConflictMinimapOverviewRulerColor },
                },
                overviewRuler: {
                    position: browser_2.OverviewRulerLane.Center,
                    color: { id: isHandled ? scm_colors_1.ScmColors.handledConflictMinimapOverviewRulerColor : scm_colors_1.ScmColors.unhandledConflictMinimapOverviewRulerColor },
                },
                showIfCollapsed: true,
                stickiness: browser_2.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            }
        };
    }
    toChangeDecorations(changes, { diffSide }) {
        const result = [];
        for (const change of changes) {
            const changeRange = (diffSide === 'original' ? change.originalRange : change.modifiedRange).toInclusiveRange();
            if (changeRange) {
                result.push({
                    range: changeRange,
                    options: {
                        className: 'diff',
                        isWholeLine: true,
                        stickiness: browser_2.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    }
                });
            }
            for (const rangeMapping of change.rangeMappings) {
                const range = diffSide === 'original' ? rangeMapping.originalRange : rangeMapping.modifiedRange;
                result.push({
                    range,
                    options: {
                        className: range_utils_1.RangeUtils.isEmpty(range) ? 'diff-empty-word' : 'diff-word',
                        showIfCollapsed: true,
                        stickiness: browser_2.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    },
                });
            }
        }
        return result;
    }
    initContextKeys() {
        const editor = this.editor.getControl();
        editor.createContextKey('isMergeEditor', true);
        editor.createContextKey('mergeEditorBaseUri', this.mergeEditor.baseUri.toString());
        editor.createContextKey('mergeEditorResultUri', this.mergeEditor.resultUri.toString());
    }
    initSelectionSynchronizer() {
        const selectionObservable = observable_1.DerivedObservable.create(() => {
            const { selectionInBase, currentPane } = this.mergeEditor;
            if (!selectionInBase || currentPane === this) {
                return [];
            }
            return selectionInBase.map(range => this.translateBaseRange(range));
        });
        this.toDispose.push(observable_1.Autorun.create(() => {
            const selection = selectionObservable.get();
            if (selection.length) {
                this.editor.getControl().setSelections(selection.map(({ start, end }) => new monaco_editor_core_1.Selection(start.line + 1, start.character + 1, end.line + 1, end.character + 1)));
            }
        }));
    }
    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        this.editorWidget.editor.focus();
    }
};
exports.MergeEditorPane = MergeEditorPane;
tslib_1.__decorate([
    (0, inversify_1.inject)(merge_editor_pane_header_1.MergeEditorPaneHeader),
    tslib_1.__metadata("design:type", merge_editor_pane_header_1.MergeEditorPaneHeader)
], MergeEditorPane.prototype, "header", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.EditorWidget),
    tslib_1.__metadata("design:type", browser_2.EditorWidget)
], MergeEditorPane.prototype, "editorWidget", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_to_protocol_converter_1.MonacoToProtocolConverter),
    tslib_1.__metadata("design:type", monaco_to_protocol_converter_1.MonacoToProtocolConverter)
], MergeEditorPane.prototype, "m2p", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MergeEditorPane.prototype, "init", null);
exports.MergeEditorPane = MergeEditorPane = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], MergeEditorPane);
//# sourceMappingURL=merge-editor-pane.js.map