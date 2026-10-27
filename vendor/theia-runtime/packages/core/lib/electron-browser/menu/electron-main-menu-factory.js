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
exports.ElectronMainMenuFactory = void 0;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const inversify_1 = require("inversify");
const common_1 = require("../../common");
const browser_1 = require("../../browser");
const debounce = require("lodash.debounce");
const browser_menu_plugin_1 = require("../../browser/menu/browser-menu-plugin");
function traverseMenuDto(items, callback) {
    for (const item of items) {
        callback(item);
        if (item.submenu) {
            traverseMenuDto(item.submenu, callback);
        }
    }
}
function traverseMenuModel(effectivePath, item, callback) {
    callback(item, effectivePath);
    if (common_1.CompoundMenuNode.is(item)) {
        for (const child of item.children) {
            traverseMenuModel([...effectivePath, child.id], child, callback);
        }
    }
}
let ElectronMainMenuFactory = class ElectronMainMenuFactory extends browser_menu_plugin_1.BrowserMainMenuFactory {
    constructor() {
        super(...arguments);
        this.setMenuBar = debounce(() => this.doSetMenuBar(), 100);
    }
    postConstruct() {
        this.keybindingRegistry.onKeybindingsChanged(() => {
            this.setMenuBar();
        });
        this.menuProvider.onDidChange(() => {
            this.setMenuBar();
        });
        this.preferencesService.ready.then(() => {
            this.preferencesService.onPreferenceChanged(debounce(e => {
                if (e.preferenceName === 'window.menuBarVisibility') {
                    this.setMenuBar();
                }
                if (this.menu) {
                    const menuModel = this.menuProvider.getMenu(common_1.MAIN_MENU_BAR);
                    const toggledMap = new Map();
                    traverseMenuDto(this.menu, item => {
                        if (item.id) {
                            toggledMap.set(item.id, item);
                        }
                    });
                    let anyChanged = false;
                    traverseMenuModel(common_1.MAIN_MENU_BAR, menuModel, ((item, path) => {
                        if (common_1.CommandMenu.is(item)) {
                            const isToggled = item.isToggled(path);
                            const menuItem = toggledMap.get(item.id);
                            if (menuItem && isToggled !== menuItem.checked) {
                                anyChanged = true;
                                menuItem.type = isToggled ? 'checkbox' : 'normal';
                                menuItem.checked = isToggled;
                            }
                        }
                    }));
                    if (anyChanged) {
                        window.electronTheiaCore.setMenu(this.menu);
                    }
                }
            }, 10));
        });
    }
    doSetMenuBar() {
        const preference = this.preferencesService.get('window.menuBarVisibility') || 'classic';
        const shouldShowTop = !window.electronTheiaCore.isFullScreen() || preference === 'visible';
        if (shouldShowTop) {
            this.menu = this.createElectronMenuBar();
            window.electronTheiaCore.setMenu(this.menu);
            window.electronTheiaCore.setMenuBarVisible(true);
        }
        else {
            window.electronTheiaCore.setMenuBarVisible(false);
        }
    }
    createElectronMenuBar() {
        const menuModel = this.menuProvider.getMenu(common_1.MAIN_MENU_BAR);
        const menu = this.fillMenuTemplate([], common_1.MAIN_MENU_BAR, menuModel, [], this.contextKeyService, { honorDisabled: false }, false);
        if (common_1.isOSX) {
            menu.unshift(this.createOSXMenu());
        }
        return menu;
    }
    createElectronContextMenu(menuPath, menu, contextMatcher, args, context, skipSingleRootNode) {
        return this.fillMenuTemplate([], menuPath, menu, args, contextMatcher, { showDisabled: true, context }, true);
    }
    fillMenuTemplate(parentItems, menuPath, menu, args = [], contextMatcher, options, skipRoot) {
        const showDisabled = options?.showDisabled !== false;
        const honorDisabled = options?.honorDisabled !== false;
        const effectivePath = menu.effectiveMenuPath || menuPath;
        if (common_1.CompoundMenuNode.is(menu) && menu.children.length && menu.isVisible(effectivePath, contextMatcher, options.context, ...args)) {
            if (common_1.Group.is(menu) && menu.id === 'inline') {
                return parentItems;
            }
            if (menu.contextKeyOverlays) {
                const overlays = menu.contextKeyOverlays;
                contextMatcher = this.services.contextKeyService.createOverlay(Object.keys(overlays).map(key => [key, overlays[key]]));
            }
            const children = menu.children;
            const myItems = [];
            children.forEach(child => this.fillMenuTemplate(myItems, [...effectivePath, child.id], child, args, contextMatcher, options, false));
            if (myItems.length === 0) {
                return parentItems;
            }
            if (!skipRoot && common_1.RenderedMenuNode.is(menu)) {
                parentItems.push({ label: menu.label, submenu: myItems });
            }
            else {
                if (parentItems.length && parentItems[parentItems.length - 1].type !== 'separator') {
                    parentItems.push({ type: 'separator' });
                }
                parentItems.push(...myItems);
                parentItems.push({ type: 'separator' });
            }
        }
        else if (common_1.CommandMenu.is(menu)) {
            if (!menu.isVisible(effectivePath, contextMatcher, options.context, ...args)) {
                return parentItems;
            }
            // We should omit rendering context-menu items which are disabled.
            if (!showDisabled && !menu.isEnabled(effectivePath, ...args)) {
                return parentItems;
            }
            const accelerator = common_1.AcceleratorSource.is(menu) ? menu.getAccelerator(options.context).join(' ') : undefined;
            const menuItem = {
                id: menu.id,
                label: menu.label,
                type: menu.isToggled(effectivePath, ...args) ? 'checkbox' : 'normal',
                checked: menu.isToggled(effectivePath, ...args),
                enabled: !honorDisabled || menu.isEnabled(effectivePath, ...args), // see https://github.com/eclipse-theia/theia/issues/446
                visible: true,
                accelerator,
                execute: async () => {
                    const wasToggled = menuItem.checked;
                    await menu.run(effectivePath, ...args);
                    const isToggled = menu.isToggled(effectivePath, ...args);
                    if (isToggled !== wasToggled) {
                        menuItem.type = isToggled ? 'checkbox' : 'normal';
                        menuItem.checked = isToggled;
                        window.electronTheiaCore.setMenu(this.menu);
                    }
                }
            };
            // Only assign Electron roles when no custom args are present.
            // Custom args indicate that command handlers have context-dependent
            // behavior (e.g. chat view copying the whole message when there is
            // no DOM selection) that would be bypassed by the native role.
            const role = args.length === 0 ? this.roleFor(menu.id) : undefined;
            if (role) {
                menuItem.role = role;
                delete menuItem.execute;
            }
            parentItems.push(menuItem);
        }
        return parentItems;
    }
    undefinedOrMatch(contextKeyService, expression, context) {
        if (expression) {
            return contextKeyService.match(expression, context);
        }
        return true;
    }
    roleFor(id) {
        let role;
        switch (id) {
            case browser_1.CommonCommands.UNDO.id:
                role = 'undo';
                break;
            case browser_1.CommonCommands.REDO.id:
                role = 'redo';
                break;
            case browser_1.CommonCommands.CUT.id:
                role = 'cut';
                break;
            case browser_1.CommonCommands.COPY.id:
                role = 'copy';
                break;
            case browser_1.CommonCommands.PASTE.id:
                role = 'paste';
                break;
            case browser_1.CommonCommands.SELECT_ALL.id:
                role = 'selectAll';
                break;
            default:
                break;
        }
        return role;
    }
    createOSXMenu() {
        return {
            label: 'Theia',
            submenu: [
                {
                    role: 'about'
                },
                {
                    type: 'separator'
                },
                {
                    role: 'services',
                    submenu: []
                },
                {
                    type: 'separator'
                },
                {
                    role: 'hide'
                },
                {
                    role: 'hideOthers'
                },
                {
                    role: 'unhide'
                },
                {
                    type: 'separator'
                },
                {
                    role: 'quit'
                }
            ]
        };
    }
};
exports.ElectronMainMenuFactory = ElectronMainMenuFactory;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], ElectronMainMenuFactory.prototype, "preferencesService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ElectronMainMenuFactory.prototype, "postConstruct", null);
exports.ElectronMainMenuFactory = ElectronMainMenuFactory = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ElectronMainMenuFactory);
//# sourceMappingURL=electron-main-menu-factory.js.map