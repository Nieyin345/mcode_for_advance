"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TodayVariableContribution = exports.TODAY_VARIABLE = exports.TodayVariableArgs = void 0;
const tslib_1 = require("tslib");
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
var TodayVariableArgs;
(function (TodayVariableArgs) {
    TodayVariableArgs.IN_UNIX_SECONDS = 'inUnixSeconds';
    TodayVariableArgs.IN_ISO_8601 = 'inIso8601';
})(TodayVariableArgs || (exports.TodayVariableArgs = TodayVariableArgs = {}));
exports.TODAY_VARIABLE = {
    id: 'today-provider',
    description: core_1.nls.localize('theia/ai/core/todayVariable/dateDescription', 'The current date. Resolves to a human-readable date string by default, or to ISO 8601 or Unix seconds via the format argument.'),
    name: 'today',
    args: [
        {
            name: 'Format',
            description: core_1.nls.localize('theia/ai/core/todayVariable/format/description', 'The format of the date'),
            enum: [TodayVariableArgs.IN_ISO_8601, TodayVariableArgs.IN_UNIX_SECONDS],
            isOptional: true
        }
    ]
};
let TodayVariableContribution = class TodayVariableContribution {
    registerVariables(service) {
        service.registerResolver(exports.TODAY_VARIABLE, this);
    }
    canResolve(request, context) {
        return 1;
    }
    async resolve(request, context) {
        if (request.variable.name === exports.TODAY_VARIABLE.name) {
            return this.resolveTodayVariable(request);
        }
        return undefined;
    }
    resolveTodayVariable(request) {
        const date = new Date();
        if (request.arg === TodayVariableArgs.IN_ISO_8601) {
            return { variable: request.variable, value: date.toISOString(), date };
        }
        if (request.arg === TodayVariableArgs.IN_UNIX_SECONDS) {
            return { variable: request.variable, value: Math.round(date.getTime() / 1000).toString(), date };
        }
        return { variable: request.variable, value: date.toDateString(), date };
    }
};
exports.TodayVariableContribution = TodayVariableContribution;
exports.TodayVariableContribution = TodayVariableContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TodayVariableContribution);
//# sourceMappingURL=today-variable-contribution.js.map