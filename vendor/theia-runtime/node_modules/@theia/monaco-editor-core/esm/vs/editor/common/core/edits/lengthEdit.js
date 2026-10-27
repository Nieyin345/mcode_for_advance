/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { OffsetRange } from '../ranges/offsetRange.js';
import { BaseEdit, BaseReplacement } from './edit.js';
/**
 * Like a normal edit, but only captures the length information.
*/
export class LengthEdit extends BaseEdit {
    static { this.empty = new LengthEdit([]); }
    static fromEdit(edit) {
        return new LengthEdit(edit.replacements.map(r => new LengthReplacement(r.replaceRange, r.getNewLength())));
    }
    static create(replacements) {
        return new LengthEdit(replacements);
    }
    static single(replacement) {
        return new LengthEdit([replacement]);
    }
    static replace(range, newLength) {
        return new LengthEdit([new LengthReplacement(range, newLength)]);
    }
    static insert(offset, newLength) {
        return new LengthEdit([new LengthReplacement(OffsetRange.emptyAt(offset), newLength)]);
    }
    static delete(range) {
        return new LengthEdit([new LengthReplacement(range, 0)]);
    }
    static compose(edits) {
        let e = LengthEdit.empty;
        for (const edit of edits) {
            e = e.compose(edit);
        }
        return e;
    }
    /**
     * Creates an edit that reverts this edit.
     */
    inverse() {
        const edits = [];
        let offset = 0;
        for (const e of this.replacements) {
            edits.push(new LengthReplacement(OffsetRange.ofStartAndLength(e.replaceRange.start + offset, e.newLength), e.replaceRange.length));
            offset += e.newLength - e.replaceRange.length;
        }
        return new LengthEdit(edits);
    }
    _createNew(replacements) {
        return new LengthEdit(replacements);
    }
    applyArray(arr, fillItem) {
        const newArr = new Array(this.getNewDataLength(arr.length));
        let srcPos = 0;
        let dstPos = 0;
        for (const replacement of this.replacements) {
            // Copy items before the current replacement
            for (let i = srcPos; i < replacement.replaceRange.start; i++) {
                newArr[dstPos++] = arr[i];
            }
            // Skip the replaced items in the source array
            srcPos = replacement.replaceRange.endExclusive;
            // Fill with the provided fillItem for insertions
            for (let i = 0; i < replacement.newLength; i++) {
                newArr[dstPos++] = fillItem;
            }
        }
        // Copy any remaining items from the original array
        while (srcPos < arr.length) {
            newArr[dstPos++] = arr[srcPos++];
        }
        return newArr;
    }
}
export class LengthReplacement extends BaseReplacement {
    static create(startOffset, endOffsetExclusive, newLength) {
        return new LengthReplacement(new OffsetRange(startOffset, endOffsetExclusive), newLength);
    }
    constructor(range, newLength) {
        super(range);
        this.newLength = newLength;
    }
    equals(other) {
        return this.replaceRange.equals(other.replaceRange) && this.newLength === other.newLength;
    }
    getNewLength() { return this.newLength; }
    tryJoinTouching(other) {
        return new LengthReplacement(this.replaceRange.joinRightTouching(other.replaceRange), this.newLength + other.newLength);
    }
    slice(range, rangeInReplacement) {
        return new LengthReplacement(range, rangeInReplacement.length);
    }
    toString() {
        return `[${this.replaceRange.start}, +${this.replaceRange.length}) -> +${this.newLength}}`;
    }
}
//# sourceMappingURL=lengthEdit.js.map