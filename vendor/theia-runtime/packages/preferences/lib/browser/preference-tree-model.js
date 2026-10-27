"use strict";
// *****************************************************************************
// Copyright (C) 2020 Ericsson and others.
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
exports.PreferenceTreeModel = exports.PreferenceFilterChangeSource = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/core/lib/browser");
const core_1 = require("@theia/core");
const preference_searchbar_widget_1 = require("./views/preference-searchbar-widget");
const preference_tree_generator_1 = require("./util/preference-tree-generator");
const fuzzy = require("@theia/core/shared/fuzzy");
const preference_scope_tabbar_widget_1 = require("./views/preference-scope-tabbar-widget");
const preference_types_1 = require("./util/preference-types");
const preference_layout_1 = require("./util/preference-layout");
/** Node id of the 'Commonly Used' group, see `PreferenceTreeGenerator`. */
const COMMONLY_USED_NODE_ID = `${preference_layout_1.COMMONLY_USED_SECTION_PREFIX}@${preference_layout_1.COMMONLY_USED_SECTION_PREFIX}`;
var PreferenceFilterChangeSource;
(function (PreferenceFilterChangeSource) {
    PreferenceFilterChangeSource[PreferenceFilterChangeSource["Schema"] = 0] = "Schema";
    PreferenceFilterChangeSource[PreferenceFilterChangeSource["Search"] = 1] = "Search";
    PreferenceFilterChangeSource[PreferenceFilterChangeSource["Scope"] = 2] = "Scope";
    PreferenceFilterChangeSource[PreferenceFilterChangeSource["Category"] = 3] = "Category";
})(PreferenceFilterChangeSource || (exports.PreferenceFilterChangeSource = PreferenceFilterChangeSource = {}));
let PreferenceTreeModel = class PreferenceTreeModel extends browser_1.TreeModelImpl {
    constructor() {
        super(...arguments);
        this.onTreeFilterChangedEmitter = new core_1.Emitter();
        this.onFilterChanged = this.onTreeFilterChangedEmitter.event;
        this.lastSearchedFuzzy = '';
        this.lastSearchedLiteral = '';
        this.lastSearchedTags = [];
        this._currentScope = Number(preference_types_1.Preference.DEFAULT_SCOPE.scope);
        this._isFiltered = false;
        this._currentRows = new Map();
        this._totalVisibleLeaves = 0;
        this._suppressSelection = false;
        this.preservingCategoryFilter = false;
        this._initialSelectionApplied = false;
    }
    get categoryFilterId() {
        return this._categoryFilterId;
    }
    get currentRows() {
        return this._currentRows;
    }
    get totalVisibleLeaves() {
        return this._totalVisibleLeaves;
    }
    get isFiltered() {
        return this._isFiltered;
    }
    get propertyList() {
        return this.schemaProvider.getSchemaProperties();
    }
    get currentScope() {
        return this.scopeTracker.currentScope;
    }
    get onSchemaChanged() {
        return this.treeGenerator.onSchemaChanged;
    }
    init() {
        this.doInit();
    }
    async doInit() {
        super.init();
        this.toDispose.pushAll([
            this.onSelectionChanged(selectionEvent => {
                this.lastSelectionId = selectionEvent[0]?.id;
                if (this.preservingCategoryFilter) {
                    return;
                }
                const node = selectionEvent[0];
                const newId = node ? this.categoryIdForSelection(node) : undefined;
                if (newId !== this._categoryFilterId) {
                    this._categoryFilterId = newId;
                    this.updateFilteredRows(PreferenceFilterChangeSource.Category);
                }
            }),
            this.treeGenerator.onSchemaChanged(newTree => this.handleNewSchema(newTree)),
            this.scopeTracker.onScopeChanged(scopeDetails => {
                this._currentScope = scopeDetails.scope;
                this.updateFilteredRows(PreferenceFilterChangeSource.Scope);
                this.ensureSelectedCategoryHasVisibleSettings();
            }),
            this.filterInput.onFilterChanged(newSearchTerm => {
                this.lastSearchedTags = Array.from(newSearchTerm.matchAll(/@tag:([^\s]+)/g)).map(match => match[0].slice(5));
                const newSearchTermWithoutTags = newSearchTerm.replace(/@tag:[^\s]+/g, '');
                this.lastSearchedLiteral = newSearchTermWithoutTags;
                this.lastSearchedFuzzy = newSearchTermWithoutTags.replace(/\s/g, '');
                const wasFiltered = this._isFiltered;
                this._isFiltered = newSearchTerm.length > 2;
                if (this._isFiltered) {
                    // Search results span all categories: drop the category filter and the
                    // now-stale selection so the tree matches the shown results.
                    this._categoryFilterId = undefined;
                    this.clearSelection();
                    this.expandAll();
                }
                else if (browser_1.CompositeTreeNode.is(this.root)) {
                    const root = this.root;
                    // Avoid intermediate selection events while collapsing.
                    this.withSuppressedSelection(() => this.collapseAll(root));
                    if (wasFiltered) {
                        this.selectDefaultCategory();
                    }
                }
                this.updateFilteredRows(PreferenceFilterChangeSource.Search);
            }),
            this.onFilterChanged(() => {
                this.filterInput.updateResultsCount(this._totalVisibleLeaves);
            }),
            this.onTreeFilterChangedEmitter,
        ]);
        await this.preferenceService.ready;
        this.handleNewSchema(this.treeGenerator.root);
    }
    handleNewSchema(newRoot) {
        this.root = newRoot;
        if (this._categoryFilterId && !this.getNode(this._categoryFilterId)) {
            this._categoryFilterId = undefined;
        }
        if (this.isFiltered) {
            this.expandAll();
        }
        this.updateFilteredRows(PreferenceFilterChangeSource.Schema);
        this.restoreSelectionInNewTree();
        this.ensureSelectedCategoryHasVisibleSettings();
        this.applyInitialSelection();
    }
    /**
     * Re-applies the selection after the tree has been rebuilt with new node instances,
     * e.g. when plugins contribute preferences after startup. The selection state resolves
     * nodes by id, but the rebuilt node lacks the `selected` flag that drives the tree
     * highlight. If the selected node is gone from the new schema, falls back to the
     * default category.
     */
    restoreSelectionInNewTree() {
        if (!this.lastSelectionId) {
            return;
        }
        const node = this.getNode(this.lastSelectionId);
        if (node && browser_1.SelectableTreeNode.is(node)) {
            if (!node.selected) {
                this.selectPreservingCategoryFilter(node);
            }
        }
        else {
            this.clearSelection();
            this._initialSelectionApplied = false;
        }
    }
    applyInitialSelection() {
        if (this._initialSelectionApplied) {
            return;
        }
        if (this.selectedNodes.length > 0) {
            // Something is already selected, e.g. by the user before the schema change.
            this._initialSelectionApplied = true;
            return;
        }
        if (this._isFiltered) {
            // A search (e.g. restored on startup) is active; the default selection is
            // applied when it is cleared instead.
            return;
        }
        if (this.selectDefaultCategory()) {
            this._initialSelectionApplied = true;
        }
    }
    /**
     * Selects the 'Commonly Used' category, the default detail page of the settings editor.
     * @returns `true` if the category was found and selected.
     */
    selectDefaultCategory() {
        const commonlyUsed = this.getNode(COMMONLY_USED_NODE_ID);
        if (commonlyUsed && browser_1.SelectableTreeNode.is(commonlyUsed)) {
            this.selectNode(commonlyUsed);
            return true;
        }
        return false;
    }
    /**
     * Falls back to the default category when the selected category has no settings left to
     * show, e.g. after switching to a scope in which none of its settings are valid. Otherwise
     * the editor would show an empty page for a category the tree no longer lists. Clears the
     * selection instead if the default category has no settings to show either.
     */
    ensureSelectedCategoryHasVisibleSettings() {
        if (!this._categoryFilterId || this.hasVisibleSettings(this._categoryFilterId)) {
            return;
        }
        if (this.hasVisibleSettings(COMMONLY_USED_NODE_ID)) {
            this.selectDefaultCategory();
        }
        else {
            this.clearSelection();
        }
    }
    hasVisibleSettings(categoryId) {
        return !!this._currentRows.get(categoryId)?.visibleChildren;
    }
    updateRows() {
        const root = this.root;
        this._currentRows = new Map();
        if (root) {
            this._totalVisibleLeaves = 0;
            let index = 0;
            for (const node of new browser_1.TopDownTreeIterator(root, {
                pruneCollapsed: false,
                pruneSiblings: true
            })) {
                if (browser_1.TreeNode.isVisible(node) && preference_types_1.Preference.TreeNode.is(node)) {
                    const { id } = preference_types_1.Preference.TreeNode.getGroupAndIdFromNodeId(node.id);
                    if (browser_1.CompositeTreeNode.is(node) || this.passesCurrentFilters(node, id)) {
                        this.updateVisibleChildren(node);
                        this._currentRows.set(node.id, {
                            index: index++,
                            node,
                            depth: node.depth,
                            visibleChildren: 0,
                        });
                    }
                }
            }
        }
    }
    updateFilteredRows(source) {
        this.updateRows();
        this.onTreeFilterChangedEmitter.fire({ source });
    }
    passesCurrentFilters(node, prefID) {
        if (!this.schemaProvider.isValidInScope(prefID, this._currentScope)) {
            return false;
        }
        // Hidden preferences (e.g. AI preferences moved to the AI Configuration view) must not surface in search.
        if (node.preference.data.hidden) {
            return false;
        }
        if (!this._isFiltered) {
            return true;
        }
        // When filtering, VSCode will render an item that is present in the commonly used section only once but render both its possible parents in the left-hand tree.
        // E.g. searching for editor.renderWhitespace will show one item in the main panel, but both 'Commonly Used' and 'Text Editor' in the left tree.
        // That seems counterintuitive and introduces a number of special cases, so I prefer to remove the commonly used section entirely when the user searches.
        if (node.id.startsWith(preference_layout_1.COMMONLY_USED_SECTION_PREFIX)) {
            return false;
        }
        if (!this.lastSearchedTags.every(tag => node.preference.data.tags?.includes(tag))) {
            return false;
        }
        return fuzzy.test(this.lastSearchedFuzzy, prefID) // search matches preference name.
            // search matches description. Fuzzy isn't ideal here because the score depends on the order of discovery.
            || (node.preference.data.description ?? '').includes(this.lastSearchedLiteral);
    }
    isVisibleSelectableNode(node) {
        return browser_1.CompositeTreeNode.is(node) && !!this._currentRows.get(node.id)?.visibleChildren;
    }
    updateVisibleChildren(node) {
        if (!browser_1.CompositeTreeNode.is(node)) {
            this._totalVisibleLeaves++;
            let nextParent = node.parent?.id && this._currentRows.get(node.parent?.id);
            while (nextParent && nextParent.node !== this.root) {
                if (nextParent) {
                    nextParent.visibleChildren += 1;
                }
                nextParent = nextParent.node.parent?.id && this._currentRows.get(nextParent.node.parent?.id);
                if (nextParent) {
                    nextParent.isExpansible = true;
                }
            }
        }
    }
    collapseAllExcept(openNode) {
        const openNodes = [];
        while (browser_1.ExpandableTreeNode.is(openNode)) {
            openNodes.push(openNode);
            this.expandNode(openNode);
            openNode = openNode.parent;
        }
        if (browser_1.CompositeTreeNode.is(this.root)) {
            this.root.children.forEach(child => {
                if (!openNodes.includes(child) && browser_1.ExpandableTreeNode.is(child)) {
                    this.collapseNode(child);
                }
            });
        }
    }
    expandAll() {
        if (browser_1.CompositeTreeNode.is(this.root)) {
            this.root.children.forEach(child => {
                if (browser_1.ExpandableTreeNode.is(child)) {
                    this.expandNode(child);
                }
            });
        }
    }
    selectNode(node) {
        if (!this._suppressSelection) {
            super.selectNode(node);
        }
    }
    withSuppressedSelection(fn) {
        this._suppressSelection = true;
        try {
            fn();
        }
        finally {
            this._suppressSelection = false;
        }
    }
    getNodeFromPreferenceId(id) {
        const node = this.getNode(this.treeGenerator.getNodeId(id));
        return node && preference_types_1.Preference.TreeNode.is(node) ? node : undefined;
    }
    /**
     * Returns the id of the nearest composite (category) ancestor of `node`,
     * inclusive of `node` itself. Returns `undefined` if no category ancestor is found.
     */
    categoryIdForSelection(node) {
        let current = node;
        while (current) {
            if (preference_types_1.Preference.TreeNode.is(current) && preference_types_1.Preference.CompositeTreeNode.is(current)) {
                return current.id;
            }
            current = current.parent;
        }
        return undefined;
    }
    /**
     * Selects `node` to mirror the editor's scroll position in the tree. Unlike an explicit
     * selection, this does not change the category filter: scrolling must never narrow the
     * settings editor, only an explicit selection may.
     * @returns true if selection changed, false otherwise
     */
    selectIfNotSelected(node) {
        const currentlySelected = this.selectedNodes[0];
        if (!node.selected || node !== currentlySelected) {
            this.selectPreservingCategoryFilter(node);
            return true;
        }
        return false;
    }
    selectPreservingCategoryFilter(node) {
        this.preservingCategoryFilter = true;
        try {
            node.selected = true;
            this.selectNode(node);
        }
        finally {
            this.preservingCategoryFilter = false;
        }
    }
};
exports.PreferenceTreeModel = PreferenceTreeModel;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], PreferenceTreeModel.prototype, "schemaProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_searchbar_widget_1.PreferencesSearchbarWidget),
    tslib_1.__metadata("design:type", preference_searchbar_widget_1.PreferencesSearchbarWidget)
], PreferenceTreeModel.prototype, "filterInput", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_tree_generator_1.PreferenceTreeGenerator),
    tslib_1.__metadata("design:type", preference_tree_generator_1.PreferenceTreeGenerator)
], PreferenceTreeModel.prototype, "treeGenerator", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_scope_tabbar_widget_1.PreferencesScopeTabBar),
    tslib_1.__metadata("design:type", preference_scope_tabbar_widget_1.PreferencesScopeTabBar)
], PreferenceTreeModel.prototype, "scopeTracker", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], PreferenceTreeModel.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PreferenceTreeModel.prototype, "init", null);
exports.PreferenceTreeModel = PreferenceTreeModel = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceTreeModel);
//# sourceMappingURL=preference-tree-model.js.map