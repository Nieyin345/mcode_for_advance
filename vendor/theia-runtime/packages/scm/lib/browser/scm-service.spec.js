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
const event_1 = require("@theia/core/lib/common/event");
const scm_service_1 = require("./scm-service");
function makeProvider(id, rootUri) {
    return {
        id,
        label: id,
        rootUri,
        groups: [],
        onDidChange: new event_1.Emitter().event,
        onDidChangeCommitTemplate: new event_1.Emitter().event,
        dispose: () => { }
    };
}
describe('ScmService - repository removal event ordering', () => {
    let service;
    beforeEach(() => {
        service = new scm_service_1.ScmService();
        // ScmService declares a ScmContextKeyService injection but does not use it
        // in the paths exercised here. Stub it to stay resilient against future use.
        service.contextKeys = {};
    });
    it('should update selectedRepository before firing onDidRemoveRepository', () => {
        const repoA = service.registerScmProvider(makeProvider('git', '/a'));
        const repoB = service.registerScmProvider(makeProvider('git', '/b'));
        // Select repoA explicitly (registerScmProvider auto-selects the first one).
        service.selectedRepository = repoA;
        (0, chai_1.expect)(service.selectedRepository).to.equal(repoA);
        let selectedDuringRemoveEvent;
        service.onDidRemoveRepository(() => {
            selectedDuringRemoveEvent = service.selectedRepository;
        });
        repoA.dispose();
        // When a subscriber of onDidRemoveRepository inspects selectedRepository,
        // it must not observe the disposed repository as still being selected.
        (0, chai_1.expect)(selectedDuringRemoveEvent).to.not.equal(repoA);
        (0, chai_1.expect)(selectedDuringRemoveEvent).to.equal(repoB);
        (0, chai_1.expect)(service.selectedRepository).to.equal(repoB);
    });
    it('should clear selectedRepository to undefined when the last repository is removed', () => {
        const repo = service.registerScmProvider(makeProvider('git', '/a'));
        (0, chai_1.expect)(service.selectedRepository).to.equal(repo);
        let selectedDuringRemoveEvent = 'unset';
        service.onDidRemoveRepository(() => {
            selectedDuringRemoveEvent = service.selectedRepository;
        });
        repo.dispose();
        (0, chai_1.expect)(selectedDuringRemoveEvent).to.be.undefined;
        (0, chai_1.expect)(service.selectedRepository).to.be.undefined;
    });
    it('should fire onDidRemoveRepository and leave _repositories empty after disposing the only repo', () => {
        const repo = service.registerScmProvider(makeProvider('git', '/a'));
        let removed;
        service.onDidRemoveRepository(r => { removed = r; });
        repo.dispose();
        (0, chai_1.expect)(removed).to.equal(repo);
        (0, chai_1.expect)(service.repositories).to.have.length(0);
    });
});
//# sourceMappingURL=scm-service.spec.js.map