"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
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
exports.LaunchArguments = void 0;
/** @experimental */
var LaunchArguments;
(function (LaunchArguments) {
    /** A launch that carried no options. */
    LaunchArguments.EMPTY = { values: {}, negated: [] };
    /** Every value of a (possibly repeated) option, or an empty array when the option is absent. */
    function values(args, name) {
        return args.values[name] ?? [];
    }
    LaunchArguments.values = values;
    /**
     * The last value of an option, or `undefined` when the option is absent. Last wins, so that a
     * repeated option behaves like it does on a normal command line.
     */
    function lastValue(args, name) {
        const all = values(args, name);
        return all.length > 0 ? all[all.length - 1] : undefined;
    }
    LaunchArguments.lastValue = lastValue;
    /** Whether a boolean option was explicitly disabled, i.e. `--no-name` or `--name=false`. */
    function isNegated(args, name) {
        return args.negated.includes(name);
    }
    LaunchArguments.isNegated = isNegated;
})(LaunchArguments || (exports.LaunchArguments = LaunchArguments = {}));
//# sourceMappingURL=launch-arguments.js.map