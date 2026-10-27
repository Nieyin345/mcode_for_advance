"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CollectionCategoryRenderer = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
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
const core_1 = require("@theia/core");
const ai_configuration_primitives_1 = require("../components/ai-configuration-primitives");
const ai_configuration_item_row_1 = require("../components/ai-configuration-item-row");
/** Describes the overview's "Add …" affordance. */
/**
 * Convenience base for `collection` categories. Renders the overview (category
 * settings slot + item card grid + add action + empty state) and the per-item
 * detail frame (header + sections). Subclasses provide the items, the item
 * sections, and optionally category-level settings and an add action.
 */
class CollectionCategoryRenderer {
    constructor() {
        /** Ids already reported as duplicated, so the warning is logged once rather than on every render. */
        this.reportedDuplicateIds = new Set();
    }
    renderOverview(ctx) {
        const items = this.addressableItems(this.getTreeChildren());
        const add = this.getAddAction(ctx);
        const addAction = add && (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationAddAction, { label: add.label, iconClass: add.iconClass, onClick: () => add.run() });
        const body = items.length === 0
            ? (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationEmptyState, { message: this.getEmptyMessage(), action: addAction })
            : (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: 'ai-configuration-item-list', children: items.map(item => (0, jsx_runtime_1.jsx)(ai_configuration_item_row_1.AiConfigurationItemRow, { label: item.label, iconClass: item.iconClass, description: item.description, tags: item.tags, origins: item.origins, status: item.status, onSelect: () => ctx.navigate({ categoryId: this.categoryId, itemId: item.id }) }, item.id)) }), addAction && (0, jsx_runtime_1.jsx)("div", { className: 'ai-configuration-overview-actions', children: addAction })] });
        const listTitle = this.overviewListTitle;
        return (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-page', children: [this.renderCategorySettings(ctx), listTitle !== undefined
                    // Foldable with its size on the header once there is a list to fold; an empty state stays plain.
                    ? (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationSection, { title: listTitle, count: items.length > 0 ? items.length : undefined, collapsible: items.length > 0, children: body })
                    : body] });
    }
    /**
     * The items this page can actually address, i.e. one per id. Everything downstream keys on the id — the
     * tree node, the navigation target, the detail lookup and the per-item settings — so an item repeating an
     * id could neither be opened nor configured on its own; it is dropped here and logged once. Representing
     * such a clash properly is a separate concern from this view (it starts where the items are registered).
     */
    addressableItems(items) {
        const byId = new Map();
        for (const item of items) {
            if (byId.has(item.id)) {
                this.warnAboutDuplicateId(item.id);
                continue;
            }
            byId.set(item.id, item);
        }
        return [...byId.values()];
    }
    /**
     * Warns once per id, since the overview re-renders and would otherwise repeat itself indefinitely.
     * `console` rather than an `ILogger`: this base class is not injectable, so it has no injection context
     * of its own; subclasses that want their named logger can override this.
     */
    warnAboutDuplicateId(id) {
        if (this.reportedDuplicateIds.has(id)) {
            return;
        }
        this.reportedDuplicateIds.add(id);
        console.warn(`More than one entry of the AI configuration category "${this.categoryId}" declares the id "${id}". `
            + 'Only the first is shown, since everything (navigation, settings) is keyed by that id. Give each entry a unique id.');
    }
    /** Optional heading shown above the item list (e.g. "Agents"), like the Providers page. None by default. */
    get overviewListTitle() {
        return undefined;
    }
    renderItemDetail(itemId, ctx) {
        const item = this.getTreeChildren().find(child => child.id === itemId);
        if (!item) {
            return undefined;
        }
        return (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-page', children: [this.renderItemHeader(item, ctx), this.renderItemSections(item, ctx)] });
    }
    /** Category-level settings shown above the card grid; nothing by default. */
    renderCategorySettings(ctx) {
        return undefined;
    }
    /** Header of an item detail page; icon/title/subtitle/origins from the item by default. */
    renderItemHeader(item, ctx) {
        return (0, jsx_runtime_1.jsx)(ai_configuration_primitives_1.AiConfigurationItemDetailHeader, { title: item.label, iconClass: item.iconClass, subtitle: item.description, status: item.status, origins: item.origins });
    }
    /** The overview "Add …" affordance; none by default. */
    getAddAction(ctx) {
        return undefined;
    }
    getEmptyMessage() {
        return core_1.nls.localize('theia/ai/core/aiConfiguration/collectionEmpty', 'No items to configure yet.');
    }
}
exports.CollectionCategoryRenderer = CollectionCategoryRenderer;
//# sourceMappingURL=collection-category-renderer.js.map