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
var MenuModelRegistry_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MenuModelRegistry = exports.MenuNodeFactory = exports.StructuralMenuChange = exports.ChangeKind = exports.MenuContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const menu_types_1 = require("./menu-types");
const contribution_provider_1 = require("../contribution-provider");
const command_1 = require("../command");
const event_1 = require("../event");
const disposable_1 = require("../disposable");
exports.MenuContribution = Symbol('MenuContribution');
var ChangeKind;
(function (ChangeKind) {
    ChangeKind[ChangeKind["ADDED"] = 0] = "ADDED";
    ChangeKind[ChangeKind["REMOVED"] = 1] = "REMOVED";
    ChangeKind[ChangeKind["CHANGED"] = 2] = "CHANGED";
    ChangeKind[ChangeKind["LINKED"] = 3] = "LINKED";
})(ChangeKind || (exports.ChangeKind = ChangeKind = {}));
var StructuralMenuChange;
(function (StructuralMenuChange) {
    function is(evt) {
        return evt.kind !== ChangeKind.CHANGED;
    }
    StructuralMenuChange.is = is;
})(StructuralMenuChange || (exports.StructuralMenuChange = StructuralMenuChange = {}));
exports.MenuNodeFactory = Symbol('MenuNodeFactory');
/**
 * The MenuModelRegistry allows to register and unregister menus, submenus and actions
 * via strings and {@link MenuAction}s without the need to access the underlying UI
 * representation.
 */
let MenuModelRegistry = MenuModelRegistry_1 = class MenuModelRegistry {
    constructor(contributions, commands, menuNodeFactory) {
        this.contributions = contributions;
        this.commands = commands;
        this.menuNodeFactory = menuNodeFactory;
        this.onDidChangeEmitter = new event_1.Emitter();
        this.isReady = false;
        this.root = this.menuNodeFactory.createGroup('root', 'root');
        this.root.addNode(this.menuNodeFactory.createGroup(menu_types_1.MAIN_MENU_BAR[0]));
    }
    get onDidChange() {
        return this.onDidChangeEmitter.event;
    }
    onStart() {
        for (const contrib of this.contributions.getContributions()) {
            contrib.registerMenus(this);
        }
        this.isReady = true;
    }
    /**
     * Adds the given menu action to the menu denoted by the given path.
     *
     * @returns a disposable which, when called, will remove the menu action again.
     */
    registerCommandMenu(menuPath, item) {
        const parent = this.root.getOrCreate(menuPath, 0, menuPath.length);
        parent.addNode(item);
        return disposable_1.Disposable.create(() => {
            parent.removeNode(item);
            this.fireChangeEvent({
                kind: ChangeKind.REMOVED,
                path: menuPath.slice(0, menuPath.length - 1),
                affectedChildId: item.id
            });
        });
    }
    /**
     * Adds the given menu action to the menu denoted by the given path.
     *
     * @returns a disposable which, when called, will remove the menu action again.
     */
    registerMenuAction(menuPath, item) {
        const parent = this.root.getOrCreate(menuPath, 0, menuPath.length);
        const node = this.menuNodeFactory.createCommandMenu(item);
        parent.addNode(node);
        return disposable_1.Disposable.create(() => {
            parent.removeNode(node);
            this.fireChangeEvent({
                kind: ChangeKind.REMOVED,
                path: menuPath.slice(0, menuPath.length - 1),
                affectedChildId: node.id
            });
        });
    }
    /**
     * Register a new menu at the given path with the given label.
     * (If the menu already exists without a label, iconClass or order this method can be used to set them.)
     *
     * @param menuPath the path for which a new submenu shall be registered.
     * @param label the label to be used for the new submenu.
     * @param options optionally allows to set an icon class and specify the order of the new menu.
     *
     * @returns if the menu was successfully created a disposable will be returned which,
     * when called, will remove the menu again. If the menu already existed a no-op disposable
     * will be returned.
     *
     * Note that if the menu already existed and was registered with a different label an error
     * will be thrown.
     */
    registerSubmenu(menuPath, label, options = {}) {
        const { contextKeyOverlay, sortString, icon, when } = options;
        const parent = this.root.getOrCreate(menuPath, 0, menuPath.length - 1);
        const existing = parent.children.find(node => node.id === menuPath[menuPath.length - 1]);
        if (menu_types_1.Group.is(existing)) {
            parent.removeNode(existing);
            const newMenu = this.menuNodeFactory.createSubmenu(menuPath[menuPath.length - 1], label, contextKeyOverlay, sortString, icon, when);
            newMenu.addNode(...existing.children);
            parent.addNode(newMenu);
            this.fireChangeEvent({
                kind: ChangeKind.CHANGED,
                path: menuPath
            });
            return disposable_1.Disposable.create(() => {
                parent.removeNode(newMenu);
                this.fireChangeEvent({
                    kind: ChangeKind.REMOVED,
                    path: menuPath.slice(0, menuPath.length - 1),
                    affectedChildId: newMenu.id
                });
            });
        }
        else {
            const newMenu = this.menuNodeFactory.createSubmenu(menuPath[menuPath.length - 1], label, contextKeyOverlay, sortString, icon, when);
            parent.addNode(newMenu);
            this.fireChangeEvent({
                kind: ChangeKind.ADDED,
                path: menuPath.slice(0, menuPath.length - 1),
                affectedChildId: newMenu.id
            });
            return disposable_1.Disposable.create(() => {
                parent.removeNode(newMenu);
                this.fireChangeEvent({
                    kind: ChangeKind.REMOVED,
                    path: menuPath.slice(0, menuPath.length - 1),
                    affectedChildId: newMenu.id
                });
            });
        }
    }
    linkCompoundMenuNode(params) {
        const { newParentPath, submenuPath, order, when } = params;
        // add a wrapper here
        let i = 0;
        while (i < newParentPath.length && i < submenuPath.length && newParentPath[i] === submenuPath[i]) {
            i++;
        }
        if (i === newParentPath.length || i === submenuPath.length) {
            throw new Error(`trying to recursively link ${JSON.stringify(submenuPath)} into ${JSON.stringify(newParentPath)}`);
        }
        const child = this.getMenu(submenuPath);
        if (!child) {
            throw new Error(`Not a menu node: ${JSON.stringify(submenuPath)}`);
        }
        const newParent = this.root.getOrCreate(newParentPath, 0, newParentPath.length);
        if (menu_types_1.MutableCompoundMenuNode.is(newParent)) {
            const link = this.menuNodeFactory.createSubmenuLink(child, order, when);
            newParent.addNode(link);
            this.fireChangeEvent({
                kind: ChangeKind.LINKED,
                path: newParentPath,
                affectedChildId: child.id
            });
            return disposable_1.Disposable.create(() => {
                newParent.removeNode(link);
                this.fireChangeEvent({
                    kind: ChangeKind.REMOVED,
                    path: newParentPath,
                    affectedChildId: child.id
                });
            });
        }
        else {
            throw new Error(`Not a compound menu node: ${JSON.stringify(newParentPath)}`);
        }
    }
    unregisterMenuAction(itemOrCommandOrId, menuPath = []) {
        const id = menu_types_1.MenuAction.is(itemOrCommandOrId) ? itemOrCommandOrId.commandId
            : command_1.Command.is(itemOrCommandOrId) ? itemOrCommandOrId.id
                : itemOrCommandOrId;
        const parent = this.findInNode(this.root, menuPath, 0);
        if (parent) {
            this.removeActionInSubtree(parent, id);
        }
    }
    removeActionInSubtree(parent, id) {
        if (menu_types_1.MutableCompoundMenuNode.is(parent) && menu_types_1.CompoundMenuNode.is(parent)) {
            const action = parent.children.find(child => child.id === id);
            if (action) {
                parent.removeNode(action);
            }
            parent.children.forEach(child => this.removeActionInSubtree(child, id));
        }
    }
    findInNode(root, menuPath, pathIndex) {
        if (pathIndex === menuPath.length) {
            return root;
        }
        if (menu_types_1.CompoundMenuNode.is(root)) {
            const child = root.children.find(c => c.id === menuPath[pathIndex]);
            if (child) {
                return this.findInNode(child, menuPath, pathIndex + 1);
            }
        }
        return undefined;
    }
    getMenuNode(menuPath) {
        return this.findInNode(this.root, menuPath, 0);
    }
    getMenu(menuPath) {
        const node = this.getMenuNode(menuPath);
        if (!node) {
            return undefined;
        }
        if (!menu_types_1.CompoundMenuNode.is(node)) {
            throw new Error(`not a compound menu node: ${JSON.stringify(menuPath)}`);
        }
        return node;
    }
    static removeSingleRootNodes(fullMenuModel) {
        let current = fullMenuModel;
        let previous = undefined;
        while (current !== previous) {
            previous = current;
            current = this.removeSingleRootNode(current);
        }
        return current;
    }
    /**
     * Checks the given menu model whether it will show a menu with a single submenu.
     *
     * @param fullMenuModel the menu model to analyze
     * @param menuPath the menu's path
     * @returns if the menu will show a single submenu this returns a menu that will show the child elements of the submenu,
     * otherwise the given `fullMenuModel` is return
     */
    static removeSingleRootNode(fullMenuModel) {
        let singleChild = undefined;
        for (const child of fullMenuModel.children) {
            if (menu_types_1.CompoundMenuNode.is(child)) {
                if (!MenuModelRegistry_1.isEmpty(child)) {
                    if (singleChild) {
                        return fullMenuModel;
                    }
                    else {
                        singleChild = child;
                    }
                }
            }
            else {
                return fullMenuModel;
            }
        }
        return singleChild || fullMenuModel;
    }
    static isEmpty(node) {
        if (menu_types_1.CompoundMenuNode.is(node)) {
            if (node.children.length === 0) {
                return true;
            }
            for (const child of node.children) {
                if (!MenuModelRegistry_1.isEmpty(child)) {
                    return false;
                }
            }
        }
        else {
            return false;
        }
        return true;
    }
    fireChangeEvent(evt) {
        if (this.isReady) {
            this.onDidChangeEmitter.fire(evt);
        }
    }
};
exports.MenuModelRegistry = MenuModelRegistry;
exports.MenuModelRegistry = MenuModelRegistry = MenuModelRegistry_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(contribution_provider_1.ContributionProvider)),
    tslib_1.__param(0, (0, inversify_1.named)(exports.MenuContribution)),
    tslib_1.__param(1, (0, inversify_1.inject)(command_1.CommandRegistry)),
    tslib_1.__param(2, (0, inversify_1.inject)(exports.MenuNodeFactory)),
    tslib_1.__metadata("design:paramtypes", [Object, command_1.CommandRegistry, Object])
], MenuModelRegistry);
//# sourceMappingURL=menu-model-registry.js.map