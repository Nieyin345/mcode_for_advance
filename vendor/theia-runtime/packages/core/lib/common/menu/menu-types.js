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
exports.MutableCompoundMenuNode = exports.CompoundMenuNode = exports.Group = exports.CommandMenu = exports.RenderedMenuNode = exports.MenuAction = exports.Action = exports.ACCOUNTS_SUBMENU = exports.ACCOUNTS_MENU = exports.MANAGE_MENU = exports.MAIN_MENU_BAR = void 0;
const types_1 = require("../types");
exports.MAIN_MENU_BAR = ['menubar'];
exports.MANAGE_MENU = ['manage_menu'];
exports.ACCOUNTS_MENU = ['accounts_menu'];
exports.ACCOUNTS_SUBMENU = [...exports.ACCOUNTS_MENU, '1_accounts_submenu'];
var Action;
(function (Action) {
    function is(node) {
        return (0, types_1.isObject)(node) && typeof node.run === 'function' && typeof node.isEnabled === 'function';
    }
    Action.is = is;
})(Action || (exports.Action = Action = {}));
var MenuAction;
(function (MenuAction) {
    function is(obj) {
        return (0, types_1.isObject)(obj) && typeof obj.commandId === 'string';
    }
    MenuAction.is = is;
})(MenuAction || (exports.MenuAction = MenuAction = {}));
var RenderedMenuNode;
(function (RenderedMenuNode) {
    function is(node) {
        return (0, types_1.isObject)(node) && typeof node.label === 'string';
    }
    RenderedMenuNode.is = is;
})(RenderedMenuNode || (exports.RenderedMenuNode = RenderedMenuNode = {}));
var CommandMenu;
(function (CommandMenu) {
    function is(node) {
        return RenderedMenuNode.is(node) && Action.is(node);
    }
    CommandMenu.is = is;
})(CommandMenu || (exports.CommandMenu = CommandMenu = {}));
var Group;
(function (Group) {
    function is(obj) {
        return CompoundMenuNode.is(obj) && !RenderedMenuNode.is(obj);
    }
    Group.is = is;
})(Group || (exports.Group = Group = {}));
;
var CompoundMenuNode;
(function (CompoundMenuNode) {
    function is(node) { return (0, types_1.isObject)(node) && Array.isArray(node.children); }
    CompoundMenuNode.is = is;
    function sortChildren(m1, m2) {
        // The navigation group is special as it will always be sorted to the top/beginning of a menu.
        if (isNavigationGroup(m1)) {
            return -1;
        }
        if (isNavigationGroup(m2)) {
            return 1;
        }
        return m1.sortString.localeCompare(m2.sortString);
    }
    CompoundMenuNode.sortChildren = sortChildren;
    /**
     * Indicates whether the given node is the special `navigation` menu.
     *
     * @param node the menu node to check.
     * @returns `true` when the given node is a {@link CompoundMenuNode} with id `navigation`,
     * `false` otherwise.
     */
    function isNavigationGroup(node) {
        return is(node) && node.id === 'navigation';
    }
    CompoundMenuNode.isNavigationGroup = isNavigationGroup;
})(CompoundMenuNode || (exports.CompoundMenuNode = CompoundMenuNode = {}));
;
var MutableCompoundMenuNode;
(function (MutableCompoundMenuNode) {
    function is(node) {
        return (0, types_1.isObject)(node)
            && typeof node.addNode === 'function'
            && typeof node.removeNode === 'function'
            && typeof node.getOrCreate === 'function';
    }
    MutableCompoundMenuNode.is = is;
})(MutableCompoundMenuNode || (exports.MutableCompoundMenuNode = MutableCompoundMenuNode = {}));
//# sourceMappingURL=menu-types.js.map