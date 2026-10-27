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
const chai_1 = require("chai");
const launch_args_store_1 = require("./launch-args-store");
const args = (name, value) => ({ values: { [name]: [value] }, negated: [] });
describe('LaunchArgsStore', () => {
    it('returns the stored argv for its window id', () => {
        const store = new launch_args_store_1.LaunchArgsStore();
        const launchArgs = { values: { 'attach-container': ['B'], 'session-preference': ['foo=1'] }, negated: [] };
        store.store(1, launchArgs);
        (0, chai_1.expect)(store.get(1)).to.deep.equal(launchArgs);
    });
    it('keeps the argv for the window lifetime, so a reload still sees it', () => {
        const store = new launch_args_store_1.LaunchArgsStore();
        store.store(1, args('attach-container', 'B'));
        (0, chai_1.expect)(store.get(1)).to.deep.equal(args('attach-container', 'B'));
        // a second read (e.g. after a reload) still returns the options
        (0, chai_1.expect)(store.get(1)).to.deep.equal(args('attach-container', 'B'));
    });
    it('returns undefined for an unknown (cold-start) window id', () => {
        const store = new launch_args_store_1.LaunchArgsStore();
        (0, chai_1.expect)(store.get(42)).to.equal(undefined);
    });
    it('drops the argv once the window is deleted', () => {
        const store = new launch_args_store_1.LaunchArgsStore();
        store.store(1, args('attach-container', 'A'));
        store.delete(1);
        (0, chai_1.expect)(store.get(1)).to.equal(undefined);
    });
    it('keeps entries independent per window id', () => {
        const store = new launch_args_store_1.LaunchArgsStore();
        store.store(1, args('attach-container', 'A'));
        store.store(2, args('attach-container', 'B'));
        (0, chai_1.expect)(store.get(2)).to.deep.equal(args('attach-container', 'B'));
        (0, chai_1.expect)(store.get(1)).to.deep.equal(args('attach-container', 'A'));
    });
});
//# sourceMappingURL=launch-args-store.spec.js.map