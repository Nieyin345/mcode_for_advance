"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
exports.isENOENT = void 0;
exports.illegalArgument = illegalArgument;
exports.readonly = readonly;
exports.disposed = disposed;
var utils_1 = require("@theia/plugin-utils/lib/common/utils");
Object.defineProperty(exports, "isENOENT", { enumerable: true, get: function () { return utils_1.isENOENT; } });
function illegalArgument(message) {
    if (message) {
        return new Error(`Illegal argument: ${message}`);
    }
    else {
        return new Error('Illegal argument');
    }
}
function readonly(name) {
    if (name) {
        return new Error(`readonly property '${name} cannot be changed'`);
    }
    else {
        return new Error('readonly property cannot be changed');
    }
}
function disposed(what) {
    const result = new Error(`${what} has been disposed`);
    result.name = 'DISPOSED';
    return result;
}
//# sourceMappingURL=errors.js.map