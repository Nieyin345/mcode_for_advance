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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/model/mergeEditorModel.ts,
// https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/view/viewModel.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.MergeRangeData = exports.MergeEditorModel = exports.MergeEditorModelProps = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const observable_1 = require("@theia/core/lib/common/observable");
const diff_1 = require("@theia/core/lib/common/diff");
const monaco_to_protocol_converter_1 = require("@theia/monaco/lib/browser/monaco-to-protocol-converter");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const undoRedo_1 = require("@theia/monaco-editor-core/esm/vs/platform/undoRedo/common/undoRedo");
const merge_range_1 = require("./merge-range");
const range_mapping_1 = require("./range-mapping");
const live_diff_1 = require("./live-diff");
const line_range_1 = require("./line-range");
const range_editing_1 = require("./range-editing");
const range_utils_1 = require("./range-utils");
exports.MergeEditorModelProps = Symbol('MergeEditorModelProps');
let MergeEditorModel = class MergeEditorModel {
    constructor() {
        this.toDispose = new core_1.DisposableCollection();
        this.shouldRecomputeHandledState = true;
        this.mergeRangesObservable = observable_1.DerivedObservable.create(() => this.computeMergeRanges());
        this.mergeRangesDataObservable = observable_1.DerivedObservable.create(() => new Map(this.mergeRanges.map(mergeRange => [mergeRange, this.newMergeRangeData()])));
        // #region Line Range Mapping
        this.side1ToResultLineRangeMapObservable = observable_1.DerivedObservable.create(() => this.newDocumentLineRangeMap(this.computeSideToResultDiff(this.side1Changes, this.resultChanges)));
        this.resultToSide1LineRangeMapObservable = observable_1.DerivedObservable.create(() => this.side1ToResultLineRangeMap.reverse());
        this.side2ToResultLineRangeMapObservable = observable_1.DerivedObservable.create(() => this.newDocumentLineRangeMap(this.computeSideToResultDiff(this.side2Changes, this.resultChanges)));
        this.resultToSide2LineRangeMapObservable = observable_1.DerivedObservable.create(() => this.side2ToResultLineRangeMap.reverse());
        this.baseToSide1LineRangeMapObservable = observable_1.DerivedObservable.create(() => this.newDocumentLineRangeMap(this.side1Changes));
        this.side1ToBaseLineRangeMapObservable = observable_1.DerivedObservable.create(() => this.baseToSide1LineRangeMap.reverse());
        this.baseToSide2LineRangeMapObservable = observable_1.DerivedObservable.create(() => this.newDocumentLineRangeMap(this.side2Changes));
        this.side2ToBaseLineRangeMapObservable = observable_1.DerivedObservable.create(() => this.baseToSide2LineRangeMap.reverse());
        this.baseToResultLineRangeMapObservable = observable_1.DerivedObservable.create(() => this.newDocumentLineRangeMap(this.resultChanges));
        this.resultToBaseLineRangeMapObservable = observable_1.DerivedObservable.create(() => this.baseToResultLineRangeMap.reverse());
        // #endregion
        // #region Range Mapping
        this.baseToSide1RangeMapObservable = observable_1.DerivedObservable.create(() => this.newDocumentRangeMap(this.side1Changes.flatMap(change => change.rangeMappings)));
        this.side1ToBaseRangeMapObservable = observable_1.DerivedObservable.create(() => this.baseToSide1RangeMap.reverse());
        this.baseToSide2RangeMapObservable = observable_1.DerivedObservable.create(() => this.newDocumentRangeMap(this.side2Changes.flatMap(change => change.rangeMappings)));
        this.side2ToBaseRangeMapObservable = observable_1.DerivedObservable.create(() => this.baseToSide2RangeMap.reverse());
        this.baseToResultRangeMapObservable = observable_1.DerivedObservable.create(() => this.newDocumentRangeMap(this.resultChanges.flatMap(change => change.rangeMappings)));
        this.resultToBaseRangeMapObservable = observable_1.DerivedObservable.create(() => this.baseToResultRangeMap.reverse());
        // #endregion
        this.diffComputingStateObservable = observable_1.DerivedObservable.create(() => this.getDiffComputingState(this.side1LiveDiff, this.side2LiveDiff, this.resultLiveDiff));
        this.diffComputingStateForSidesObservable = observable_1.DerivedObservable.create(() => this.getDiffComputingState(this.side1LiveDiff, this.side2LiveDiff));
        this.isUpToDateObservable = observable_1.DerivedObservable.create(() => this.diffComputingStateObservable.get() === 1 /* DiffComputingState.UpToDate */);
        this.unhandledMergeRangesCountObservable = observable_1.DerivedObservable.create(() => {
            let result = 0;
            const mergeRangesData = this.mergeRangesDataObservable.get();
            for (const mergeRangeData of mergeRangesData.values()) {
                if (!mergeRangeData.isHandledObservable.get()) {
                    result++;
                }
            }
            return result;
        });
    }
    get mergeRanges() {
        return this.mergeRangesObservable.get();
    }
    get side1ToResultLineRangeMap() {
        return this.side1ToResultLineRangeMapObservable.get();
    }
    get resultToSide1LineRangeMap() {
        return this.resultToSide1LineRangeMapObservable.get();
    }
    get side2ToResultLineRangeMap() {
        return this.side2ToResultLineRangeMapObservable.get();
    }
    get resultToSide2LineRangeMap() {
        return this.resultToSide2LineRangeMapObservable.get();
    }
    get baseToSide1LineRangeMap() {
        return this.baseToSide1LineRangeMapObservable.get();
    }
    get side1ToBaseLineRangeMap() {
        return this.side1ToBaseLineRangeMapObservable.get();
    }
    get baseToSide2LineRangeMap() {
        return this.baseToSide2LineRangeMapObservable.get();
    }
    get side2ToBaseLineRangeMap() {
        return this.side2ToBaseLineRangeMapObservable.get();
    }
    get baseToResultLineRangeMap() {
        return this.baseToResultLineRangeMapObservable.get();
    }
    get resultToBaseLineRangeMap() {
        return this.resultToBaseLineRangeMapObservable.get();
    }
    get baseToSide1RangeMap() {
        return this.baseToSide1RangeMapObservable.get();
    }
    get side1ToBaseRangeMap() {
        return this.side1ToBaseRangeMapObservable.get();
    }
    get baseToSide2RangeMap() {
        return this.baseToSide2RangeMapObservable.get();
    }
    get side2ToBaseRangeMap() {
        return this.side2ToBaseRangeMapObservable.get();
    }
    get baseToResultRangeMap() {
        return this.baseToResultRangeMapObservable.get();
    }
    get resultToBaseRangeMap() {
        return this.resultToBaseRangeMapObservable.get();
    }
    get unhandledMergeRangesCount() {
        return this.unhandledMergeRangesCountObservable.get();
    }
    get onInitialized() {
        return this._onInitialized;
    }
    get baseDocument() {
        return this.props.baseEditor.document;
    }
    get side1Document() {
        return this.props.side1Editor.document;
    }
    get side2Document() {
        return this.props.side2Editor.document;
    }
    get resultDocument() {
        return this.props.resultEditor.document;
    }
    get resultEditor() {
        return this.props.resultEditor;
    }
    get side1Changes() {
        return this.side1LiveDiff.changes;
    }
    get side2Changes() {
        return this.side2LiveDiff.changes;
    }
    get resultChanges() {
        return this.resultLiveDiff.changes;
    }
    init() {
        this.toDispose.push(this.side1LiveDiff = this.newLiveDiff(this.baseDocument, this.side1Document));
        this.toDispose.push(this.side2LiveDiff = this.newLiveDiff(this.baseDocument, this.side2Document));
        this.toDispose.push(this.resultLiveDiff = this.newLiveDiff(this.baseDocument, this.resultDocument));
        this.toDispose.push(observable_1.Observable.keepObserved(this.mergeRangesDataObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.side1ToResultLineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.resultToSide1LineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.side2ToResultLineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.resultToSide2LineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.baseToSide1LineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.side1ToBaseLineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.baseToSide2LineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.side2ToBaseLineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.baseToResultLineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.resultToBaseLineRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.baseToSide1RangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.side1ToBaseRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.baseToSide2RangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.side2ToBaseRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.baseToResultRangeMapObservable));
        this.toDispose.push(observable_1.Observable.keepObserved(this.resultToBaseRangeMapObservable));
        const initializePromise = this.doInit();
        this._onInitialized = observable_1.ObservableUtils.waitForState(this.isUpToDateObservable).then(() => initializePromise);
        initializePromise.then(() => {
            this.toDispose.push(observable_1.Autorun.create(() => {
                if (!this.isUpToDateObservable.get()) {
                    return;
                }
                observable_1.Observable.update(() => {
                    const mergeRangesData = this.mergeRangesDataObservable.get();
                    for (const [mergeRange, mergeRangeData] of mergeRangesData) {
                        const state = this.computeMergeRangeStateFromResult(mergeRange);
                        mergeRangeData.resultStateObservable.set(state);
                        if (this.shouldRecomputeHandledState) {
                            mergeRangeData.isHandledObservable.set(state !== 'Base');
                        }
                    }
                    this.shouldRecomputeHandledState = false;
                });
            }, {
                willHandleChange: ctx => {
                    if (ctx.isChangeOf(this.mergeRangesDataObservable)) {
                        this.shouldRecomputeHandledState = true;
                    }
                    return true;
                }
            }));
            const attachedHistory = new AttachedHistory(this.resultDocument);
            this.toDispose.push(attachedHistory);
            this.toDispose.push(this.resultDocument.textEditorModel.onDidChangeContent(event => {
                if (event.isRedoing || event.isUndoing) {
                    return;
                }
                // Mark merge ranges affected by content changes as handled.
                const mergeRanges = [];
                for (const change of event.changes) {
                    const changeBaseRange = this.translateResultRangeToBase(this.m2p.asRange(change.range));
                    const affectedMergeRanges = this.mergeRanges.filter(mergeRange => range_utils_1.RangeUtils.touches(mergeRange.baseRange.toRange(), changeBaseRange));
                    for (const mergeRange of affectedMergeRanges) {
                        if (!this.isMergeRangeHandled(mergeRange)) {
                            mergeRanges.push(mergeRange);
                        }
                    }
                }
                if (mergeRanges.length === 0) {
                    return;
                }
                const markMergeRangesAsHandled = (handled) => {
                    observable_1.Observable.update(() => {
                        const mergeRangesData = this.mergeRangesDataObservable.get();
                        for (const mergeRange of mergeRanges) {
                            const mergeRangeData = mergeRangesData.get(mergeRange);
                            if (mergeRangeData) {
                                mergeRangeData.isHandledObservable.set(handled);
                            }
                        }
                    });
                };
                const element = {
                    redo: () => {
                        markMergeRangesAsHandled(true);
                    },
                    undo: () => {
                        markMergeRangesAsHandled(false);
                    }
                };
                attachedHistory.pushAttachedHistoryElement(element);
                element.redo();
            }));
        });
    }
    computeMergeRangeStateFromResult(mergeRange) {
        const { originalRange: baseRange, modifiedRange: resultRange } = this.getResultLineRangeMapping(mergeRange);
        if (!mergeRange.baseRange.equals(baseRange)) {
            return 'Unrecognized';
        }
        const existingLines = resultRange.getLines(this.resultDocument);
        const states = [
            'Base',
            'Side1',
            'Side2',
            'Side1Side2Smart',
            'Side2Side1Smart',
            'Side1Side2',
            'Side2Side1'
        ];
        for (const state of states) {
            const edit = mergeRange.getBaseRangeEdit(state);
            if (core_1.ArrayUtils.equals(edit.newLines, existingLines)) {
                return state;
            }
        }
        return 'Unrecognized';
    }
    async doInit() {
        if (this.props.options?.resetResult) {
            await this.reset();
        }
    }
    dispose() {
        this.toDispose.dispose();
    }
    isDisposed() {
        return this.toDispose.disposed;
    }
    async reset() {
        await observable_1.ObservableUtils.waitForState(this.diffComputingStateForSidesObservable, state => state === 1 /* DiffComputingState.UpToDate */);
        this.shouldRecomputeHandledState = true;
        this.resultDocument.textEditorModel.setValue(this.computeAutoMergedResult());
    }
    computeAutoMergedResult() {
        const baseLines = this.baseDocument.textEditorModel.getLinesContent();
        const side1Lines = this.side1Document.textEditorModel.getLinesContent();
        const side2Lines = this.side2Document.textEditorModel.getLinesContent();
        const resultLines = [];
        function appendLinesToResult(documentLines, lineRange) {
            for (let i = lineRange.startLineNumber; i < lineRange.endLineNumberExclusive; i++) {
                resultLines.push(documentLines[i]);
            }
        }
        let baseStartLineNumber = 0;
        for (const mergeRange of this.mergeRanges) {
            appendLinesToResult(baseLines, line_range_1.LineRange.fromLineNumbers(baseStartLineNumber, mergeRange.baseRange.startLineNumber));
            if (mergeRange.side1Changes.length === 0) {
                appendLinesToResult(side2Lines, mergeRange.side2Range);
            }
            else if (mergeRange.side2Changes.length === 0) {
                appendLinesToResult(side1Lines, mergeRange.side1Range);
            }
            else if (mergeRange.isEqualChange) {
                appendLinesToResult(side1Lines, mergeRange.side1Range);
            }
            else {
                appendLinesToResult(baseLines, mergeRange.baseRange);
            }
            baseStartLineNumber = mergeRange.baseRange.endLineNumberExclusive;
        }
        appendLinesToResult(baseLines, line_range_1.LineRange.fromLineNumbers(baseStartLineNumber, baseLines.length));
        return resultLines.join(this.resultDocument.textEditorModel.getEOL());
    }
    computeMergeRanges() {
        return merge_range_1.MergeRange.computeMergeRanges(this.side1Changes, this.side2Changes, this.baseDocument, this.side1Document, this.side2Document);
    }
    hasMergeRange(mergeRange) {
        return this.mergeRangesDataObservable.get().has(mergeRange);
    }
    getMergeRangeData(mergeRange) {
        const mergeRangeData = this.mergeRangesDataObservable.get().get(mergeRange);
        if (!mergeRangeData) {
            throw new Error('Unknown merge range');
        }
        return mergeRangeData;
    }
    getMergeRangeResultState(mergeRange) {
        return this.getMergeRangeData(mergeRange).resultStateObservable.get();
    }
    applyMergeRangeAcceptedState(mergeRange, state) {
        if (!this.isUpToDateObservable.get()) {
            throw new Error('Cannot apply merge range accepted state while updating');
        }
        if (state !== 'Base' && this.getMergeRangeResultState(mergeRange) === 'Unrecognized') {
            throw new Error('Cannot apply merge range accepted state to an unrecognized result state');
        }
        const { originalRange: baseRange, modifiedRange: resultRange } = this.getResultLineRangeMapping(mergeRange);
        let newLines;
        if (state === 'Base') {
            newLines = baseRange.getLines(this.baseDocument);
        }
        else {
            if (!baseRange.equals(mergeRange.baseRange)) {
                throw new Error('Assertion error');
            }
            newLines = mergeRange.getBaseRangeEdit(state).newLines;
        }
        const resultEdit = new range_editing_1.LineRangeEdit(resultRange, newLines);
        const editOperation = resultEdit.toRangeEdit(this.resultDocument.lineCount).toMonacoEdit();
        const cursorState = this.resultEditor.getControl().getSelections();
        this.resultDocument.textEditorModel.pushStackElement();
        this.resultDocument.textEditorModel.pushEditOperations(cursorState, [editOperation], () => cursorState);
        this.resultDocument.textEditorModel.pushStackElement();
    }
    isMergeRangeHandled(mergeRange) {
        return this.getMergeRangeData(mergeRange).isHandledObservable.get();
    }
    markMergeRangeAsHandled(mergeRange, options) {
        const mergeRangeData = this.getMergeRangeData(mergeRange);
        if (mergeRangeData.isHandledObservable.get()) {
            return;
        }
        mergeRangeData.isHandledObservable.set(true);
        if (options?.undoRedo === false) {
            return;
        }
        const undoRedoCallback = options?.undoRedo?.callback;
        const modelRef = new WeakRef(this);
        const dataRef = new WeakRef(mergeRangeData);
        standaloneServices_1.StandaloneServices.get(undoRedo_1.IUndoRedoService).pushElement({
            type: 0 /* UndoRedoElementType.Resource */,
            resource: this.resultDocument.textEditorModel.uri,
            label: core_1.nls.localizeByDefault('Undo Mark As Handled'),
            code: 'markMergeRangeAsHandled',
            undo() {
                const model = modelRef.deref();
                const data = dataRef.deref();
                if (model && !model.isDisposed() && data) {
                    data.isHandledObservable.set(false);
                    undoRedoCallback?.didUndo();
                }
            },
            redo() {
                const model = modelRef.deref();
                const data = dataRef.deref();
                if (model && !model.isDisposed() && data) {
                    data.isHandledObservable.set(true);
                    undoRedoCallback?.didRedo();
                }
            }
        });
    }
    getLineRangeInResult(mergeRange) {
        return this.getResultLineRangeMapping(mergeRange).modifiedRange;
    }
    getResultLineRangeMapping(mergeRange) {
        const projectLine = (lineNumber) => {
            let offset = 0;
            const changes = this.resultChanges;
            for (const change of changes) {
                const { originalRange } = change;
                if (originalRange.containsLine(lineNumber) || originalRange.endLineNumberExclusive === lineNumber) {
                    return change;
                }
                else if (originalRange.endLineNumberExclusive < lineNumber) {
                    offset = change.modifiedRange.endLineNumberExclusive - originalRange.endLineNumberExclusive;
                }
                else {
                    break;
                }
            }
            return lineNumber + offset;
        };
        let startBase = mergeRange.baseRange.startLineNumber;
        let startResult = projectLine(startBase);
        if (typeof startResult !== 'number') {
            startBase = startResult.originalRange.startLineNumber;
            startResult = startResult.modifiedRange.startLineNumber;
        }
        let endExclusiveBase = mergeRange.baseRange.endLineNumberExclusive;
        let endExclusiveResult = projectLine(endExclusiveBase);
        if (typeof endExclusiveResult !== 'number') {
            endExclusiveBase = endExclusiveResult.originalRange.endLineNumberExclusive;
            endExclusiveResult = endExclusiveResult.modifiedRange.endLineNumberExclusive;
        }
        return new range_mapping_1.LineRangeMapping(line_range_1.LineRange.fromLineNumbers(startBase, endExclusiveBase), line_range_1.LineRange.fromLineNumbers(startResult, endExclusiveResult));
    }
    translateBaseRangeToSide(range, side) {
        const rangeMap = side === 1 ? this.baseToSide1RangeMap : this.baseToSide2RangeMap;
        return rangeMap.projectRange(range).modifiedRange;
    }
    translateSideRangeToBase(range, side) {
        const rangeMap = side === 1 ? this.side1ToBaseRangeMap : this.side2ToBaseRangeMap;
        return rangeMap.projectRange(range).modifiedRange;
    }
    translateBaseRangeToResult(range) {
        return this.baseToResultRangeMap.projectRange(range).modifiedRange;
    }
    translateResultRangeToBase(range) {
        return this.resultToBaseRangeMap.projectRange(range).modifiedRange;
    }
    computeSideToResultDiff(sideChanges, resultChanges) {
        return range_mapping_1.DocumentLineRangeMap.betweenModifiedSides(sideChanges, resultChanges).lineRangeMappings;
    }
    newMergeRangeData() {
        return new MergeRangeData();
    }
    newLiveDiff(originalDocument, modifiedDocument) {
        return new live_diff_1.LiveDiff(originalDocument, modifiedDocument, this.diffComputer);
    }
    newDocumentLineRangeMap(lineRangeMappings) {
        return new range_mapping_1.DocumentLineRangeMap(lineRangeMappings);
    }
    newDocumentRangeMap(rangeMappings) {
        return new range_mapping_1.DocumentRangeMap(rangeMappings);
    }
    getDiffComputingState(...liveDiffs) {
        const liveDiffStates = liveDiffs.map(liveDiff => liveDiff.state);
        if (liveDiffStates.some(state => state === 0 /* LiveDiffState.Initializing */)) {
            return 0 /* DiffComputingState.Initializing */;
        }
        if (liveDiffStates.some(state => state === 2 /* LiveDiffState.Updating */)) {
            return 2 /* DiffComputingState.Updating */;
        }
        return 1 /* DiffComputingState.UpToDate */;
    }
};
exports.MergeEditorModel = MergeEditorModel;
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.MergeEditorModelProps),
    tslib_1.__metadata("design:type", Object)
], MergeEditorModel.prototype, "props", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(diff_1.DiffComputer),
    tslib_1.__metadata("design:type", Object)
], MergeEditorModel.prototype, "diffComputer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(monaco_to_protocol_converter_1.MonacoToProtocolConverter),
    tslib_1.__metadata("design:type", monaco_to_protocol_converter_1.MonacoToProtocolConverter)
], MergeEditorModel.prototype, "m2p", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MergeEditorModel.prototype, "init", null);
exports.MergeEditorModel = MergeEditorModel = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MergeEditorModel);
class MergeRangeData {
    constructor() {
        this.resultStateObservable = observable_1.SettableObservable.create('Base');
        this.isHandledObservable = observable_1.SettableObservable.create(false);
    }
}
exports.MergeRangeData = MergeRangeData;
class AttachedHistory {
    constructor(model) {
        this.model = model;
        this.toDispose = new core_1.DisposableCollection();
        this.attachedHistory = [];
        let previousAltId = this.model.textEditorModel.getAlternativeVersionId();
        this.toDispose.push(model.textEditorModel.onDidChangeContent(event => {
            const currentAltId = model.textEditorModel.getAlternativeVersionId();
            if (event.isRedoing) {
                for (const item of this.attachedHistory) {
                    if (previousAltId < item.altId && item.altId <= currentAltId) {
                        item.element.redo();
                    }
                }
            }
            else if (event.isUndoing) {
                for (let i = this.attachedHistory.length - 1; i >= 0; i--) {
                    const item = this.attachedHistory[i];
                    if (currentAltId < item.altId && item.altId <= previousAltId) {
                        item.element.undo();
                    }
                }
            }
            else {
                // The user destroyed the redo stack by performing a non redo/undo operation.
                while (this.attachedHistory.length > 0
                    && this.attachedHistory[this.attachedHistory.length - 1].altId > previousAltId) {
                    this.attachedHistory.pop();
                }
            }
            previousAltId = currentAltId;
        }));
    }
    dispose() {
        this.toDispose.dispose();
    }
    pushAttachedHistoryElement(element) {
        this.attachedHistory.push({ altId: this.model.textEditorModel.getAlternativeVersionId(), element });
    }
}
//# sourceMappingURL=merge-editor-model.js.map