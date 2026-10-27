"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolbarActionWrapper = exports.CommandMenuAsToolbarItemWrapper = exports.SubmenuAsToolbarItemWrapper = exports.TOOLBAR_WRAPPER_ID_SUFFIX = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const tab_bar_toolbar_types_1 = require("./tab-bar-toolbar-types");
const tab_bar_toolbar_1 = require("./tab-bar-toolbar");
const widgets_1 = require("../../widgets");
const menu_1 = require("../../../common/menu");
const utils_1 = require("../../menu/utils");
exports.TOOLBAR_WRAPPER_ID_SUFFIX = '-as-tabbar-toolbar-item';
class AbstractToolbarMenuWrapper {
    constructor(effectiveMenuPath, commandRegistry, menuRegistry, contextKeyService, contextMenuRenderer) {
        this.effectiveMenuPath = effectiveMenuPath;
        this.commandRegistry = commandRegistry;
        this.menuRegistry = menuRegistry;
        this.contextKeyService = contextKeyService;
        this.contextMenuRenderer = contextMenuRenderer;
    }
    isEnabled(widget) {
        if (menu_1.CommandMenu.is(this.menuNode)) {
            return this.menuNode.isEnabled(this.effectiveMenuPath, widget);
        }
        return true;
    }
    isToggled(widget) {
        if (menu_1.CommandMenu.is(this.menuNode) && this.menuNode.isToggled) {
            return !!this.menuNode.isToggled(this.effectiveMenuPath, widget);
        }
        return false;
    }
    render(widget, contextMatcher = this.contextKeyService) {
        return this.renderMenuItem(widget, contextMatcher);
    }
    /**
     * Presents the menu to popup on the `event` that is the clicking of
     * a menu toolbar item.
     *
     * @param menuPath the path of the registered menu to show
     * @param event the mouse event triggering the menu
     */
    showPopupMenu(widget, menuPath, event, contextMatcher) {
        event.stopPropagation();
        event.preventDefault();
        const anchor = (0, tab_bar_toolbar_1.toAnchor)(event);
        this.contextMenuRenderer.render({
            menuPath: this.effectiveMenuPath,
            menu: this.menuNode,
            args: [widget],
            anchor,
            context: widget?.node || event.target,
            contextKeyService: contextMatcher,
        });
    }
    /**
     * Renders a toolbar item that is a menu, presenting it as a button with a little
     * chevron decoration that pops up a floating menu when clicked.
     *
     * @param item a toolbar item that is a menu item
     * @param contextMatcher evaluates `when` clauses with the values that describe `widget`, so that the
     * chevron and its popup resolve the same keys as the visibility check.
     * @returns the rendered toolbar item
     */
    renderMenuItem(widget, contextMatcher = this.contextKeyService) {
        const icon = this.icon || 'ellipsis';
        const className = `${icon} ${widgets_1.ACTION_ITEM}`;
        const itemClassName = tab_bar_toolbar_1.TabBarToolbar.Styles.TAB_BAR_TOOLBAR_ITEM + ' enabled menu' + (this.isToggled(widget) ? ' toggled' : '');
        if (menu_1.CompoundMenuNode.is(this.menuNode) && !this.menuNode.isEmpty(this.effectiveMenuPath, contextMatcher, widget.node, widget)) {
            return (0, jsx_runtime_1.jsxs)("div", { className: itemClassName, children: [(0, jsx_runtime_1.jsx)("div", { id: this.id, className: className, title: this.tooltip || this.text, onClick: e => this.executeCommand(widget, e) }), (0, jsx_runtime_1.jsx)("div", { className: widgets_1.ACTION_ITEM, onClick: event => this.showPopupMenu(widget, this.effectiveMenuPath, event, contextMatcher), children: (0, jsx_runtime_1.jsx)("div", { className: (0, widgets_1.codicon)('chevron-down') + ' chevron' }) })] }, this.id);
        }
        else {
            return (0, jsx_runtime_1.jsx)("div", { className: itemClassName, children: (0, jsx_runtime_1.jsx)("div", { id: this.id, className: className, title: this.tooltip || this.text, onClick: e => this.executeCommand(widget, e) }) }, this.id);
        }
    }
}
class SubmenuAsToolbarItemWrapper extends AbstractToolbarMenuWrapper {
    constructor(effectiveMenuPath, commandRegistry, menuRegistry, contextKeyService, contextMenuRenderer, menuNode, group) {
        super(effectiveMenuPath, commandRegistry, menuRegistry, contextKeyService, contextMenuRenderer);
        this.menuNode = menuNode;
        this.group = group;
    }
    get when() {
        return this.menuNode.when;
    }
    executeCommand(widget, e) {
    }
    isVisible(widget, contextMatcher) {
        const menuNodeVisible = this.menuNode.isVisible(this.effectiveMenuPath, contextMatcher, widget.node, widget);
        return menuNodeVisible && !menu_1.MenuModelRegistry.isEmpty(this.menuNode);
    }
    get id() { return this.menuNode.id + exports.TOOLBAR_WRAPPER_ID_SUFFIX; }
    get icon() { return this.menuNode.icon; }
    get tooltip() { return this.menuNode.label; }
    get text() {
        return (this.group === tab_bar_toolbar_types_1.NAVIGATION || this.group === undefined) ? undefined : this.menuNode.label;
    }
    get onDidChange() {
        return this.menuNode.onDidChange;
    }
    toMenuNode() {
        return new ToolbarItemAsSubmenuWrapper(this.menuNode, this.effectiveMenuPath);
    }
    ;
}
exports.SubmenuAsToolbarItemWrapper = SubmenuAsToolbarItemWrapper;
class CommandMenuAsToolbarItemWrapper extends AbstractToolbarMenuWrapper {
    constructor(effectiveMenuPath, commandRegistry, menuRegistry, contextKeyService, contextMenuRenderer, menuNode, group) {
        super(effectiveMenuPath, commandRegistry, menuRegistry, contextKeyService, contextMenuRenderer);
        this.menuNode = menuNode;
        this.group = group;
    }
    get when() {
        return this.menuNode.when;
    }
    isVisible(widget, contextMatcher) {
        return this.menuNode.isVisible(this.effectiveMenuPath, contextMatcher, widget.node, widget);
    }
    executeCommand(widget, e) {
        this.menuNode.run(this.effectiveMenuPath, widget);
    }
    get id() { return this.menuNode.id + exports.TOOLBAR_WRAPPER_ID_SUFFIX; }
    get icon() { return this.menuNode.icon; }
    get tooltip() { return this.menuNode.label; }
    get text() {
        return (this.group === tab_bar_toolbar_types_1.NAVIGATION || this.group === undefined) ? undefined : this.menuNode.label;
    }
    get onDidChange() {
        return this.menuNode.onDidChange;
    }
    toMenuNode() {
        return new ToolbarItemAsCommandMenuWrapper(this.menuNode, this.effectiveMenuPath);
    }
}
exports.CommandMenuAsToolbarItemWrapper = CommandMenuAsToolbarItemWrapper;
class ToolbarActionWrapper extends AbstractToolbarMenuWrapper {
    constructor(effectiveMenuPath, commandRegistry, menuRegistry, contextKeyService, contextMenuRenderer, toolbarItem) {
        super(effectiveMenuPath, commandRegistry, menuRegistry, contextKeyService, contextMenuRenderer);
        this.toolbarItem = toolbarItem;
    }
    get when() {
        return (0, utils_1.combineWhenExpressions)(this.toolbarItem.when, this.menuNode?.when);
    }
    isEnabled(widget) {
        return this.toolbarItem.command ? this.commandRegistry.isEnabled(this.toolbarItem.command, widget) : !!this.toolbarItem.menuPath;
    }
    executeCommand(widget, e) {
        e.preventDefault();
        e.stopPropagation();
        if (!this.isEnabled(widget)) {
            return;
        }
        if (this.toolbarItem.command) {
            this.commandRegistry.executeCommand(this.toolbarItem.command, widget);
        }
    }
    ;
    isVisible(widget, contextMatcher) {
        const menuNode = this.menuNode;
        if (this.toolbarItem.isVisible && !this.toolbarItem.isVisible(widget)) {
            return false;
        }
        if (!menuNode?.isVisible(this.effectiveMenuPath, contextMatcher, widget.node, widget)) {
            return false;
        }
        if (this.toolbarItem.command) {
            return true;
        }
        if (menu_1.CompoundMenuNode.is(menuNode)) {
            return !menuNode.isEmpty(this.effectiveMenuPath, contextMatcher, widget.node, widget);
        }
        return true;
    }
    get id() { return this.toolbarItem.id; }
    get icon() {
        if (typeof this.toolbarItem.icon === 'function') {
            return this.toolbarItem.icon();
        }
        if (this.toolbarItem.icon) {
            return this.toolbarItem.icon;
        }
        if (this.toolbarItem.command) {
            const command = this.commandRegistry.getCommand(this.toolbarItem.command);
            return command?.iconClass;
        }
        return undefined;
    }
    get tooltip() { return this.toolbarItem.tooltip; }
    get text() { return (this.toolbarItem.group === tab_bar_toolbar_types_1.NAVIGATION || this.toolbarItem.group === undefined) ? undefined : this.toolbarItem.text; }
    get onDidChange() {
        return this.menuNode?.onDidChange;
    }
    get menuPath() {
        return this.toolbarItem.menuPath;
    }
    get menuNode() {
        return this.menuRegistry.getMenu(this.menuPath);
    }
    toMenuNode() {
        return new ToolbarItemAsSubmenuWrapper(this.menuNode, this.effectiveMenuPath);
    }
}
exports.ToolbarActionWrapper = ToolbarActionWrapper;
/**
 * This class wraps a menu node, but replaces the effective menu path. Command parameters need to be mapped
 * for commands contributed by extension and this mapping is keyed by the menu path
 */
class AbstractMenuNodeAsToolbarItemWrapper {
    constructor(menuNode, effectiveMenuPath) {
        this.menuNode = menuNode;
        this.effectiveMenuPath = effectiveMenuPath;
    }
    get label() {
        if (menu_1.RenderedMenuNode.is(this.menuNode)) {
            return this.menuNode.label;
        }
    }
    ;
    /**
     * Icon classes for the menu node. If present, these will produce an icon to the left of the label in browser-style menus.
     */
    get icon() {
        if (menu_1.RenderedMenuNode.is(this.menuNode)) {
            return this.menuNode.label;
        }
    }
    get id() {
        return this.menuNode.id;
    }
    get sortString() {
        return this.menuNode.sortString;
    }
    isVisible(effectiveMenuPath, contextMatcher, context, ...args) {
        return this.menuNode.isVisible(this.effectiveMenuPath, contextMatcher, context, ...args);
    }
}
/**
 * Wrapper form submenu nodes
 */
class ToolbarItemAsSubmenuWrapper extends AbstractMenuNodeAsToolbarItemWrapper {
    get contextKeyOverlays() {
        return this.menuNode.contextKeyOverlays;
    }
    isEmpty(effectiveMenuPath, contextMatcher, context, ...args) {
        return this.menuNode.isEmpty(this.effectiveMenuPath, contextMatcher, context, ...args);
    }
    get children() {
        return this.menuNode.children;
    }
}
/**
 * Wrapper for command menus
 */
class ToolbarItemAsCommandMenuWrapper extends AbstractMenuNodeAsToolbarItemWrapper {
    isEnabled(effectiveMenuPath, ...args) {
        return this.menuNode.isEnabled(this.effectiveMenuPath, ...args);
    }
    isToggled(effectiveMenuPath, ...args) {
        return this.menuNode.isToggled(this.effectiveMenuPath, ...args);
    }
    run(effectiveMenuPath, ...args) {
        return this.menuNode.run(this.effectiveMenuPath, ...args);
    }
    get label() {
        return super.label;
    }
}
//# sourceMappingURL=tab-bar-toolbar-menu-adapters.js.map