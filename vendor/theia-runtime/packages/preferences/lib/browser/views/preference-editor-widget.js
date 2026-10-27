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
var PreferencesEditorWidget_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreferencesEditorWidget = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const inversify_1 = require("@theia/core/shared/inversify");
const throttle = require("@theia/core/shared/lodash.throttle");
const deepEqual = require("fast-deep-equal");
const browser_1 = require("@theia/core/lib/browser");
const core_1 = require("@theia/core");
const widget_1 = require("@theia/core/lib/browser/widgets/widget");
const preference_tree_model_1 = require("../preference-tree-model");
const preference_node_renderer_1 = require("./components/preference-node-renderer");
const preference_types_1 = require("../util/preference-types");
const preference_scope_tabbar_widget_1 = require("./preference-scope-tabbar-widget");
const preference_node_renderer_creator_1 = require("./components/preference-node-renderer-creator");
const preference_layout_1 = require("../util/preference-layout");
let PreferencesEditorWidget = class PreferencesEditorWidget extends widget_1.BaseWidget {
    constructor() {
        super(...arguments);
        this.scrollOptions = widget_1.DEFAULT_SCROLL_OPTIONS;
        /**
         * Guards against scroll events and selection events looping into each other. Set before this widget initiates a selection.
         */
        this.currentModelSelectionId = '';
        /**
         * Permits the user to expand multiple nodes without each one being collapsed on a new selection.
         */
        this.lastUserSelection = '';
        this.isAtScrollTop = true;
        this.firstVisibleChildID = '';
        /**
         * Tracks the node ID of the preference row the user last focused.
         * Used to scroll back to that preference when the search filter is cleared.
         */
        this.lastFocusedRendererNodeId = '';
        this.renderers = new Map();
        this.preferenceDataKeys = new Map();
        // The commonly used section will duplicate preference ID's, so we'll keep a separate list of them.
        this.commonlyUsedRenderers = new Map();
        this.onScroll = throttle(this.doOnScroll.bind(this), 50);
        this.shouldUpdateModelSelection = true;
    }
    static { PreferencesEditorWidget_1 = this; }
    static { this.ID = 'settings.editor'; }
    static { this.LABEL = core_1.nls.localizeByDefault('Settings Editor'); }
    init() {
        this.doInit();
    }
    async doInit() {
        this.id = PreferencesEditorWidget_1.ID;
        this.title.label = PreferencesEditorWidget_1.LABEL;
        this.addClass('settings-main');
        this.toDispose.pushAll([
            this.subscribeToPreferenceProviderChanges(),
            this.model.onFilterChanged(e => this.handleDisplayChange(e)),
            this.model.onSelectionChanged(e => this.handleSelectionChange(e)),
        ]);
        this.createContainers();
        await this.preferenceService.ready;
        this.handleDisplayChange({ source: preference_tree_model_1.PreferenceFilterChangeSource.Schema });
        this.rendererRegistry.onDidChange(() => this.handleRegistryChange());
    }
    createContainers() {
        const innerWrapper = document.createElement('div');
        innerWrapper.classList.add('settings-main-scroll-container');
        this.scrollContainer = innerWrapper;
        innerWrapper.addEventListener('scroll', this.onScroll, { passive: true });
        innerWrapper.addEventListener('focusin', e => {
            const target = e.target;
            if (target instanceof HTMLElement) {
                const prefRow = target.closest('.single-pref');
                const nodeId = prefRow?.getAttribute('data-node-id');
                if (nodeId) {
                    this.lastFocusedRendererNodeId = nodeId;
                }
            }
        });
        this.node.appendChild(innerWrapper);
        const noLeavesMessage = document.createElement('div');
        noLeavesMessage.classList.add('settings-no-results-announcement');
        noLeavesMessage.textContent = core_1.nls.localizeByDefault('No Settings Found');
        this.node.appendChild(noLeavesMessage);
    }
    subscribeToPreferenceProviderChanges() {
        const res = new core_1.DisposableCollection();
        for (const scope of this.schemaProvider.validScopes) {
            const provider = this.providerProvider(scope);
            if (!provider) {
                continue;
            }
            provider.onDidPreferencesChanged(e => this.handlePreferenceChanges(e), this, res);
        }
        return res;
    }
    handleDisplayChange(e) {
        const { isFiltered } = this.model;
        const leavesAreVisible = this.areLeavesVisible();
        // Capture scroll target before handlers modify visibility / DOM layout.
        const scrollTarget = this.getScrollTarget(e.source);
        if (e.source === preference_tree_model_1.PreferenceFilterChangeSource.Search) {
            this.handleSearchChange(isFiltered, leavesAreVisible);
        }
        else if (e.source === preference_tree_model_1.PreferenceFilterChangeSource.Category) {
            this.handleCategoryChange(isFiltered, leavesAreVisible);
        }
        else if (e.source === preference_tree_model_1.PreferenceFilterChangeSource.Scope) {
            this.handleScopeChange(isFiltered);
        }
        else if (e.source === preference_tree_model_1.PreferenceFilterChangeSource.Schema) {
            this.handleSchemaChange(isFiltered);
        }
        else {
            (0, core_1.unreachable)(e.source, 'Not all PreferenceFilterChangeSource enum variants handled.');
        }
        // Only sync the tree to a row that is still shown. A row hidden by the change, e.g. because
        // it is not valid in the new scope or lies outside the selected category, must not pull the
        // tree selection away from the page that is shown.
        if (scrollTarget && this.isRendererVisible(scrollTarget)) {
            this.showInTree(scrollTarget);
        }
        this.resetScroll(scrollTarget);
        this.pinCategoryHeaders();
        if (e.source === preference_tree_model_1.PreferenceFilterChangeSource.Search) {
            // Reset focus if search context changes.
            this.lastFocusedRendererNodeId = '';
        }
    }
    getScrollTarget(source) {
        if (source === preference_tree_model_1.PreferenceFilterChangeSource.Category) {
            // A newly selected category always opens at its top. Scrolling back to the last focused
            // control would re-select its (previous) category in the tree and desync tree and editor.
            return undefined;
        }
        if (source !== preference_tree_model_1.PreferenceFilterChangeSource.Search) {
            return this.firstVisibleChildID;
        }
        if (!this.model.isFiltered && this.lastFocusedRendererNodeId && this.isRendererInViewport(this.lastFocusedRendererNodeId)) {
            return this.lastFocusedRendererNodeId;
        }
        return undefined;
    }
    isRendererVisible(nodeId) {
        const { id, collection } = this.analyzeIDAndGetRendererGroup(nodeId);
        return !!collection.get(id)?.visible;
    }
    isRendererInViewport(nodeId) {
        const { id, collection } = this.analyzeIDAndGetRendererGroup(nodeId);
        const renderer = collection.get(id);
        if (!renderer?.visible) {
            return false;
        }
        const scrollTop = this.scrollContainer.scrollTop;
        const viewportBottom = scrollTop + this.scrollContainer.clientHeight;
        const elementTop = renderer.node.offsetTop;
        const elementBottom = elementTop + renderer.node.offsetHeight;
        return elementTop < viewportBottom && elementBottom > scrollTop;
    }
    handleRegistryChange() {
        for (const [id, renderer, collection] of this.allRenderers()) {
            renderer.dispose();
            collection.delete(id);
        }
        this.handleDisplayChange({ source: preference_tree_model_1.PreferenceFilterChangeSource.Schema });
    }
    handleSchemaChange(isFiltered) {
        for (const [id, renderer, collection] of this.allRenderers()) {
            const node = this.model.getNode(renderer.nodeId);
            if (!node || (preference_types_1.Preference.LeafNode.is(node) && this.hasSchemaChanged(renderer, node))) {
                renderer.dispose();
                collection.delete(id);
            }
        }
        if (this.model.root) {
            const nodeIterator = Array.from(this.scrollContainer.children)[Symbol.iterator]();
            let nextNode = nodeIterator.next().value;
            for (const node of new browser_1.TopDownTreeIterator(this.model.root)) {
                if (preference_types_1.Preference.TreeNode.is(node)) {
                    const { collection, id } = this.analyzeIDAndGetRendererGroup(node.id);
                    const renderer = collection.get(id) ?? this.rendererFactory(node);
                    if (!renderer.node.parentElement) { // If it hasn't been attached yet, it hasn't been checked for the current search.
                        this.hideIfFailsFilters(renderer, isFiltered);
                        collection.set(id, renderer);
                    }
                    if (nextNode !== renderer.node) {
                        if (nextNode) {
                            renderer.insertBefore(nextNode);
                        }
                        else {
                            renderer.appendTo(this.scrollContainer);
                        }
                    }
                    else {
                        nextNode = nodeIterator.next().value;
                    }
                }
            }
        }
    }
    handleScopeChange(isFiltered = this.model.isFiltered) {
        for (const [, renderer] of this.allRenderers()) {
            const isHidden = this.hideIfFailsFilters(renderer, isFiltered);
            if (isFiltered || !isHidden) {
                renderer.handleScopeChange?.(isFiltered);
            }
        }
    }
    hasSchemaChanged(renderer, node) {
        return !deepEqual(renderer.schema, node.preference.data);
    }
    handleSearchChange(isFiltered, leavesAreVisible) {
        if (leavesAreVisible) {
            for (const [, renderer] of this.allRenderers()) {
                const isHidden = this.hideIfFailsFilters(renderer, isFiltered);
                if (!isHidden) {
                    renderer.handleSearchChange?.(isFiltered);
                }
            }
        }
    }
    handleCategoryChange(isFiltered, leavesAreVisible) {
        if (leavesAreVisible) {
            for (const [, renderer] of this.allRenderers()) {
                this.hideIfFailsFilters(renderer, isFiltered);
            }
        }
    }
    areLeavesVisible() {
        const leavesAreVisible = this.model.totalVisibleLeaves > 0;
        this.node.classList.toggle('no-results', !leavesAreVisible);
        this.scrollContainer.classList.toggle('hidden', !leavesAreVisible);
        return leavesAreVisible;
    }
    *allRenderers() {
        for (const [id, renderer] of this.commonlyUsedRenderers.entries()) {
            yield [id, renderer, this.commonlyUsedRenderers];
        }
        for (const [id, renderer] of this.renderers.entries()) {
            yield [id, renderer, this.renderers];
        }
    }
    handlePreferenceChanges(e) {
        for (const id of Object.keys(e)) {
            this.commonlyUsedRenderers.get(id)?.handleValueChange?.();
            this.renderers.get(id)?.handleValueChange?.();
        }
    }
    /**
     * Returns true if a category filter is active and `node` is outside the visible slice:
     * not the selected category itself, not a descendant of it, and not one of its
     * composite ancestors (whose headers we keep visible above the selected category).
     * Keeps the left tree intact (filtering is applied here, not in the model).
     */
    isOutsideSelectedCategory(node) {
        const categoryId = this.model.categoryFilterId;
        if (!categoryId || node.id === categoryId) {
            return false;
        }
        const category = this.model.getNode(categoryId);
        if (!browser_1.CompositeTreeNode.is(category) || browser_1.CompositeTreeNode.isAncestor(category, node)) {
            return false;
        }
        return !(browser_1.CompositeTreeNode.is(node) && browser_1.CompositeTreeNode.isAncestor(node, category));
    }
    /**
     * @returns true if the renderer is hidden, false otherwise.
     */
    hideIfFailsFilters(renderer, isFiltered) {
        const row = this.model.currentRows.get(renderer.nodeId);
        if (!row || (browser_1.CompositeTreeNode.is(row.node) && (isFiltered || row.visibleChildren === 0)) || this.isOutsideSelectedCategory(row.node)) {
            renderer.hide();
            return true;
        }
        else {
            renderer.show();
            return false;
        }
    }
    /**
     * Pins category header rows to the top of the scroll container via `position: sticky`.
     * The headers of the selected category and its ancestors are stacked on top of each
     * other; the headers of its subsections all share the single slot below that stack, so
     * the subsection currently scrolled into view replaces the previous one instead of the
     * headers piling up. Clears the styles when no category filter is active.
     */
    pinCategoryHeaders() {
        requestAnimationFrame(() => {
            const categoryId = this.model.categoryFilterId;
            const stackedHeaders = this.getStackedHeaderRenderers();
            // Read all heights before writing any styles, so that the layout is computed only once.
            const heights = stackedHeaders.map(renderer => renderer.node.offsetHeight);
            const stackedTops = new Map();
            let stackHeight = 0;
            stackedHeaders.forEach((renderer, index) => {
                stackedTops.set(renderer.nodeId, stackHeight);
                stackHeight += heights[index];
            });
            for (const [, renderer] of this.allRenderers()) {
                if (!browser_1.CompositeTreeNode.is(this.model.getNode(renderer.nodeId))) {
                    continue;
                }
                const wrapper = renderer.node;
                if (categoryId && renderer.visible) {
                    wrapper.classList.add('theia-settings-pinned-category-header');
                    wrapper.style.top = `${stackedTops.get(renderer.nodeId) ?? stackHeight}px`;
                }
                else {
                    wrapper.classList.remove('theia-settings-pinned-category-header');
                    wrapper.style.top = '';
                }
            }
        });
    }
    /**
     * @returns the visible header renderers of the selected category and its ancestors,
     * outermost first, i.e. in document order. Empty if no category filter is active.
     */
    getStackedHeaderRenderers() {
        const renderers = [];
        const categoryId = this.model.categoryFilterId;
        if (!categoryId) {
            return renderers;
        }
        for (let node = this.model.getNode(categoryId); node && preference_types_1.Preference.TreeNode.is(node); node = node.parent) {
            const { id, collection } = this.analyzeIDAndGetRendererGroup(node.id);
            const renderer = collection.get(id);
            if (renderer?.visible) {
                renderers.unshift(renderer);
            }
        }
        return renderers;
    }
    /**
     * @returns the total height of the pinned header stack, i.e. the space at the top of the
     * scroll container that is covered by the headers of the selected category and its ancestors.
     */
    getStackedHeaderHeight(stackedHeaders = this.getStackedHeaderRenderers()) {
        return stackedHeaders.reduce((height, renderer) => height + renderer.node.offsetHeight, 0);
    }
    resetScroll(nodeIDToScrollTo) {
        if (this.scrollBar) { // Absent on widget creation
            this.doResetScroll(nodeIDToScrollTo);
        }
        else {
            const interval = setInterval(() => {
                if (this.scrollBar) {
                    clearInterval(interval);
                    this.doResetScroll(nodeIDToScrollTo);
                }
            }, 500);
        }
    }
    doResetScroll(nodeIDToScrollTo) {
        requestAnimationFrame(() => {
            this.scrollBar?.update();
            if (nodeIDToScrollTo) {
                const { id, collection } = this.analyzeIDAndGetRendererGroup(nodeIDToScrollTo);
                const renderer = collection.get(id);
                if (renderer?.visible) {
                    // Place the target right below the pinned category headers, not behind them.
                    this.scrollContainer.scrollTo(0, renderer.node.offsetTop - this.getStackedHeaderHeight());
                    return;
                }
            }
            this.scrollContainer.scrollTop = 0;
        });
    }
    ;
    doOnScroll() {
        const { scrollContainer } = this;
        const firstVisibleChildID = this.findFirstVisibleChildID();
        this.setFirstVisibleChildID(firstVisibleChildID);
        if (this.isAtScrollTop && scrollContainer.scrollTop !== 0) {
            this.isAtScrollTop = false;
            this.tabbar.toggleShadow(true);
        }
        else if (!this.isAtScrollTop && scrollContainer.scrollTop === 0) {
            this.isAtScrollTop = true;
            this.tabbar.toggleShadow(false);
        }
    }
    ;
    findFirstVisibleChildID() {
        // The pinned headers of the selected category and its ancestors always sit at the top of
        // the scroll container. Skip them and look for the first row right below the stack,
        // otherwise the outermost ancestor would always be reported and the tree selection would
        // jump from the selected sub-category to its parent.
        const stackedHeaders = this.getStackedHeaderRenderers();
        const stackBottom = this.scrollContainer.scrollTop + this.getStackedHeaderHeight(stackedHeaders);
        for (const [, renderer] of this.allRenderers()) {
            const { offsetTop, offsetHeight, offsetParent } = renderer.node;
            // Skip hidden renderers (display:none): they report offsetTop/offsetHeight 0
            // and would otherwise match scrollTop===0, hijacking the selection back to
            // the first hidden category.
            if (!offsetParent || stackedHeaders.includes(renderer)) {
                continue;
            }
            if (Math.abs(offsetTop - stackBottom) <= offsetHeight / 2) {
                return renderer.nodeId;
            }
        }
    }
    setFirstVisibleChildID(id) {
        if (id && id !== this.firstVisibleChildID) {
            this.firstVisibleChildID = id;
            if (!this.shouldUpdateModelSelection) {
                return;
            }
            this.showInTree(id);
        }
    }
    showInTree(id) {
        let currentNode = this.model.getNode(id);
        let expansionAncestor;
        let selectionAncestor;
        while (currentNode && (!expansionAncestor || !selectionAncestor)) {
            if (!selectionAncestor && browser_1.SelectableTreeNode.is(currentNode)) {
                selectionAncestor = currentNode;
            }
            if (!expansionAncestor && browser_1.ExpandableTreeNode.is(currentNode)) {
                expansionAncestor = currentNode;
            }
            currentNode = currentNode.parent;
        }
        if (selectionAncestor) {
            this.currentModelSelectionId = selectionAncestor.id;
            expansionAncestor = expansionAncestor ?? selectionAncestor;
            this.model.selectIfNotSelected(selectionAncestor);
            if (!this.model.isFiltered && id !== this.lastUserSelection) {
                this.lastUserSelection = '';
                this.model.collapseAllExcept(expansionAncestor);
            }
        }
    }
    handleSelectionChange(selectionEvent) {
        const node = selectionEvent[0];
        if (node && node.id !== this.currentModelSelectionId) {
            this.currentModelSelectionId = node.id;
            this.lastUserSelection = node.id;
            if (this.model.isFiltered && browser_1.CompositeTreeNode.is(node)) {
                for (const candidate of new browser_1.TopDownTreeIterator(node, { pruneSiblings: true })) {
                    const { id, collection } = this.analyzeIDAndGetRendererGroup(candidate.id);
                    const renderer = collection.get(id);
                    if (renderer?.visible) {
                        // When filtered, treat the first visible child as the selected node, since it will be the one scrolled to.
                        this.lastUserSelection = renderer.nodeId;
                        this.scrollWithoutModelUpdate(renderer.node);
                        return;
                    }
                }
            }
            else {
                const { id, collection } = this.analyzeIDAndGetRendererGroup(node.id);
                const renderer = collection.get(id);
                this.scrollWithoutModelUpdate(renderer?.node);
            }
        }
    }
    /** Ensures that we don't set the model's selection while attempting to scroll in reaction to a model selection change. */
    scrollWithoutModelUpdate(node) {
        if (!node) {
            return;
        }
        this.shouldUpdateModelSelection = false;
        this.scrollContainer.scrollTo(0, node.offsetTop);
        requestAnimationFrame(() => this.shouldUpdateModelSelection = true);
    }
    analyzeIDAndGetRendererGroup(nodeID) {
        const { id, group } = preference_types_1.Preference.TreeNode.getGroupAndIdFromNodeId(nodeID);
        const collection = group === preference_layout_1.COMMONLY_USED_SECTION_PREFIX ? this.commonlyUsedRenderers : this.renderers;
        return { id, group, collection };
    }
    getScrollContainer() {
        return this.scrollContainer;
    }
};
exports.PreferencesEditorWidget = PreferencesEditorWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], PreferencesEditorWidget.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_tree_model_1.PreferenceTreeModel),
    tslib_1.__metadata("design:type", preference_tree_model_1.PreferenceTreeModel)
], PreferencesEditorWidget.prototype, "model", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_node_renderer_1.PreferenceNodeRendererFactory),
    tslib_1.__metadata("design:type", Function)
], PreferencesEditorWidget.prototype, "rendererFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_node_renderer_creator_1.PreferenceNodeRendererCreatorRegistry),
    tslib_1.__metadata("design:type", Object)
], PreferencesEditorWidget.prototype, "rendererRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceSchemaService),
    tslib_1.__metadata("design:type", Object)
], PreferencesEditorWidget.prototype, "schemaProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(preference_scope_tabbar_widget_1.PreferencesScopeTabBar),
    tslib_1.__metadata("design:type", preference_scope_tabbar_widget_1.PreferencesScopeTabBar)
], PreferencesEditorWidget.prototype, "tabbar", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceProviderProvider),
    tslib_1.__metadata("design:type", Function)
], PreferencesEditorWidget.prototype, "providerProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PreferencesEditorWidget.prototype, "init", null);
exports.PreferencesEditorWidget = PreferencesEditorWidget = PreferencesEditorWidget_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferencesEditorWidget);
//# sourceMappingURL=preference-editor-widget.js.map