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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/model/modifiedBaseRange.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.MergeRangeAcceptedState = exports.MergeRange = void 0;
const core_1 = require("@theia/core");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
const range_mapping_1 = require("./range-mapping");
const range_editing_1 = require("./range-editing");
const range_utils_1 = require("./range-utils");
/**
 * Describes modifications in side 1 and side 2 for a specific range in base.
 */
class MergeRange {
    static computeMergeRanges(side1Diff, side2Diff, baseDocument, side1Document, side2Document) {
        const alignments = range_mapping_1.MappingAlignment.computeAlignments(side1Diff, side2Diff);
        return alignments.map(alignment => new MergeRange(alignment.baseRange, baseDocument, alignment.side1Range, alignment.side1Mappings, side1Document, alignment.side2Range, alignment.side2Mappings, side2Document));
    }
    constructor(baseRange, baseDocument, side1Range, side1Changes, side1Document, side2Range, side2Changes, side2Document) {
        this.baseRange = baseRange;
        this.baseDocument = baseDocument;
        this.side1Range = side1Range;
        this.side1Changes = side1Changes;
        this.side1Document = side1Document;
        this.side2Range = side2Range;
        this.side2Changes = side2Changes;
        this.side2Document = side2Document;
        this.side1CombinedChange = range_mapping_1.DetailedLineRangeMapping.join(this.side1Changes);
        this.side2CombinedChange = range_mapping_1.DetailedLineRangeMapping.join(this.side2Changes);
        this.isEqualChange = core_1.ArrayUtils.equals(this.side1Changes, this.side2Changes, (a, b) => a.getLineEdit().equals(b.getLineEdit()));
        if (side1Changes.length === 0 && side2Changes.length === 0) {
            throw new Error('At least one change is expected');
        }
    }
    getModifiedRange(side) {
        return side === 1 ? this.side1Range : this.side2Range;
    }
    getCombinedChange(side) {
        return side === 1 ? this.side1CombinedChange : this.side2CombinedChange;
    }
    getChanges(side) {
        return side === 1 ? this.side1Changes : this.side2Changes;
    }
    get isConflicting() {
        return this.side1Changes.length > 0 && this.side2Changes.length > 0 && !this.isEqualChange;
    }
    canBeSmartCombined(firstSide) {
        return this.isConflicting && this.smartCombineChanges(firstSide) !== undefined;
    }
    get isSmartCombinationOrderRelevant() {
        const edit1 = this.smartCombineChanges(1);
        const edit2 = this.smartCombineChanges(2);
        if (!edit1 || !edit2) {
            return false;
        }
        return !edit1.equals(edit2);
    }
    getBaseRangeEdit(state) {
        if (state === 'Base') {
            return new range_editing_1.LineRangeEdit(this.baseRange, this.baseRange.getLines(this.baseDocument));
        }
        if (state === 'Side1') {
            return new range_editing_1.LineRangeEdit(this.baseRange, this.side1Range.getLines(this.side1Document));
        }
        if (state === 'Side2') {
            return new range_editing_1.LineRangeEdit(this.baseRange, this.side2Range.getLines(this.side2Document));
        }
        let edit;
        const firstSide = state.startsWith('Side1') ? 1 : 2;
        if (state.endsWith('Smart')) {
            edit = this.smartCombineChanges(firstSide);
        }
        if (!edit) {
            edit = this.dumbCombineChanges(firstSide);
        }
        return edit;
    }
    smartCombineChanges(firstSide) {
        if (firstSide === 1 && this.smartCombinationEdit1) {
            return this.smartCombinationEdit1.value;
        }
        else if (firstSide === 2 && this.smartCombinationEdit2) {
            return this.smartCombinationEdit2.value;
        }
        const combinedChanges = this.side1Changes.flatMap(change => change.rangeMappings.map(rangeMapping => ({ rangeMapping, side: 1 }))).concat(this.side2Changes.flatMap(change => change.rangeMappings.map(rangeMapping => ({ rangeMapping, side: 2 })))).sort((a, b) => {
            let result = range_utils_1.RangeUtils.compareUsingStarts(a.rangeMapping.originalRange, b.rangeMapping.originalRange);
            if (result === 0) {
                const sideWeight = (side) => side === firstSide ? 1 : 2;
                result = sideWeight(a.side) - sideWeight(b.side);
            }
            return result;
        });
        const sortedEdits = combinedChanges.map(change => {
            const modifiedDocument = change.side === 1 ? this.side1Document : this.side2Document;
            return new range_editing_1.RangeEdit(change.rangeMapping.originalRange, modifiedDocument.getText(change.rangeMapping.modifiedRange));
        });
        const edit = this.editsToLineRangeEdit(this.baseRange, sortedEdits, this.baseDocument);
        if (firstSide === 1) {
            this.smartCombinationEdit1 = { value: edit };
        }
        else {
            this.smartCombinationEdit2 = { value: edit };
        }
        return edit;
    }
    editsToLineRangeEdit(range, sortedEdits, document) {
        let text = '';
        const startsLineBefore = range.startLineNumber > 0;
        let currentPosition = startsLineBefore
            ? vscode_languageserver_protocol_1.Position.create(range.startLineNumber - 1, document.getLineMaxColumn((range.startLineNumber - 1) + 1) // note that getLineMaxColumn expects a 1-based line number
            )
            : vscode_languageserver_protocol_1.Position.create(range.startLineNumber, 0);
        for (const edit of sortedEdits) {
            const diffStart = edit.range.start;
            if (!range_utils_1.PositionUtils.isBeforeOrEqual(currentPosition, diffStart)) {
                return undefined;
            }
            let originalText = document.getText(vscode_languageserver_protocol_1.Range.create(currentPosition, diffStart));
            if (diffStart.line >= document.lineCount) {
                // getText doesn't include this virtual line break, as the document ends the line before.
                // endsLineAfter will be false.
                originalText += '\n';
            }
            text += originalText;
            text += edit.newText;
            currentPosition = edit.range.end;
        }
        const endsLineAfter = range.endLineNumberExclusive < document.lineCount;
        const end = endsLineAfter ?
            vscode_languageserver_protocol_1.Position.create(range.endLineNumberExclusive, 0) :
            vscode_languageserver_protocol_1.Position.create(range.endLineNumberExclusive - 1, vscode_languageserver_protocol_1.uinteger.MAX_VALUE);
        text += document.getText(vscode_languageserver_protocol_1.Range.create(currentPosition, end));
        const lines = text.split(/\r\n|\r|\n/);
        if (startsLineBefore) {
            if (lines[0] !== '') {
                return undefined;
            }
            lines.shift();
        }
        if (endsLineAfter) {
            if (lines[lines.length - 1] !== '') {
                return undefined;
            }
            lines.pop();
        }
        return new range_editing_1.LineRangeEdit(range, lines);
    }
    dumbCombineChanges(firstSide) {
        if (firstSide === 1 && this.dumbCombinationEdit1) {
            return this.dumbCombinationEdit1;
        }
        else if (firstSide === 2 && this.dumbCombinationEdit2) {
            return this.dumbCombinationEdit2;
        }
        const modifiedLines1 = this.side1Range.getLines(this.side1Document);
        const modifiedLines2 = this.side2Range.getLines(this.side2Document);
        const combinedLines = firstSide === 1 ? modifiedLines1.concat(modifiedLines2) : modifiedLines2.concat(modifiedLines1);
        const edit = new range_editing_1.LineRangeEdit(this.baseRange, combinedLines);
        if (firstSide === 1) {
            this.dumbCombinationEdit1 = edit;
        }
        else {
            this.dumbCombinationEdit2 = edit;
        }
        return edit;
    }
}
exports.MergeRange = MergeRange;
var MergeRangeAcceptedState;
(function (MergeRangeAcceptedState) {
    function addSide(state, side, options) {
        if (state === 'Base') {
            return side === 1 ? 'Side1' : 'Side2';
        }
        if (state.includes('Side' + side)) {
            return state;
        }
        if (side === 2) {
            return options?.smartCombination ? 'Side1Side2Smart' : 'Side1Side2';
        }
        else {
            return options?.smartCombination ? 'Side2Side1Smart' : 'Side2Side1';
        }
    }
    MergeRangeAcceptedState.addSide = addSide;
    function removeSide(state, side) {
        if (!state.includes('Side' + side)) {
            return state;
        }
        if (state === 'Side' + side) {
            return 'Base';
        }
        return side === 1 ? 'Side2' : 'Side1';
    }
    MergeRangeAcceptedState.removeSide = removeSide;
})(MergeRangeAcceptedState || (exports.MergeRangeAcceptedState = MergeRangeAcceptedState = {}));
//# sourceMappingURL=merge-range.js.map