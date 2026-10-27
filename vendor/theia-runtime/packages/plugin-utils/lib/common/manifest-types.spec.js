"use strict";
// *****************************************************************************
// Copyright (C) 2026 Maksim Kachurin and others.
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
const chai_1 = require("chai");
const manifest_types_1 = require("./manifest-types");
describe('manifest-types', () => {
    describe('rawContributes', () => {
        it('returns contributes object when present', () => {
            const contributes = { commands: [{ command: 'x', title: 'X' }] };
            (0, chai_1.expect)((0, manifest_types_1.rawContributes)({ contributes })).to.equal(contributes);
        });
        it('returns empty object when contributes is missing or invalid', () => {
            (0, chai_1.expect)((0, manifest_types_1.rawContributes)({})).to.deep.equal({});
            // eslint-disable-next-line no-null/no-null
            (0, chai_1.expect)((0, manifest_types_1.rawContributes)({ contributes: null })).to.deep.equal({});
            (0, chai_1.expect)((0, manifest_types_1.rawContributes)({ contributes: undefined })).to.deep.equal({});
            (0, chai_1.expect)((0, manifest_types_1.rawContributes)({ contributes: 'invalid' })).to.deep.equal({});
        });
    });
});
//# sourceMappingURL=manifest-types.spec.js.map