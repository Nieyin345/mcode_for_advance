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
const chai_1 = require("chai");
const sinon = require("sinon");
const core_1 = require("@theia/core");
const workspace_search_filter_service_1 = require("./workspace-search-filter-service");
class MockProvider {
    constructor(globs = []) {
        this.globs = globs;
        this.onExclusionGlobsChangedEmitter = new core_1.Emitter();
        this.onExclusionGlobsChanged = this.onExclusionGlobsChangedEmitter.event;
    }
    getExclusionGlobs() {
        return this.globs;
    }
    setGlobs(globs) {
        this.globs = globs;
        this.onExclusionGlobsChangedEmitter.fire();
    }
}
function createService(providers) {
    const service = new workspace_search_filter_service_1.WorkspaceSearchFilterService();
    const contributionProvider = {
        getContributions: () => providers
    };
    service.providers = contributionProvider;
    service['init']();
    return service;
}
describe('WorkspaceSearchFilterService', () => {
    afterEach(() => {
        sinon.restore();
    });
    describe('getExclusionGlobs', () => {
        it('should return empty array when no providers are registered', () => {
            const service = createService([]);
            (0, chai_1.expect)(service.getExclusionGlobs()).to.deep.equal([]);
        });
        it('should return globs from a single provider', () => {
            const provider = new MockProvider(['**/*.log', '**/node_modules']);
            const service = createService([provider]);
            (0, chai_1.expect)(service.getExclusionGlobs()).to.deep.equal(['**/*.log', '**/node_modules']);
        });
        it('should aggregate globs from multiple providers', () => {
            const providerA = new MockProvider(['**/*.log']);
            const providerB = new MockProvider(['**/node_modules']);
            const service = createService([providerA, providerB]);
            (0, chai_1.expect)(service.getExclusionGlobs()).to.include.members(['**/*.log', '**/node_modules']);
            (0, chai_1.expect)(service.getExclusionGlobs()).to.have.lengthOf(2);
        });
        it('should deduplicate globs across providers', () => {
            const providerA = new MockProvider(['**/*.log', '**/dist']);
            const providerB = new MockProvider(['**/*.log', '**/node_modules']);
            const service = createService([providerA, providerB]);
            const globs = service.getExclusionGlobs();
            (0, chai_1.expect)(globs).to.have.lengthOf(3);
            (0, chai_1.expect)(globs).to.include.members(['**/*.log', '**/dist', '**/node_modules']);
        });
        it('should handle providers that return empty arrays', () => {
            const providerA = new MockProvider([]);
            const providerB = new MockProvider(['**/*.log']);
            const service = createService([providerA, providerB]);
            (0, chai_1.expect)(service.getExclusionGlobs()).to.deep.equal(['**/*.log']);
        });
    });
    describe('onExclusionGlobsChanged', () => {
        it('should fire when a provider fires a change event', () => {
            const provider = new MockProvider(['**/*.log']);
            const service = createService([provider]);
            const spy = sinon.spy();
            service.onExclusionGlobsChanged(spy);
            provider.setGlobs(['**/dist']);
            (0, chai_1.expect)(spy.calledOnce).to.be.true;
        });
        it('should fire once per provider change event', () => {
            const providerA = new MockProvider(['**/*.log']);
            const providerB = new MockProvider(['**/node_modules']);
            const service = createService([providerA, providerB]);
            const spy = sinon.spy();
            service.onExclusionGlobsChanged(spy);
            providerA.setGlobs(['**/dist']);
            providerB.setGlobs(['**/build']);
            (0, chai_1.expect)(spy.calledTwice).to.be.true;
        });
        it('should not fire when no provider changes', () => {
            const provider = new MockProvider(['**/*.log']);
            const service = createService([provider]);
            const spy = sinon.spy();
            service.onExclusionGlobsChanged(spy);
            (0, chai_1.expect)(spy.called).to.be.false;
        });
        it('should recalculate when any provider fires a change event', () => {
            const providerA = new MockProvider(['**/*.log']);
            const providerB = new MockProvider(['**/node_modules']);
            const service = createService([providerA, providerB]);
            service.getExclusionGlobs();
            providerB.setGlobs(['**/build']);
            const globs = service.getExclusionGlobs();
            (0, chai_1.expect)(globs).to.include.members(['**/*.log', '**/build']);
            (0, chai_1.expect)(globs).to.not.include('**/node_modules');
        });
    });
});
//# sourceMappingURL=workspace-search-filter-service.spec.js.map