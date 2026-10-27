/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ColumnRange } from './columnRange.js';
import { Range } from '../range.js';
/**
 * Represents a column range in a single line.
*/
export class RangeSingleLine {
    static fromRange(range) {
        if (range.endLineNumber !== range.startLineNumber) {
            return undefined;
        }
        return new RangeSingleLine(range.startLineNumber, new ColumnRange(range.startColumn, range.endColumn));
    }
    constructor(
    /** 1-based */
    lineNumber, columnRange) {
        this.lineNumber = lineNumber;
        this.columnRange = columnRange;
    }
    toRange() {
        return new Range(this.lineNumber, this.columnRange.startColumn, this.lineNumber, this.columnRange.endColumnExclusive);
    }
}
//# sourceMappingURL=rangeSingleLine.js.map