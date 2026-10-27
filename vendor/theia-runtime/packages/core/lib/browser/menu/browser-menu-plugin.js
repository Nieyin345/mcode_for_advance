"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.BrowserMenuBarContribution = exports.DynamicMenuWidget = exports.MenuServices = exports.DynamicMenuBarWidget = exports.BrowserMainMenuFactory = exports.MenuBarWidget = void 0;
exports.isMenuElement = isMenuElement;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const widgets_1 = require("@lumino/widgets");
const commands_1 = require("@lumino/commands");
const common_1 = require("../../common");
const keybinding_1 = require("../keybinding");
const context_key_service_1 = require("../context-key-service");
const context_menu_context_1 = require("./context-menu-context");
const widgets_2 = require("../widgets");
const shell_1 = require("../shell");
const core_preferences_1 = require("../../common/core-preferences");
const domutils_1 = require("@lumino/domutils");
const menu_types_1 = require("../../common/menu/menu-types");
const menu_model_registry_1 = require("../../common/menu/menu-model-registry");
class MenuBarWidget extends widgets_1.MenuBar {
}
exports.MenuBarWidget = MenuBarWidget;
;
let BrowserMainMenuFactory = class BrowserMainMenuFactory {
    createMenuBar() {
        const menuBar = new DynamicMenuBarWidget();
        menuBar.id = 'theia:menubar';
        this.corePreferences.ready.then(() => {
            this.showMenuBar(menuBar);
        });
        const disposable = new common_1.DisposableCollection(this.corePreferences.onPreferenceChanged(change => {
            if (change.preferenceName === 'window.menuBarVisibility') {
                this.showMenuBar(menuBar, this.corePreferences['window.menuBarVisibility']);
            }
        }), this.keybindingRegistry.onKeybindingsChanged(() => {
            this.showMenuBar(menuBar);
        }), this.menuProvider.onDidChange(evt => {
            if (common_1.ArrayUtils.startsWith(evt.path, menu_types_1.MAIN_MENU_BAR)) {
                this.showMenuBar(menuBar);
            }
        }));
        menuBar.disposed.connect(() => disposable.dispose());
        return menuBar;
    }
    getMenuBarVisibility() {
        return this.corePreferences.get('window.menuBarVisibility', 'classic');
    }
    showMenuBar(menuBar, preference = this.getMenuBarVisibility()) {
        if (preference && ['classic', 'visible'].includes(preference)) {
            menuBar.clearMenus();
            this.fillMenuBar(menuBar);
        }
        else {
            menuBar.clearMenus();
        }
    }
    fillMenuBar(menuBar) {
        const menuModel = this.menuProvider.getMenuNode(menu_types_1.MAIN_MENU_BAR);
        const menuCommandRegistry = new commands_1.CommandRegistry();
        for (const menu of menuModel.children) {
            if (menu_types_1.CompoundMenuNode.is(menu) && menu_types_1.RenderedMenuNode.is(menu)) {
                const menuWidget = this.createMenuWidget(menu_types_1.MAIN_MENU_BAR, menu, this.contextKeyService, { commands: menuCommandRegistry });
                menuBar.addMenu(menuWidget);
            }
        }
    }
    createContextMenu(effectiveMenuPath, menuModel, contextMatcher, args, context) {
        const menuCommandRegistry = new commands_1.CommandRegistry();
        const contextMenu = this.createMenuWidget(effectiveMenuPath, menuModel, contextMatcher, { commands: menuCommandRegistry, context }, args);
        return contextMenu;
    }
    createMenuWidget(parentPath, menu, contextMatcher, options, args) {
        return new DynamicMenuWidget(parentPath, menu, options, contextMatcher, this.services, args);
    }
    get services() {
        return {
            contextKeyService: this.contextKeyService,
            context: this.context,
            menuWidgetFactory: this,
        };
    }
};
exports.BrowserMainMenuFactory = BrowserMainMenuFactory;
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], BrowserMainMenuFactory.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_menu_context_1.ContextMenuContext),
    tslib_1.__metadata("design:type", context_menu_context_1.ContextMenuContext)
], BrowserMainMenuFactory.prototype, "context", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_preferences_1.CorePreferences),
    tslib_1.__metadata("design:type", Object)
], BrowserMainMenuFactory.prototype, "corePreferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(keybinding_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", keybinding_1.KeybindingRegistry)
], BrowserMainMenuFactory.prototype, "keybindingRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(menu_model_registry_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", menu_model_registry_1.MenuModelRegistry)
], BrowserMainMenuFactory.prototype, "menuProvider", void 0);
exports.BrowserMainMenuFactory = BrowserMainMenuFactory = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserMainMenuFactory);
function isMenuElement(element) {
    return !!element && element.className.includes('lm-Menu');
}
class DynamicMenuBarWidget extends MenuBarWidget {
    constructor() {
        // Disable Lumino's overflow menu feature. The feature has a bug where
        // `onUpdateRequest` consumes a stale `_overflowIndex` (only recomputed at the
        // end of the method), which causes a RangeError when the menu bar is rendered
        // at zero width. Additionally, Theia's CSS does not constrain the menu bar's
        // offsetWidth to the available space, so the overflow detection never triggers.
        // See https://github.com/eclipse-theia/theia/issues/17352
        // See https://github.com/jupyterlab/lumino/issues/811
        super({ overflowMenuOptions: { isVisible: false } });
        // HACK we need to hook in on private method _openChildMenu. Don't do this at home!
        DynamicMenuBarWidget.prototype['_openChildMenu'] = () => {
            if (this.activeMenu instanceof DynamicMenuWidget) {
                // `childMenu` is `null` if we open the menu. For example, menu is not shown and you click on `Edit`.
                // However, the `childMenu` is set, when `Edit` was already open and you move the mouse over `Select`.
                // We want to save the focus object for the former case only.
                if (!this.childMenu) {
                    const { activeElement } = document;
                    // we do not want to restore focus to menus
                    if (activeElement instanceof HTMLElement && !isMenuElement(activeElement)) {
                        this.previousFocusedElement = activeElement;
                    }
                }
                this.activeMenu.aboutToShow({ previousFocusedElement: this.previousFocusedElement });
            }
            super['_openChildMenu']();
        };
    }
    async activateMenu(label, ...labels) {
        const menu = this.menus.find(m => m.title.label === label);
        if (!menu) {
            throw new Error(`could not find '${label}' menu`);
        }
        this.activeMenu = menu;
        this.openActiveMenu();
        await (0, widgets_2.waitForRevealed)(menu);
        const menuPath = [label, ...labels];
        let current = menu;
        for (const itemLabel of labels) {
            const item = current.items.find(i => i.label === itemLabel);
            if (!item || !item.submenu) {
                throw new Error(`could not find '${itemLabel}' submenu in ${menuPath.map(l => "'" + l + "'").join(' -> ')} menu`);
            }
            current.activeItem = item;
            current.triggerActiveItem();
            current = item.submenu;
            await (0, widgets_2.waitForRevealed)(current);
        }
        return current;
    }
    async triggerMenuItem(label, ...labels) {
        if (!labels.length) {
            throw new Error('menu item label is not specified');
        }
        const menuPath = [label, ...labels.slice(0, labels.length - 1)];
        const menu = await this.activateMenu(menuPath[0], ...menuPath.slice(1));
        const item = menu.items.find(i => i.label === labels[labels.length - 1]);
        if (!item) {
            throw new Error(`could not find '${labels[labels.length - 1]}' item in ${menuPath.map(l => "'" + l + "'").join(' -> ')} menu`);
        }
        menu.activeItem = item;
        menu.triggerActiveItem();
        return item;
    }
}
exports.DynamicMenuBarWidget = DynamicMenuBarWidget;
class MenuServices {
}
exports.MenuServices = MenuServices;
/**
 * A menu widget that would recompute its items on update.
 */
class DynamicMenuWidget extends widgets_1.Menu {
    static { this.nextCommmandId = 0; }
    constructor(effectiveMenuPath, menu, options, contextMatcher, services, args) {
        super(options);
        this.effectiveMenuPath = effectiveMenuPath;
        this.menu = menu;
        this.options = options;
        this.contextMatcher = contextMatcher;
        this.services = services;
        this.args = args;
        if (menu_types_1.RenderedMenuNode.is(this.menu)) {
            if (this.menu.label) {
                this.title.label = this.menu.label;
            }
            if (this.menu.icon) {
                this.title.iconClass = this.menu.icon;
            }
        }
        this.updateSubMenus(this.effectiveMenuPath, this, this.menu, this.options.commands, this.contextMatcher, this.options.context);
    }
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        this.node.ownerDocument.addEventListener('pointerdown', this, true);
    }
    onBeforeDetach(msg) {
        this.node.ownerDocument.removeEventListener('pointerdown', this, true);
        super.onBeforeDetach(msg);
    }
    handleEvent(event) {
        if (event.type === 'pointerdown') {
            this.handlePointerDown(event);
        }
        super.handleEvent(event);
    }
    handlePointerDown(event) {
        // this code is copied from the superclass because we cannot use the hit
        // test from the "Private" implementation namespace
        if (this['_parentMenu']) {
            return;
        }
        // The mouse button which is pressed is irrelevant. If the press
        // is not on a menu, the entire hierarchy is closed and the event
        // is allowed to propagate. This allows other code to act on the
        // event, such as focusing the clicked element.
        if (!this.hitTestMenus(this, event.clientX, event.clientY)) {
            this.close();
        }
    }
    hitTestMenus(menu, x, y) {
        for (let temp = menu; temp; temp = temp.childMenu) {
            if (domutils_1.ElementExt.hitTest(temp.node, x, y)) {
                return true;
            }
        }
        return false;
    }
    aboutToShow({ previousFocusedElement }) {
        this.preserveFocusedElement(previousFocusedElement);
        this.clearItems();
        this.runWithPreservedFocusContext(() => {
            this.updateSubMenus(this.effectiveMenuPath, this, this.menu, this.options.commands, this.contextMatcher, this.options.context);
        });
    }
    open(x, y, options) {
        const cb = () => {
            this.restoreFocusedElement();
            this.aboutToClose.disconnect(cb);
        };
        this.aboutToClose.connect(cb);
        this.preserveFocusedElement();
        super.open(x, y, options);
    }
    updateSubMenus(parentPath, parent, menu, commands, contextMatcher, context) {
        const items = this.createItems(parentPath, menu.children, commands, contextMatcher, context);
        while (items[items.length - 1]?.type === 'separator') {
            items.pop();
        }
        for (const item of items) {
            parent.addItem(item);
        }
    }
    createItems(parentPath, nodes, phCommandRegistry, contextMatcher, context) {
        const result = [];
        for (const node of nodes) {
            const nodePath = node.effectiveMenuPath || [...parentPath, node.id];
            if (node.isVisible(nodePath, contextMatcher, context, ...(this.args || []))) {
                if (menu_types_1.CompoundMenuNode.is(node)) {
                    if (menu_types_1.RenderedMenuNode.is(node)) {
                        const submenu = this.services.menuWidgetFactory.createMenuWidget(nodePath, node, this.contextMatcher, this.options, this.args);
                        if (submenu.items.length > 0) {
                            result.push({ type: 'submenu', submenu });
                        }
                    }
                    else if (node.id !== 'inline') {
                        const items = this.createItems(nodePath, node.children, phCommandRegistry, contextMatcher, context);
                        if (items.length > 0) {
                            if (result[result.length - 1]?.type !== 'separator') {
                                result.push({ type: 'separator' });
                            }
                            result.push(...items);
                            result.push({ type: 'separator' });
                        }
                    }
                }
                else if (menu_types_1.CommandMenu.is(node)) {
                    const id = !phCommandRegistry.hasCommand(node.id) ? node.id : `${node.id}:${DynamicMenuWidget.nextCommmandId++}`;
                    const enabled = node.isEnabled(nodePath, ...(this.args || []));
                    const toggled = node.isToggled ? !!node.isToggled(nodePath, ...(this.args || [])) : false;
                    phCommandRegistry.addCommand(id, {
                        execute: () => {
                            // Restore focus to the previously focused element before executing
                            // the command so that focus-dependent commands like clipboard
                            // operations target the correct element instead of the menu.
                            if (this.previousFocusedElement) {
                                this.previousFocusedElement.focus({ preventScroll: true });
                            }
                            node.run(nodePath, ...(this.args || []));
                        },
                        isEnabled: () => enabled,
                        isToggled: () => toggled,
                        isVisible: () => true,
                        label: node.label,
                        iconClass: node.icon,
                    });
                    const accelerator = (common_1.AcceleratorSource.is(node) ? node.getAccelerator(this.options.context) : []);
                    if (accelerator.length > 0) {
                        phCommandRegistry.addKeyBinding({
                            command: id,
                            keys: accelerator,
                            selector: '.p-Widget' // We have the PhosphorJS dependency anyway.
                        });
                    }
                    result.push({
                        command: id,
                        type: 'command'
                    });
                }
            }
        }
        return result;
    }
    preserveFocusedElement(previousFocusedElement = document.activeElement) {
        if (!this.previousFocusedElement && previousFocusedElement instanceof HTMLElement && !isMenuElement(previousFocusedElement)) {
            this.previousFocusedElement = previousFocusedElement;
            return true;
        }
        return false;
    }
    restoreFocusedElement() {
        if (this.previousFocusedElement) {
            this.previousFocusedElement.focus({ preventScroll: true });
            this.previousFocusedElement = undefined;
            return true;
        }
        return false;
    }
    runWithPreservedFocusContext(what) {
        let focusToRestore = undefined;
        const { activeElement } = document;
        if (this.previousFocusedElement &&
            activeElement instanceof HTMLElement &&
            this.previousFocusedElement !== activeElement) {
            focusToRestore = activeElement;
            this.previousFocusedElement.focus({ preventScroll: true });
        }
        try {
            what();
        }
        finally {
            if (focusToRestore && !isMenuElement(focusToRestore)) {
                focusToRestore.focus({ preventScroll: true });
            }
        }
    }
}
exports.DynamicMenuWidget = DynamicMenuWidget;
let BrowserMenuBarContribution = class BrowserMenuBarContribution {
    constructor(factory) {
        this.factory = factory;
    }
    onStart(app) {
        this.appendMenu(app.shell);
    }
    get menuBar() {
        return this.shell.topPanel.widgets.find(w => w instanceof MenuBarWidget);
    }
    appendMenu(shell) {
        const logo = this.createLogo();
        shell.addWidget(logo, { area: 'top' });
        const menu = this.factory.createMenuBar();
        shell.addWidget(menu, { area: 'top' });
        // Hiding the menu is only necessary in electron
        // In the browser we hide the whole top panel
        if (common_1.environment.electron.is()) {
            this.preferenceService.ready.then(() => {
                menu.setHidden(['compact', 'hidden'].includes(this.preferenceService.get('window.menuBarVisibility', '')));
            });
            this.preferenceService.onPreferenceChanged(change => {
                if (change.preferenceName === 'window.menuBarVisibility') {
                    menu.setHidden(['compact', 'hidden'].includes(this.preferenceService.get('window.menuBarVisibility', 'classic')));
                }
            });
        }
    }
    createLogo() {
        const logo = new widgets_1.Widget();
        logo.id = 'theia:icon';
        logo.addClass('theia-icon');
        return logo;
    }
};
exports.BrowserMenuBarContribution = BrowserMenuBarContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(shell_1.ApplicationShell),
    tslib_1.__metadata("design:type", shell_1.ApplicationShell)
], BrowserMenuBarContribution.prototype, "shell", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], BrowserMenuBarContribution.prototype, "preferenceService", void 0);
exports.BrowserMenuBarContribution = BrowserMenuBarContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(BrowserMainMenuFactory)),
    tslib_1.__metadata("design:paramtypes", [BrowserMainMenuFactory])
], BrowserMenuBarContribution);
//# sourceMappingURL=browser-menu-plugin.js.map