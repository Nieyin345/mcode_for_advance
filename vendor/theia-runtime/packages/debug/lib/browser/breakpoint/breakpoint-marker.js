"use strict";
// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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
exports.DataBreakpoint = exports.InstructionBreakpoint = exports.FunctionBreakpoint = exports.ExceptionBreakpoint = exports.SourceBreakpoint = exports.DEBUG_BREAKPOINT_SCHEME = void 0;
const coreutils_1 = require("@theia/core/shared/@lumino/coreutils");
const common_1 = require("@theia/core/lib/common");
exports.DEBUG_BREAKPOINT_SCHEME = 'debug-breakpoint';
var SourceBreakpoint;
(function (SourceBreakpoint) {
    function create(uri, data, origin) {
        return {
            id: origin ? origin.id : coreutils_1.UUID.uuid4(),
            uri: uri.toString(),
            enabled: origin ? origin.enabled : true,
            raw: {
                ...(origin && origin.raw),
                ...data
            }
        };
    }
    SourceBreakpoint.create = create;
})(SourceBreakpoint || (exports.SourceBreakpoint = SourceBreakpoint = {}));
var ExceptionBreakpoint;
(function (ExceptionBreakpoint) {
    function create(data, origin) {
        return {
            id: origin?.id ?? coreutils_1.UUID.uuid4(),
            enabled: origin?.enabled ?? !!data.default,
            condition: origin ? origin.condition : undefined,
            raw: {
                ...(origin && origin.raw),
                ...data
            }
        };
    }
    ExceptionBreakpoint.create = create;
    /** Copied from https://github.com/microsoft/vscode/blob/8934b59d4aa696b6f51ac9bf2eeae8bbac5dac03/src/vs/workbench/contrib/debug/common/debugModel.ts#L1368-L1374 */
    function matches(left, right) {
        return (left.filter === right.filter &&
            left.label === right.label &&
            !!left.supportsCondition === !!right.supportsCondition &&
            left.conditionDescription === right.conditionDescription &&
            left.description === right.description);
    }
    ExceptionBreakpoint.matches = matches;
})(ExceptionBreakpoint || (exports.ExceptionBreakpoint = ExceptionBreakpoint = {}));
var FunctionBreakpoint;
(function (FunctionBreakpoint) {
    function create(data, origin) {
        return {
            id: origin ? origin.id : coreutils_1.UUID.uuid4(),
            enabled: origin ? origin.enabled : true,
            raw: {
                ...(origin && origin.raw),
                ...data
            }
        };
    }
    FunctionBreakpoint.create = create;
})(FunctionBreakpoint || (exports.FunctionBreakpoint = FunctionBreakpoint = {}));
var InstructionBreakpoint;
(function (InstructionBreakpoint) {
    function create(raw, existing) {
        return {
            raw,
            id: existing?.id ?? coreutils_1.UUID.uuid4(),
            enabled: existing?.enabled ?? true,
        };
    }
    InstructionBreakpoint.create = create;
    function is(arg) {
        return (0, common_1.isObject)(arg) && (0, common_1.isString)(arg.instructionReference);
    }
    InstructionBreakpoint.is = is;
})(InstructionBreakpoint || (exports.InstructionBreakpoint = InstructionBreakpoint = {}));
var DataBreakpoint;
(function (DataBreakpoint) {
    function create(raw, info, source, ref) {
        return {
            raw,
            info,
            id: ref?.id ?? coreutils_1.UUID.uuid4(),
            enabled: ref?.enabled ?? true,
            source
        };
    }
    DataBreakpoint.create = create;
})(DataBreakpoint || (exports.DataBreakpoint = DataBreakpoint = {}));
//# sourceMappingURL=breakpoint-marker.js.map