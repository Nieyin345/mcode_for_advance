"use strict";
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
exports.parseModule = parseModule;
/**
 * Examples:
 * - `a` => `['a']`
 * - `a/b/c/...` => `['a', 'b/c/...']`
 * - `@a/b` => `['@a/b']`
 * - `@a/b/c/...` => `['@a/b', 'c/...']`
 */
function parseModule(moduleName) {
    const slice = moduleName.startsWith('@') ? 2 : 1;
    const split = moduleName.split('/').filter(part => part.trim().length > 0);
    if (split.length < slice) {
        throw new Error(`Unexpected module name/format: ${JSON.stringify(moduleName)}`);
    }
    const packageName = split.slice(0, slice).join('/');
    if (split.length === slice) {
        return [packageName];
    }
    else {
        const subModuleName = split.slice(slice).join('/');
        return [packageName, subModuleName];
    }
}
//# sourceMappingURL=utility.js.map