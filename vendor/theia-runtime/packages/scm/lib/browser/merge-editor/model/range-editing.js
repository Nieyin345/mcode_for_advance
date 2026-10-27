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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/model/editing.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.RangeEdit = exports.LineRangeEdit = void 0;
const core_1 = require("@theia/core");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
/**
 * Represents an edit, expressed in whole lines:
 * At (before) {@link LineRange.startLineNumber}, delete {@link LineRange.lineCount} many lines and insert {@link newLines}.
 */
class LineRangeEdit {
    constructor(range, newLines) {
        this.range = range;
        this.newLines = newLines;
    }
    equals(other) {
        return this.range.equals(other.range) && core_1.ArrayUtils.equals(this.newLines, other.newLines);
    }
    toRangeEdit(documentLineCount) {
        if (this.range.endLineNumberExclusive < documentLineCount) {
            return new RangeEdit(vscode_languageserver_protocol_1.Range.create(this.range.startLineNumber, 0, this.range.endLineNumberExclusive, 0), this.newLines.map(s => s + '\n').join(''));
        }
        if (this.range.startLineNumber === 0) {
            return new RangeEdit(vscode_languageserver_protocol_1.Range.create(0, 0, documentLineCount - 1, vscode_languageserver_protocol_1.uinteger.MAX_VALUE), this.newLines.join('\n'));
        }
        return new RangeEdit(vscode_languageserver_protocol_1.Range.create(this.range.startLineNumber - 1, vscode_languageserver_protocol_1.uinteger.MAX_VALUE, documentLineCount - 1, vscode_languageserver_protocol_1.uinteger.MAX_VALUE), this.newLines.map(s => '\n' + s).join(''));
    }
}
exports.LineRangeEdit = LineRangeEdit;
class RangeEdit {
    constructor(range, newText) {
        this.range = range;
        this.newText = newText;
    }
    toMonacoEdit() {
        const { start, end } = this.range;
        return {
            range: {
                startLineNumber: start.line + 1,
                startColumn: start.character + 1,
                endLineNumber: end.line + 1,
                endColumn: end.character + 1
            },
            text: this.newText
        };
    }
}
exports.RangeEdit = RangeEdit;
//# sourceMappingURL=range-editing.js.map