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
// copied and modified from https://github.com/microsoft/vscode/blob/1.96.3/src/vs/workbench/contrib/mergeEditor/browser/model/rangeUtils.ts,
// https://github.com/microsoft/vscode/blob/1.96.3/src/vs/editor/common/core/range.ts,
// https://github.com/microsoft/vscode/blob/1.96.3/src/vs/editor/common/core/position.ts,
// https://github.com/microsoft/vscode/blob/1.96.3/src/vs/editor/common/core/textLength.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionUtils = exports.RangeUtils = void 0;
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
var RangeUtils;
(function (RangeUtils) {
    function isEmpty(range) {
        return range.start.line === range.end.line && range.start.character === range.end.character;
    }
    RangeUtils.isEmpty = isEmpty;
    function containsPosition(range, position) {
        if (position.line < range.start.line || position.line > range.end.line) {
            return false;
        }
        if (position.line === range.start.line && position.character < range.start.character) {
            return false;
        }
        if (position.line === range.end.line && position.character >= range.end.character) {
            return false;
        }
        return true;
    }
    RangeUtils.containsPosition = containsPosition;
    /**
     * Returns `false` iff there is at least one character between `range` and `other`.
     */
    function touches(range, other) {
        return PositionUtils.isBeforeOrEqual(range.start, other.end) && PositionUtils.isBeforeOrEqual(other.start, range.end);
    }
    RangeUtils.touches = touches;
    function isBefore(range, other) {
        return (range.end.line < other.start.line ||
            (range.end.line === other.start.line &&
                range.end.character <= other.start.character));
    }
    RangeUtils.isBefore = isBefore;
    function union(range, other) {
        const start = PositionUtils.isBeforeOrEqual(range.start, other.start) ? range.start : other.start;
        const end = PositionUtils.isBeforeOrEqual(range.end, other.end) ? other.end : range.end;
        return { start, end };
    }
    RangeUtils.union = union;
    /**
     * A function that compares ranges, useful for sorting ranges.
     * It will first compare ranges on the start position and then on the end position.
     */
    function compareUsingStarts(range, other) {
        if (range.start.line === other.start.line) {
            if (range.start.character === other.start.character) {
                if (range.end.line === other.end.line) {
                    return range.end.character - other.end.character;
                }
                return range.end.line - other.end.line;
            }
            return range.start.character - other.start.character;
        }
        return range.start.line - other.start.line;
    }
    RangeUtils.compareUsingStarts = compareUsingStarts;
})(RangeUtils || (exports.RangeUtils = RangeUtils = {}));
var PositionUtils;
(function (PositionUtils) {
    function isBeforeOrEqual(position, other) {
        return compare(position, other) <= 0;
    }
    PositionUtils.isBeforeOrEqual = isBeforeOrEqual;
    function compare(position, other) {
        if (position.line === other.line) {
            return position.character - other.character;
        }
        return position.line - other.line;
    }
    PositionUtils.compare = compare;
    /**
     * Given two positions, computes the relative position of the greater position against the lesser position.
     */
    function relativize(position, other) {
        if (compare(position, other) > 0) {
            [position, other] = [other, position];
        }
        if (position.line === other.line) {
            return vscode_languageserver_protocol_1.Position.create(0, other.character - position.character);
        }
        else {
            return vscode_languageserver_protocol_1.Position.create(other.line - position.line, other.character);
        }
    }
    PositionUtils.relativize = relativize;
    /**
     * Resolves the given relative position against the given position and returns the resulting position.
     */
    function resolve(position, relativePosition) {
        if (relativePosition.line === 0) {
            return vscode_languageserver_protocol_1.Position.create(position.line, position.character + relativePosition.character);
        }
        else {
            return vscode_languageserver_protocol_1.Position.create(position.line + relativePosition.line, relativePosition.character);
        }
    }
    PositionUtils.resolve = resolve;
})(PositionUtils || (exports.PositionUtils = PositionUtils = {}));
//# sourceMappingURL=range-utils.js.map