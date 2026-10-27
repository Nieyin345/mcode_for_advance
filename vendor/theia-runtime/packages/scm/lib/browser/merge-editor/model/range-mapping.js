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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/model/mapping.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentRangeMap = exports.RangeMapping = exports.DetailedLineRangeMapping = exports.MappingAlignment = exports.DocumentLineRangeMap = exports.LineRangeMapping = void 0;
const core_1 = require("@theia/core");
const editor_1 = require("@theia/editor/lib/browser/editor");
const line_range_1 = require("./line-range");
const range_editing_1 = require("./range-editing");
const range_utils_1 = require("./range-utils");
/**
 * Maps a line range in the original text document to a line range in the modified text document.
 */
class LineRangeMapping {
    static join(mappings) {
        return mappings.reduce((acc, cur) => acc ? acc.join(cur) : cur, undefined);
    }
    constructor(originalRange, modifiedRange) {
        this.originalRange = originalRange;
        this.modifiedRange = modifiedRange;
    }
    toString() {
        return `${this.originalRange.toString()} -> ${this.modifiedRange.toString()}`;
    }
    join(other) {
        return new LineRangeMapping(this.originalRange.join(other.originalRange), this.modifiedRange.join(other.modifiedRange));
    }
    addModifiedLineDelta(delta) {
        return new LineRangeMapping(this.originalRange, this.modifiedRange.delta(delta));
    }
    addOriginalLineDelta(delta) {
        return new LineRangeMapping(this.originalRange.delta(delta), this.modifiedRange);
    }
    reverse() {
        return new LineRangeMapping(this.modifiedRange, this.originalRange);
    }
}
exports.LineRangeMapping = LineRangeMapping;
/**
 * Represents a total monotonous mapping of line ranges in one document to another document.
 */
class DocumentLineRangeMap {
    static betweenModifiedSides(side1Diff, side2Diff) {
        const alignments = MappingAlignment.computeAlignments(side1Diff, side2Diff);
        const mappings = alignments.map(alignment => new LineRangeMapping(alignment.side1Range, alignment.side2Range));
        return new DocumentLineRangeMap(mappings);
    }
    constructor(
    /**
     * The line range mappings that define this document mapping.
     * The number of lines between two adjacent original ranges must equal the number of lines between their corresponding modified ranges.
     */
    lineRangeMappings) {
        this.lineRangeMappings = lineRangeMappings;
        if (!core_1.ArrayUtils.checkAdjacentItems(lineRangeMappings, (m1, m2) => m1.originalRange.isBefore(m2.originalRange) && m1.modifiedRange.isBefore(m2.modifiedRange) &&
            m2.originalRange.startLineNumber - m1.originalRange.endLineNumberExclusive === m2.modifiedRange.startLineNumber - m1.modifiedRange.endLineNumberExclusive)) {
            throw new Error('Illegal line range mappings');
        }
    }
    /**
     * @param lineNumber 0-based line number in the original text document
     * @return the corresponding line number in the modified text document if the line is unchanged,
     *  or the line range mapping for the affecting change otherwise
     */
    projectLine(lineNumber) {
        const lastBefore = core_1.ArrayUtils.findLast(this.lineRangeMappings, m => m.originalRange.startLineNumber <= lineNumber);
        if (!lastBefore) {
            return lineNumber;
        }
        if (lastBefore.originalRange.containsLine(lineNumber)) {
            return lastBefore;
        }
        return lineNumber + lastBefore.modifiedRange.endLineNumberExclusive - lastBefore.originalRange.endLineNumberExclusive;
    }
    reverse() {
        return new DocumentLineRangeMap(this.lineRangeMappings.map(m => m.reverse()));
    }
}
exports.DocumentLineRangeMap = DocumentLineRangeMap;
/**
 * Aligns mappings for two modified sides with a common base range.
 */
class MappingAlignment {
    static computeAlignments(side1Mappings, side2Mappings) {
        const combinedMappings = side1Mappings.map(mapping => ({ source: 0, mapping })).concat(side2Mappings.map(mapping => ({ source: 1, mapping }))).sort((a, b) => line_range_1.LineRange.compareByStart(a.mapping.originalRange, b.mapping.originalRange));
        const currentMappings = [new Array(), new Array()];
        const currentDelta = [0, 0];
        const alignments = new Array();
        function pushAlignment(baseRange) {
            const mapping1 = LineRangeMapping.join(currentMappings[0]) || new LineRangeMapping(baseRange, baseRange.delta(currentDelta[0]));
            const mapping2 = LineRangeMapping.join(currentMappings[1]) || new LineRangeMapping(baseRange, baseRange.delta(currentDelta[1]));
            function getAlignedModifiedRange(m) {
                const startDelta = baseRange.startLineNumber - m.originalRange.startLineNumber;
                const endDelta = baseRange.endLineNumberExclusive - m.originalRange.endLineNumberExclusive;
                return new line_range_1.LineRange(m.modifiedRange.startLineNumber + startDelta, m.modifiedRange.lineCount - startDelta + endDelta);
            }
            alignments.push(new MappingAlignment(baseRange, getAlignedModifiedRange(mapping1), currentMappings[0], getAlignedModifiedRange(mapping2), currentMappings[1]));
            currentMappings[0] = [];
            currentMappings[1] = [];
        }
        let currentBaseRange;
        for (const current of combinedMappings) {
            const { originalRange, modifiedRange } = current.mapping;
            if (currentBaseRange && !currentBaseRange.touches(originalRange)) {
                pushAlignment(currentBaseRange);
                currentBaseRange = undefined;
            }
            currentBaseRange = currentBaseRange ? currentBaseRange.join(originalRange) : originalRange;
            currentMappings[current.source].push(current.mapping);
            currentDelta[current.source] = modifiedRange.endLineNumberExclusive - originalRange.endLineNumberExclusive;
        }
        if (currentBaseRange) {
            pushAlignment(currentBaseRange);
        }
        return alignments;
    }
    constructor(baseRange, side1Range, side1Mappings, side2Range, side2Mappings) {
        this.baseRange = baseRange;
        this.side1Range = side1Range;
        this.side1Mappings = side1Mappings;
        this.side2Range = side2Range;
        this.side2Mappings = side2Mappings;
    }
    toString() {
        return `${this.side1Range} <- ${this.baseRange} -> ${this.side2Range}`;
    }
}
exports.MappingAlignment = MappingAlignment;
/**
 * A line range mapping with inner range mappings.
 */
class DetailedLineRangeMapping extends LineRangeMapping {
    static join(mappings) {
        return mappings.reduce((acc, cur) => acc ? acc.join(cur) : cur, undefined);
    }
    constructor(originalRange, originalDocument, modifiedRange, modifiedDocument, rangeMappings) {
        super(originalRange, modifiedRange);
        this.originalDocument = originalDocument;
        this.modifiedDocument = modifiedDocument;
        this.rangeMappings = rangeMappings || [new RangeMapping(originalRange.toRange(), modifiedRange.toRange())];
    }
    join(other) {
        return new DetailedLineRangeMapping(this.originalRange.join(other.originalRange), this.originalDocument, this.modifiedRange.join(other.modifiedRange), this.modifiedDocument);
    }
    addModifiedLineDelta(delta) {
        return new DetailedLineRangeMapping(this.originalRange, this.originalDocument, this.modifiedRange.delta(delta), this.modifiedDocument, this.rangeMappings.map(m => m.addModifiedLineDelta(delta)));
    }
    addOriginalLineDelta(delta) {
        return new DetailedLineRangeMapping(this.originalRange.delta(delta), this.originalDocument, this.modifiedRange, this.modifiedDocument, this.rangeMappings.map(m => m.addOriginalLineDelta(delta)));
    }
    reverse() {
        return new DetailedLineRangeMapping(this.modifiedRange, this.modifiedDocument, this.originalRange, this.originalDocument, this.rangeMappings.map(m => m.reverse()));
    }
    getLineEdit() {
        return new range_editing_1.LineRangeEdit(this.originalRange, this.getModifiedLines());
    }
    getReverseLineEdit() {
        return new range_editing_1.LineRangeEdit(this.modifiedRange, this.getOriginalLines());
    }
    getModifiedLines() {
        return this.modifiedRange.getLines(this.modifiedDocument);
    }
    getOriginalLines() {
        return this.originalRange.getLines(this.originalDocument);
    }
}
exports.DetailedLineRangeMapping = DetailedLineRangeMapping;
/**
 * Maps a range in the original text document to a range in the modified text document.
 */
class RangeMapping {
    constructor(originalRange, modifiedRange) {
        this.originalRange = originalRange;
        this.modifiedRange = modifiedRange;
    }
    toString() {
        function rangeToString(range) {
            return `[${range.start.line}:${range.start.character}, ${range.end.line}:${range.end.character})`;
        }
        return `${rangeToString(this.originalRange)} -> ${rangeToString(this.modifiedRange)}`;
    }
    addModifiedLineDelta(deltaLines) {
        return new RangeMapping(this.originalRange, editor_1.Range.create(this.modifiedRange.start.line + deltaLines, this.modifiedRange.start.character, this.modifiedRange.end.line + deltaLines, this.modifiedRange.end.character));
    }
    addOriginalLineDelta(deltaLines) {
        return new RangeMapping(editor_1.Range.create(this.originalRange.start.line + deltaLines, this.originalRange.start.character, this.originalRange.end.line + deltaLines, this.originalRange.end.character), this.modifiedRange);
    }
    reverse() {
        return new RangeMapping(this.modifiedRange, this.originalRange);
    }
}
exports.RangeMapping = RangeMapping;
/**
 * Represents a total monotonous mapping of ranges in one document to another document.
 */
class DocumentRangeMap {
    constructor(
    /**
     * The range mappings that define this document mapping.
     */
    rangeMappings) {
        this.rangeMappings = rangeMappings;
        if (!core_1.ArrayUtils.checkAdjacentItems(rangeMappings, (m1, m2) => range_utils_1.RangeUtils.isBefore(m1.originalRange, m2.originalRange) &&
            range_utils_1.RangeUtils.isBefore(m1.modifiedRange, m2.modifiedRange))) {
            throw new Error('Illegal range mappings');
        }
    }
    /**
     * @param position position in the original text document
     */
    projectPosition(position) {
        const lastBefore = core_1.ArrayUtils.findLast(this.rangeMappings, m => range_utils_1.PositionUtils.isBeforeOrEqual(m.originalRange.start, position));
        if (!lastBefore) {
            return new RangeMapping(editor_1.Range.create(position, position), editor_1.Range.create(position, position));
        }
        if (range_utils_1.RangeUtils.containsPosition(lastBefore.originalRange, position)) {
            return lastBefore;
        }
        const relativePosition = range_utils_1.PositionUtils.relativize(lastBefore.originalRange.end, position);
        const modifiedRangePosition = range_utils_1.PositionUtils.resolve(lastBefore.modifiedRange.end, relativePosition);
        return new RangeMapping(editor_1.Range.create(position, position), editor_1.Range.create(modifiedRangePosition, modifiedRangePosition));
    }
    /**
     * @param range range in the original text document
     */
    projectRange(range) {
        const start = this.projectPosition(range.start);
        const end = this.projectPosition(range.end);
        return new RangeMapping(range_utils_1.RangeUtils.union(start.originalRange, end.originalRange), range_utils_1.RangeUtils.union(start.modifiedRange, end.modifiedRange));
    }
    reverse() {
        return new DocumentRangeMap(this.rangeMappings.map(m => m.reverse()));
    }
}
exports.DocumentRangeMap = DocumentRangeMap;
//# sourceMappingURL=range-mapping.js.map