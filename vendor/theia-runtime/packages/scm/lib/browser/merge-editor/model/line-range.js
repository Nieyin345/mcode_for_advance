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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/model/lineRange.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.LineRange = void 0;
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
/**
 * Represents a range of whole lines of text. Line numbers are zero-based.
 */
class LineRange {
    static compareByStart(a, b) {
        return a.startLineNumber - b.startLineNumber;
    }
    static fromLineNumbers(startLineNumber, endExclusiveLineNumber) {
        return new LineRange(startLineNumber, endExclusiveLineNumber - startLineNumber);
    }
    constructor(
    /** A zero-based number of the start line. The range starts exactly at the beginning of this line. */
    startLineNumber, lineCount) {
        this.startLineNumber = startLineNumber;
        this.lineCount = lineCount;
        if (startLineNumber < 0 || lineCount < 0) {
            throw new Error('Invalid line range: ' + this.toString());
        }
    }
    join(other) {
        return LineRange.fromLineNumbers(Math.min(this.startLineNumber, other.startLineNumber), Math.max(this.endLineNumberExclusive, other.endLineNumberExclusive));
    }
    /** A zero-based number of the end line. The range ends just before the beginning of this line. */
    get endLineNumberExclusive() {
        return this.startLineNumber + this.lineCount;
    }
    get isEmpty() {
        return this.lineCount === 0;
    }
    /**
     * Returns `false` iff there is at least one line between `this` and `other`.
     */
    touches(other) {
        return this.startLineNumber <= other.endLineNumberExclusive && other.startLineNumber <= this.endLineNumberExclusive;
    }
    isAfter(other) {
        return this.startLineNumber >= other.endLineNumberExclusive;
    }
    isBefore(other) {
        return other.startLineNumber >= this.endLineNumberExclusive;
    }
    delta(lineDelta) {
        return new LineRange(this.startLineNumber + lineDelta, this.lineCount);
    }
    deltaStart(lineDelta) {
        return new LineRange(this.startLineNumber + lineDelta, this.lineCount - lineDelta);
    }
    deltaEnd(lineDelta) {
        return new LineRange(this.startLineNumber, this.lineCount + lineDelta);
    }
    toString() {
        return `[${this.startLineNumber},${this.endLineNumberExclusive})`;
    }
    equals(other) {
        return this.startLineNumber === other.startLineNumber && this.lineCount === other.lineCount;
    }
    contains(other) {
        return this.startLineNumber <= other.startLineNumber && other.endLineNumberExclusive <= this.endLineNumberExclusive;
    }
    containsLine(lineNumber) {
        return this.startLineNumber <= lineNumber && lineNumber < this.endLineNumberExclusive;
    }
    getLines(document) {
        const result = new Array(this.lineCount);
        for (let i = 0; i < this.lineCount; i++) {
            result[i] = document.getLineContent(this.startLineNumber + i + 1); // note that getLineContent expects a one-based line number
        }
        return result;
    }
    toRange() {
        return vscode_languageserver_protocol_1.Range.create(this.startLineNumber, 0, this.endLineNumberExclusive, 0);
    }
    toInclusiveRange() {
        if (this.isEmpty) {
            return undefined;
        }
        return vscode_languageserver_protocol_1.Range.create(this.startLineNumber, 0, this.endLineNumberExclusive - 1, vscode_languageserver_protocol_1.uinteger.MAX_VALUE);
    }
    toInclusiveRangeOrEmpty() {
        if (this.isEmpty) {
            return vscode_languageserver_protocol_1.Range.create(this.startLineNumber, 0, this.startLineNumber, 0);
        }
        return vscode_languageserver_protocol_1.Range.create(this.startLineNumber, 0, this.endLineNumberExclusive - 1, vscode_languageserver_protocol_1.uinteger.MAX_VALUE);
    }
}
exports.LineRange = LineRange;
//# sourceMappingURL=line-range.js.map