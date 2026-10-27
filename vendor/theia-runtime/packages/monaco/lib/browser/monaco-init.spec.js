"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const standaloneServices_1 = require("@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices");
const instantiation_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/instantiation");
const instantiationService_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/instantiationService");
const serviceCollection_1 = require("@theia/monaco-editor-core/esm/vs/platform/instantiation/common/serviceCollection");
disableJSDOM();
/**
 * @monaco-uplift
 *
 * These tests guard internal assumptions that `monaco-init.ts` makes about
 * Monaco's `StandaloneServices`.  Specifically:
 *
 * 1. `StandaloneServices.get(IInstantiationService)` returns an instance of the
 *    concrete {@link InstantiationService} class.
 * 2. That class exposes a private `_services` field of type {@link ServiceCollection}.
 * 3. `StandaloneServices.withServices` calls its callback **synchronously** when
 *    services are already initialized (used to detect premature initialization).
 *
 * Because these rely on private implementation details of Monaco, they may break
 * in a future release.  If any of these tests fail after a Monaco version bump,
 * the corresponding code in `monaco-init.ts` must be updated to match.
 */
describe('Monaco InstantiationService internals', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    it('StandaloneServices.get(IInstantiationService) should be an instance of InstantiationService', () => {
        const instantiationService = standaloneServices_1.StandaloneServices.get(instantiation_1.IInstantiationService);
        (0, chai_1.expect)(instantiationService).to.be.an.instanceOf(instantiationService_1.InstantiationService);
    });
    it('StandaloneServices.get(IInstantiationService) should have a _services property that is a ServiceCollection', () => {
        const instantiationService = standaloneServices_1.StandaloneServices.get(instantiation_1.IInstantiationService);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const services = instantiationService['_services'];
        (0, chai_1.expect)(services).to.not.be.undefined;
        (0, chai_1.expect)(services).to.be.an.instanceOf(serviceCollection_1.ServiceCollection);
    });
    // MonacoInit.init() uses withServices to detect whether StandaloneServices
    // was already initialized: it passes a callback that sets a flag, then reads
    // the flag immediately afterwards.  This only works if withServices calls
    // the callback synchronously when services are already initialized.
    it('StandaloneServices.withServices should call the callback synchronously when already initialized', () => {
        // Ensure services are initialized (get triggers initialization if needed).
        standaloneServices_1.StandaloneServices.get(instantiation_1.IInstantiationService);
        let called = false;
        standaloneServices_1.StandaloneServices.withServices(() => {
            called = true;
            return core_1.Disposable.NULL;
        });
        (0, chai_1.expect)(called).to.be.true;
    });
});
//# sourceMappingURL=monaco-init.spec.js.map