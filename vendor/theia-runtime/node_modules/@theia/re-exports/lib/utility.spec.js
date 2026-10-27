"use strict";
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
const utility_1 = require("./utility");
const chai_1 = require("chai");
describe('@theia/re-exports/lib/utility.js', () => {
    it('parseModule', () => {
        (0, chai_1.expect)((0, utility_1.parseModule)('a')).length(1).members(['a']);
        (0, chai_1.expect)((0, utility_1.parseModule)('a/')).length(1).members(['a']);
        (0, chai_1.expect)((0, utility_1.parseModule)('a/b')).length(2).members(['a', 'b']);
        (0, chai_1.expect)((0, utility_1.parseModule)('a/b/')).length(2).members(['a', 'b']);
        (0, chai_1.expect)((0, utility_1.parseModule)('a/b/c/d/e/f')).length(2).members(['a', 'b/c/d/e/f']);
    });
    it('parseModule with namespaced package', () => {
        (0, chai_1.expect)((0, utility_1.parseModule)('@a/b')).length(1).members(['@a/b']);
        (0, chai_1.expect)((0, utility_1.parseModule)('@a/b/')).length(1).members(['@a/b']);
        (0, chai_1.expect)((0, utility_1.parseModule)('@a/b/c')).length(2).members(['@a/b', 'c']);
        (0, chai_1.expect)((0, utility_1.parseModule)('@a/b/c/')).length(2).members(['@a/b', 'c']);
        (0, chai_1.expect)((0, utility_1.parseModule)('@a/b/c/d/e/f')).length(2).members(['@a/b', 'c/d/e/f']);
    });
    it('parseModule unexpected module name/format', () => {
        (0, chai_1.expect)(() => (0, utility_1.parseModule)('@a')).throw();
    });
});
//# sourceMappingURL=utility.spec.js.map