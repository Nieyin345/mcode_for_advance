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
const scm_service_1 = require("@theia/scm/lib/browser/scm-service");
const scm_main_1 = require("./scm-main");
function createScmMainImpl(scmService) {
    // Bypass the constructor's RPC/container wiring. ScmMainImpl's $register and
    // $unregister only touch the proxy for input box validation and selection
    // forwarding — not exercised in this test — so we can stub those safely.
    const proxy = new Proxy({}, {
        get: () => () => undefined
    });
    const impl = Object.create(scm_main_1.ScmMainImpl.prototype);
    const anyImpl = impl;
    anyImpl.proxy = proxy;
    anyImpl.scmService = scmService;
    anyImpl.repositories = new Map();
    anyImpl.repositoryDisposables = new Map();
    anyImpl.disposables = { push: () => { } };
    anyImpl.colors = { toCssVariableName: (x) => x };
    anyImpl.sharedStyle = { toIconClass: () => ({ object: { iconClass: '' }, dispose: () => { } }) };
    return impl;
}
describe('ScmMainImpl - cascade dispose of children on $unregisterSourceControl', () => {
    let scmService;
    let impl;
    beforeEach(() => {
        scmService = new scm_service_1.ScmService();
        // Stub the optional context key dependency used by ScmService.
        scmService.contextKeys = {};
        impl = createScmMainImpl(scmService);
    });
    it('should unregister worktree children when their parent is unregistered', async () => {
        // Parent
        await impl.$registerSourceControl(1, 'git', 'Main', { scheme: 'file', path: '/repo', authority: '', query: '', fragment: '' });
        // Two worktree children pointing at the parent
        await impl.$registerSourceControl(2, 'git', 'WT-A', { scheme: 'file', path: '/wt-a', authority: '', query: '', fragment: '' }, 1);
        await impl.$registerSourceControl(3, 'git', 'WT-B', { scheme: 'file', path: '/wt-b', authority: '', query: '', fragment: '' }, 1);
        (0, chai_1.expect)(scmService.repositories).to.have.length(3);
        const removed = [];
        scmService.onDidRemoveRepository(r => removed.push(r));
        await impl.$unregisterSourceControl(1);
        // Parent and both children must be removed from the service.
        (0, chai_1.expect)(scmService.repositories).to.have.length(0);
        (0, chai_1.expect)(removed).to.have.length(3);
        // Internal bookkeeping must be clean.
        const internals = impl;
        (0, chai_1.expect)(internals.repositories.size).to.equal(0);
        (0, chai_1.expect)(internals.repositoryDisposables.size).to.equal(0);
    });
    it('should leave unrelated repositories untouched when a parent is unregistered', async () => {
        await impl.$registerSourceControl(1, 'git', 'Main', { scheme: 'file', path: '/repo', authority: '', query: '', fragment: '' });
        await impl.$registerSourceControl(2, 'git', 'WT-A', { scheme: 'file', path: '/wt-a', authority: '', query: '', fragment: '' }, 1);
        // An independent repository (no parent)
        await impl.$registerSourceControl(3, 'git', 'Other', { scheme: 'file', path: '/other', authority: '', query: '', fragment: '' });
        await impl.$unregisterSourceControl(1);
        const remaining = scmService.repositories;
        (0, chai_1.expect)(remaining).to.have.length(1);
        (0, chai_1.expect)(remaining[0].provider.rootUri).to.include('/other');
    });
    it('should not crash when the child was already unregistered before the parent', async () => {
        await impl.$registerSourceControl(1, 'git', 'Main', { scheme: 'file', path: '/repo', authority: '', query: '', fragment: '' });
        await impl.$registerSourceControl(2, 'git', 'WT-A', { scheme: 'file', path: '/wt-a', authority: '', query: '', fragment: '' }, 1);
        // Plugin-side unregister for the child arrives first (race scenario).
        await impl.$unregisterSourceControl(2);
        (0, chai_1.expect)(scmService.repositories).to.have.length(1);
        // Now the parent is unregistered — cascade should find no child and succeed.
        await impl.$unregisterSourceControl(1);
        (0, chai_1.expect)(scmService.repositories).to.have.length(0);
    });
});
//# sourceMappingURL=scm-main.spec.js.map