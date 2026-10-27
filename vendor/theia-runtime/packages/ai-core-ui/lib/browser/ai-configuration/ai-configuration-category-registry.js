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
exports.AiConfigurationCategoryRegistry = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const ai_configuration_category_1 = require("./ai-configuration-category");
/**
 * Collects all contributed {@link AiConfigurationCategory} instances and exposes
 * them ordered for the AI Configuration view. Refires an aggregated
 * {@link onDidChange} whenever any category changes.
 */
let AiConfigurationCategoryRegistry = class AiConfigurationCategoryRegistry {
    constructor() {
        this.onDidChangeEmitter = new core_1.Emitter();
        /**
         * Wires the aggregation lazily on first listen rather than in `@postConstruct`: a category may itself
         * inject this registry (e.g. to navigate across categories), so resolving all contributions during the
         * registry's own construction would create a dependency cycle.
         */
        this.onDidChange = (listener, thisArgs, disposables) => {
            this.wire();
            return this.onDidChangeEmitter.event(listener, thisArgs, disposables);
        };
        this.wired = false;
    }
    /** Subscribes once to every category's own change event so this registry can refire an aggregated one. */
    wire() {
        if (this.wired) {
            return;
        }
        this.wired = true;
        for (const category of this.contributions.getContributions()) {
            category.onDidChange?.(() => this.onDidChangeEmitter.fire());
        }
    }
    /**
     * Returns the categories ordered ascending by {@link AiConfigurationCategory.order}
     * (defaulting to `0`); `contributed` categories always sort after built-ins.
     */
    getCategories() {
        return this.contributions.getContributions().slice().sort((a, b) => {
            const contributedA = a.contributed ? 1 : 0;
            const contributedB = b.contributed ? 1 : 0;
            if (contributedA !== contributedB) {
                return contributedA - contributedB;
            }
            return (a.order ?? 0) - (b.order ?? 0);
        });
    }
    getCategory(id) {
        return this.contributions.getContributions().find(category => category.id === id);
    }
    /** Aggregated deep-search index across all categories that provide one. */
    getSearchItems() {
        return this.getCategories().flatMap(category => category.search?.getSearchItems() ?? []);
    }
};
exports.AiConfigurationCategoryRegistry = AiConfigurationCategoryRegistry;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(ai_configuration_category_1.AiConfigurationCategory),
    tslib_1.__metadata("design:type", Object)
], AiConfigurationCategoryRegistry.prototype, "contributions", void 0);
exports.AiConfigurationCategoryRegistry = AiConfigurationCategoryRegistry = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AiConfigurationCategoryRegistry);
//# sourceMappingURL=ai-configuration-category-registry.js.map