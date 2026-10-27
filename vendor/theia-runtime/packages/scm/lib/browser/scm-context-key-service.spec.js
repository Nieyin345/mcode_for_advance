"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const event_1 = require("@theia/core/lib/common/event");
const scm_context_key_service_1 = require("./scm-context-key-service");
const scm_contribution_1 = require("./scm-contribution");
disableJSDOM();
class MockContextKeyService extends context_key_service_1.ContextKeyServiceDummyImpl {
    createKey(key, defaultValue) {
        let value = defaultValue;
        const contextKey = {
            set: (v) => { value = v; },
            reset: () => { value = defaultValue; },
            get: () => value
        };
        return contextKey;
    }
}
function createScmContextKeyService() {
    const mockContextKeyService = new MockContextKeyService();
    const scmContextKeyService = new scm_context_key_service_1.ScmContextKeyService();
    // Inject the mock context key service
    scmContextKeyService.contextKeyService = mockContextKeyService;
    // Manually trigger @postConstruct init
    scmContextKeyService.init();
    return scmContextKeyService;
}
describe('ScmContextKeyService', () => {
    let scmContextKeyService;
    beforeEach(() => {
        scmContextKeyService = createScmContextKeyService();
    });
    it('should initialize scm.providerCount to 0', () => {
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(0);
    });
    it('should update scm.providerCount when set is called', () => {
        scmContextKeyService.scmProviderCount.set(5);
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(5);
    });
    it('should reset scm.providerCount to default value', () => {
        scmContextKeyService.scmProviderCount.set(3);
        scmContextKeyService.scmProviderCount.reset();
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(0);
    });
    it('should initialize scmCurrentHistoryItemRefInFilter to false', () => {
        (0, chai_1.expect)(scmContextKeyService.scmCurrentHistoryItemRefInFilter.get()).to.equal(false);
    });
    it('should update scmCurrentHistoryItemRefInFilter when set is called', () => {
        scmContextKeyService.scmCurrentHistoryItemRefInFilter.set(true);
        (0, chai_1.expect)(scmContextKeyService.scmCurrentHistoryItemRefInFilter.get()).to.equal(true);
    });
});
describe('ScmContribution scm.providerCount wiring', () => {
    let restoreJSDOM;
    let scmContribution;
    let scmContextKeyService;
    let onDidAddRepositoryEmitter;
    let onDidRemoveRepositoryEmitter;
    let onDidChangeSelectedRepositoryEmitter;
    let onDidChangeStatusBarCommandsEmitter;
    let repositories;
    beforeEach(() => {
        restoreJSDOM = (0, jsdom_1.enableJSDOM)();
        scmContextKeyService = createScmContextKeyService();
        const mockContextKeys = new MockContextKeyService();
        onDidAddRepositoryEmitter = new event_1.Emitter();
        onDidRemoveRepositoryEmitter = new event_1.Emitter();
        onDidChangeSelectedRepositoryEmitter = new event_1.Emitter();
        onDidChangeStatusBarCommandsEmitter = new event_1.Emitter();
        repositories = [];
        const mockScmService = {
            get repositories() { return repositories; },
            onDidAddRepository: onDidAddRepositoryEmitter.event,
            onDidRemoveRepository: onDidRemoveRepositoryEmitter.event,
            onDidChangeSelectedRepository: onDidChangeSelectedRepositoryEmitter.event,
            onDidChangeStatusBarCommands: onDidChangeStatusBarCommandsEmitter.event,
            statusBarCommands: []
        };
        scmContribution = new scm_contribution_1.ScmContribution();
        // Inject mocked dependencies
        const contribution = scmContribution;
        contribution.scmService = mockScmService;
        contribution.scmContextKeys = scmContextKeyService;
        contribution.contextKeys = mockContextKeys;
        contribution.statusBar = { setElement: () => { }, removeElement: () => { } };
        contribution.labelProvider = { getName: () => '', onDidChange: new event_1.Emitter().event };
        contribution.shell = { onDidChangeCurrentWidget: new event_1.Emitter().event, currentWidget: undefined };
        contribution.scmDecorationsService = { onDirtyDiffUpdate: new event_1.Emitter().event };
        contribution.dirtyDiffNavigator = {};
        // Manually trigger @postConstruct init (creates scmFocus context key)
        scmContribution.init();
    });
    afterEach(() => {
        onDidAddRepositoryEmitter.dispose();
        onDidRemoveRepositoryEmitter.dispose();
        onDidChangeSelectedRepositoryEmitter.dispose();
        onDidChangeStatusBarCommandsEmitter.dispose();
        restoreJSDOM();
    });
    it('should set scm.providerCount to 0 on start with no repositories', () => {
        scmContribution.onStart();
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(0);
    });
    it('should set scm.providerCount initial count when repositories exist at startup', () => {
        repositories.push({}, {});
        scmContribution.onStart();
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(2);
    });
    it('should increment scm.providerCount when a repository is added', () => {
        scmContribution.onStart();
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(0);
        repositories.push({});
        onDidAddRepositoryEmitter.fire({});
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(1);
    });
    it('should decrement scm.providerCount when a repository is removed', () => {
        const repo = {};
        repositories.push(repo);
        scmContribution.onStart();
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(1);
        repositories.pop();
        onDidRemoveRepositoryEmitter.fire(repo);
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(0);
    });
    it('should track multiple additions and removals', () => {
        scmContribution.onStart();
        const repo1 = {};
        const repo2 = {};
        repositories.push(repo1);
        onDidAddRepositoryEmitter.fire(repo1);
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(1);
        repositories.push(repo2);
        onDidAddRepositoryEmitter.fire(repo2);
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(2);
        repositories.pop();
        onDidRemoveRepositoryEmitter.fire(repo2);
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(1);
        repositories.pop();
        onDidRemoveRepositoryEmitter.fire(repo1);
        (0, chai_1.expect)(scmContextKeyService.scmProviderCount.get()).to.equal(0);
    });
});
//# sourceMappingURL=scm-context-key-service.spec.js.map