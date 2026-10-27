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
const tslib_1 = require("tslib");
require("reflect-metadata");
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("@theia/core/lib/common");
const ai_configuration_category_1 = require("./ai-configuration-category");
const ai_configuration_category_registry_1 = require("./ai-configuration-category-registry");
class DummyCategory {
    constructor(id, order, contributed, searchItems = []) {
        this.id = id;
        this.order = order;
        this.contributed = contributed;
        this.searchItems = searchItems;
        this.renderer = {};
        this.onDidChangeEmitter = new core_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this.label = this.id;
        this.iconClass = 'codicon codicon-gear';
        this.kind = 'single-page';
    }
    get search() {
        return this.searchItems.length ? { getSearchItems: () => this.searchItems } : undefined;
    }
    fireChange() {
        this.onDidChangeEmitter.fire();
    }
}
describe('AiConfigurationCategoryRegistry', () => {
    function createRegistry(...categories) {
        const container = new inversify_1.Container();
        container.load(new inversify_1.ContainerModule(bind => {
            (0, common_1.bindContributionProvider)(bind, ai_configuration_category_1.AiConfigurationCategory);
            categories.forEach(category => bind(ai_configuration_category_1.AiConfigurationCategory).toConstantValue(category));
            bind(ai_configuration_category_registry_1.AiConfigurationCategoryRegistry).toSelf().inSingletonScope();
        }));
        return container.get(ai_configuration_category_registry_1.AiConfigurationCategoryRegistry);
    }
    it('resolves to an empty list when nothing is contributed', () => {
        const registry = createRegistry();
        (0, chai_1.expect)(registry.getCategories()).to.deep.equal([]);
    });
    it('aggregates an empty search index when nothing is contributed', () => {
        const registry = createRegistry();
        (0, chai_1.expect)(registry.getSearchItems()).to.deep.equal([]);
    });
    it('orders categories ascending by order', () => {
        const registry = createRegistry(new DummyCategory('c', 300), new DummyCategory('a', 100), new DummyCategory('b', 200));
        (0, chai_1.expect)(registry.getCategories().map(c => c.id)).to.deep.equal(['a', 'b', 'c']);
    });
    it('sorts contributed categories after all built-ins regardless of order', () => {
        const registry = createRegistry(new DummyCategory('ext', 1, true), new DummyCategory('builtin', 900));
        (0, chai_1.expect)(registry.getCategories().map(c => c.id)).to.deep.equal(['builtin', 'ext']);
    });
    it('resolves a category by id', () => {
        const registry = createRegistry(new DummyCategory('a', 100), new DummyCategory('b', 200));
        (0, chai_1.expect)(registry.getCategory('b')?.id).to.equal('b');
        (0, chai_1.expect)(registry.getCategory('missing')).to.equal(undefined);
    });
    it('aggregates the search index across categories that provide one', () => {
        const item = (label, categoryId) => ({ label, typeLabel: 'Setting', categoryId, target: { categoryId } });
        const registry = createRegistry(new DummyCategory('a', 100, false, [item('a1', 'a')]), new DummyCategory('b', 200), new DummyCategory('c', 300, false, [item('c1', 'c'), item('c2', 'c')]));
        (0, chai_1.expect)(registry.getSearchItems().map(i => i.label)).to.deep.equal(['a1', 'c1', 'c2']);
    });
    it('refires onDidChange when a contributed category changes', () => {
        const category = new DummyCategory('a', 100);
        const registry = createRegistry(category);
        let fired = 0;
        registry.onDidChange(() => fired++);
        category.fireChange();
        (0, chai_1.expect)(fired).to.equal(1);
    });
    it('resolves without recursion when a contributed category injects the registry', () => {
        // A category may inject the registry (e.g. to navigate across categories). The registry must not
        // resolve its contributions during its own construction, or that closes a dependency cycle.
        let RegistryInjectingCategory = class RegistryInjectingCategory {
            constructor() {
                this.id = 'self';
                this.label = 'self';
                this.iconClass = 'codicon codicon-gear';
                this.kind = 'single-page';
                this.renderer = {};
            }
        };
        tslib_1.__decorate([
            (0, inversify_1.inject)(ai_configuration_category_registry_1.AiConfigurationCategoryRegistry),
            tslib_1.__metadata("design:type", ai_configuration_category_registry_1.AiConfigurationCategoryRegistry)
        ], RegistryInjectingCategory.prototype, "registry", void 0);
        RegistryInjectingCategory = tslib_1.__decorate([
            (0, inversify_1.injectable)()
        ], RegistryInjectingCategory);
        const container = new inversify_1.Container();
        container.load(new inversify_1.ContainerModule(bind => {
            (0, common_1.bindContributionProvider)(bind, ai_configuration_category_1.AiConfigurationCategory);
            bind(RegistryInjectingCategory).toSelf().inSingletonScope();
            bind(ai_configuration_category_1.AiConfigurationCategory).toService(RegistryInjectingCategory);
            bind(ai_configuration_category_registry_1.AiConfigurationCategoryRegistry).toSelf().inSingletonScope();
        }));
        const registry = container.get(ai_configuration_category_registry_1.AiConfigurationCategoryRegistry);
        // Listening wires the aggregation, which resolves the contribution that injects this very registry.
        (0, chai_1.expect)(() => registry.onDidChange(() => { })).to.not.throw();
        (0, chai_1.expect)(registry.getCategories().map(category => category.id)).to.deep.equal(['self']);
    });
});
//# sourceMappingURL=ai-configuration-category-registry.spec.js.map