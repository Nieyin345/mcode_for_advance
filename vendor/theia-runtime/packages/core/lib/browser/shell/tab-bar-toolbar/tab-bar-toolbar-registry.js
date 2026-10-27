"use strict";
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
exports.TabBarToolbarRegistry = exports.TabBarToolbarContribution = void 0;
const tslib_1 = require("tslib");
const debounce = require("lodash.debounce");
const inversify_1 = require("inversify");
// eslint-disable-next-line max-len
const common_1 = require("../../../common");
const context_key_service_1 = require("../../context-key-service");
const navigatable_types_1 = require("../../navigatable-types");
const resource_context_key_1 = require("../../resource-context-key");
const widget_context_key_contribution_1 = require("../../widget-context-key-contribution");
const tab_bar_toolbar_types_1 = require("./tab-bar-toolbar-types");
const tab_bar_toolbar_menu_adapters_1 = require("./tab-bar-toolbar-menu-adapters");
const keybinding_1 = require("../../keybinding");
const label_parser_1 = require("../../label-parser");
const context_menu_renderer_1 = require("../../context-menu-renderer");
const menu_1 = require("../../../common/menu");
const tab_toolbar_item_1 = require("./tab-toolbar-item");
/**
 * Clients should implement this interface if they want to contribute to the tab-bar toolbar.
 */
exports.TabBarToolbarContribution = Symbol('TabBarToolbarContribution');
const menuDelegateSeparator = '=@=';
/**
 * Main, shared registry for tab-bar toolbar items.
 */
let TabBarToolbarRegistry = class TabBarToolbarRegistry {
    constructor() {
        this.items = new Map();
        this.menuDelegates = new Map();
        this.onDidChangeEmitter = new common_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        // debounce in order to avoid to fire more than once in the same tick
        this.fireOnDidChange = debounce(() => this.onDidChangeEmitter.fire(undefined), 0);
    }
    onStart() {
        const contributions = this.contributionProvider.getContributions();
        for (const contribution of contributions) {
            contribution.registerToolbarItems(this);
        }
    }
    /**
     * Registers the given item. Throws an error, if the corresponding command cannot be found or an item has been already registered for the desired command.
     *
     * @param item the item to register.
     */
    registerItem(item) {
        if (tab_bar_toolbar_types_1.ReactTabBarToolbarAction.is(item)) {
            return this.doRegisterItem(new tab_toolbar_item_1.ReactToolbarItemImpl(this.commandRegistry, this.contextKeyService, item));
        }
        else {
            if (item.menuPath) {
                return this.doRegisterItem(new tab_bar_toolbar_menu_adapters_1.ToolbarActionWrapper(item.menuPath, this.commandRegistry, this.menuRegistry, this.contextKeyService, this.contextMenuRenderer, item));
            }
            else {
                const wrapper = new tab_toolbar_item_1.RenderedToolbarItemImpl(this.commandRegistry, this.contextKeyService, this.keybindingRegistry, this.labelParser, item);
                const disposables = this.doRegisterItem(wrapper);
                disposables.push(wrapper);
                return disposables;
            }
        }
    }
    doRegisterItem(item) {
        if (this.items.has(item.id)) {
            throw new Error(`A toolbar item is already registered with the '${item.id}' ID.`);
        }
        this.items.set(item.id, item);
        this.fireOnDidChange();
        const toDispose = new common_1.DisposableCollection(common_1.Disposable.create(() => {
            this.items.delete(item.id);
            this.fireOnDidChange();
        }));
        if (item.onDidChange) {
            toDispose.push(item.onDidChange(() => this.fireOnDidChange()));
        }
        return toDispose;
    }
    /**
     * Returns an array of tab-bar toolbar items which are visible when the `widget` argument is the current one.
     *
     * By default returns with all items where the command is enabled and `item.isVisible` is `true`.
     */
    visibleItems(widget) {
        if (widget.isDisposed) {
            return [];
        }
        const result = [];
        const contextMatcher = this.contextMatcherFor(widget);
        for (const item of this.items.values()) {
            if (item.isVisible(widget, contextMatcher)) {
                result.push(item);
            }
        }
        for (const delegate of this.menuDelegates.values()) {
            if (delegate.isVisible(widget)) {
                const menu = this.menuRegistry.getMenu(delegate.menuPath);
                if (menu) {
                    for (const child of menu.children) {
                        if (child.isVisible([...delegate.menuPath, child.id], contextMatcher, widget.node, widget)) {
                            if (menu_1.CompoundMenuNode.is(child)) {
                                for (const grandchild of child.children) {
                                    if (grandchild.isVisible([...delegate.menuPath, child.id, grandchild.id], contextMatcher, widget.node, widget) && menu_1.RenderedMenuNode.is(grandchild)) {
                                        if (menu_1.CommandMenu.is(grandchild)) {
                                            result.push(new tab_bar_toolbar_menu_adapters_1.CommandMenuAsToolbarItemWrapper([...delegate.menuPath, child.id, grandchild.id], this.commandRegistry, this.menuRegistry, this.contextKeyService, this.contextMenuRenderer, grandchild, child.id));
                                        }
                                        else if (menu_1.CompoundMenuNode.is(grandchild)) {
                                            result.push(new tab_bar_toolbar_menu_adapters_1.SubmenuAsToolbarItemWrapper([...delegate.menuPath, child.id, grandchild.id], this.commandRegistry, this.menuRegistry, this.contextKeyService, this.contextMenuRenderer, grandchild, child.id));
                                        }
                                    }
                                }
                            }
                            else if (menu_1.CommandMenu.is(child)) {
                                result.push(new tab_bar_toolbar_menu_adapters_1.CommandMenuAsToolbarItemWrapper([...delegate.menuPath, child.id], this.commandRegistry, this.menuRegistry, this.contextKeyService, this.contextMenuRenderer, child, undefined));
                            }
                        }
                    }
                }
            }
        }
        return result;
    }
    /**
     * A matcher that evaluates `when` clauses against the given widget rather than against whichever widget
     * currently holds the focus. Keys that describe no aspect of the widget keep their ambient value, and the
     * context scoped to the widget's DOM node is still consulted for the keys the overlay does not define.
     */
    contextMatcherFor(widget) {
        const overlay = new Map();
        if (navigatable_types_1.Navigatable.is(widget)) {
            for (const [key, value] of Object.entries(this.resourceContextKey.toValues(widget.getResourceUri()))) {
                overlay.set(key, value);
            }
        }
        for (const contribution of this.contextKeyContributionProvider.getContributions()) {
            const entries = contribution.getContextKeyValues(widget);
            if (entries) {
                for (const [key, value] of entries) {
                    overlay.set(key, value);
                }
            }
        }
        return overlay.size ? this.contextKeyService.createOverlay(overlay) : this.contextKeyService;
    }
    /**
     * Collects all context keys referenced by toolbar items and delegated menu nodes
     * that may participate in rendering for the given widget.
     */
    collectContextKeys(widget) {
        const contextKeys = new Set();
        if (widget.isDisposed) {
            return contextKeys;
        }
        for (const item of this.items.values()) {
            if (item.when) {
                this.contextKeyService.parseKeys(item.when)?.forEach(key => contextKeys.add(key));
            }
        }
        for (const delegate of this.menuDelegates.values()) {
            if (!delegate.isVisible(widget)) {
                continue;
            }
            const menu = this.menuRegistry.getMenu(delegate.menuPath);
            if (menu) {
                this.collectMenuContextKeys(menu, contextKeys);
            }
        }
        return contextKeys;
    }
    collectMenuContextKeys(menuNode, contextKeys) {
        if (menuNode.when) {
            this.contextKeyService.parseKeys(menuNode.when)?.forEach(key => contextKeys.add(key));
        }
        if (menu_1.CompoundMenuNode.is(menuNode)) {
            for (const child of menuNode.children) {
                this.collectMenuContextKeys(child, contextKeys);
            }
        }
    }
    unregisterItem(id) {
        if (this.items.delete(id)) {
            this.fireOnDidChange();
        }
    }
    registerMenuDelegate(menuPath, when) {
        const id = this.toElementId(menuPath);
        if (!this.menuDelegates.has(id)) {
            this.menuDelegates.set(id, {
                menuPath, isVisible: (widget) => !when || when(widget)
            });
            this.fireOnDidChange();
            return { dispose: () => this.unregisterMenuDelegate(menuPath) };
        }
        this.logger.warn('Unable to register menu delegate. Delegate has already been registered', menuPath);
        return common_1.Disposable.NULL;
    }
    unregisterMenuDelegate(menuPath) {
        if (this.menuDelegates.delete(this.toElementId(menuPath))) {
            this.fireOnDidChange();
        }
    }
    /**
     * Generate a single ID string from a menu path that
     * is likely to be unique amongst the items in the toolbar.
     *
     * @param menuPath a menubar path
     * @returns a likely unique ID based on the path
     */
    toElementId(menuPath) {
        return menuPath.join(menuDelegateSeparator);
    }
};
exports.TabBarToolbarRegistry = TabBarToolbarRegistry;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandRegistry),
    tslib_1.__metadata("design:type", common_1.CommandRegistry)
], TabBarToolbarRegistry.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], TabBarToolbarRegistry.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", common_1.MenuModelRegistry)
], TabBarToolbarRegistry.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(keybinding_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", keybinding_1.KeybindingRegistry)
], TabBarToolbarRegistry.prototype, "keybindingRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(label_parser_1.LabelParser),
    tslib_1.__metadata("design:type", label_parser_1.LabelParser)
], TabBarToolbarRegistry.prototype, "labelParser", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_menu_renderer_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", context_menu_renderer_1.ContextMenuRenderer)
], TabBarToolbarRegistry.prototype, "contextMenuRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(resource_context_key_1.ResourceContextKey),
    tslib_1.__metadata("design:type", resource_context_key_1.ResourceContextKey)
], TabBarToolbarRegistry.prototype, "resourceContextKey", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ContributionProvider),
    (0, inversify_1.named)(exports.TabBarToolbarContribution),
    tslib_1.__metadata("design:type", Object)
], TabBarToolbarRegistry.prototype, "contributionProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ContributionProvider),
    (0, inversify_1.named)(widget_context_key_contribution_1.WidgetContextKeyContribution),
    tslib_1.__metadata("design:type", Object)
], TabBarToolbarRegistry.prototype, "contextKeyContributionProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ILogger),
    (0, inversify_1.named)('core:TabBarToolbarRegistry'),
    tslib_1.__metadata("design:type", Object)
], TabBarToolbarRegistry.prototype, "logger", void 0);
exports.TabBarToolbarRegistry = TabBarToolbarRegistry = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TabBarToolbarRegistry);
//# sourceMappingURL=tab-bar-toolbar-registry.js.map