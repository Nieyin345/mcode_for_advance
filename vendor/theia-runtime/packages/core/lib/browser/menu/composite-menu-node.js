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
exports.SubmenuImpl = exports.GroupImpl = exports.AbstractCompoundMenuImpl = exports.SubMenuLink = void 0;
const menu_types_1 = require("../../common/menu/menu-types");
const utils_1 = require("./utils");
class SubMenuLink {
    constructor(delegate, _sortString, _when) {
        this.delegate = delegate;
        this._sortString = _sortString;
        this._when = _when;
    }
    get id() { return this.delegate.id; }
    ;
    get when() { return (0, utils_1.combineWhenExpressions)(this.delegate.when, this._when); }
    get onDidChange() { return this.delegate.onDidChange; }
    ;
    get children() { return this.delegate.children; }
    get contextKeyOverlays() { return this.delegate.contextKeyOverlays; }
    get label() { return this.delegate.label; }
    ;
    get icon() { return this.delegate.icon; }
    ;
    get sortString() { return this._sortString || this.delegate.sortString; }
    ;
    isVisible(effectiveMenuPath, contextMatcher, context, ...args) {
        return this.delegate.isVisible(effectiveMenuPath, contextMatcher, context, ...args) && (!this._when || contextMatcher.match(this._when, context));
    }
    isEmpty(effectiveMenuPath, contextMatcher, context, ...args) {
        return this.delegate.isEmpty(effectiveMenuPath, contextMatcher, context, ...args);
    }
}
exports.SubMenuLink = SubMenuLink;
/**
 * Node representing a (sub)menu in the menu tree structure.
 */
class AbstractCompoundMenuImpl {
    constructor(id, orderString, when) {
        this.id = id;
        this.orderString = orderString;
        this.when = when;
        this.children = [];
    }
    getOrCreate(menuPath, pathIndex, endIndex) {
        if (pathIndex === endIndex) {
            return this;
        }
        let child = this.getNode(menuPath[pathIndex]);
        if (!child) {
            child = new GroupImpl(menuPath[pathIndex]);
            this.addNode(child);
        }
        if (child instanceof AbstractCompoundMenuImpl) {
            return child.getOrCreate(menuPath, pathIndex + 1, endIndex);
        }
        else {
            throw new Error(`An item exists, but it's not a parent: ${menuPath} at ${pathIndex}`);
        }
    }
    /**
     * Menu nodes are sorted in ascending order based on their `sortString`.
     */
    isVisible(effectiveMenuPath, contextMatcher, context, ...args) {
        return (!this.when || contextMatcher.match(this.when, context));
    }
    isEmpty(effectiveMenuPath, contextMatcher, context, ...args) {
        for (const child of this.children) {
            if (child.isVisible(effectiveMenuPath, contextMatcher, context, ...args)) {
                if (!menu_types_1.CompoundMenuNode.is(child) || !child.isEmpty(effectiveMenuPath, contextMatcher, context, ...args)) {
                    return false;
                }
            }
        }
        return true;
    }
    addNode(...node) {
        this.children.push(...node);
        this.children.sort(menu_types_1.CompoundMenuNode.sortChildren);
    }
    getNode(id) {
        return this.children.find(node => node.id === id);
    }
    removeById(id) {
        const idx = this.children.findIndex(node => node.id === id);
        if (idx >= 0) {
            this.children.splice(idx, 1);
        }
    }
    removeNode(node) {
        const idx = this.children.indexOf(node);
        if (idx >= 0) {
            this.children.splice(idx, 1);
        }
    }
    get sortString() {
        return this.orderString || this.id;
    }
}
exports.AbstractCompoundMenuImpl = AbstractCompoundMenuImpl;
class GroupImpl extends AbstractCompoundMenuImpl {
    constructor(id, orderString, when) {
        super(id, orderString, when);
    }
}
exports.GroupImpl = GroupImpl;
class SubmenuImpl extends AbstractCompoundMenuImpl {
    constructor(id, label, contextKeyOverlays, orderString, icon, when) {
        super(id, orderString, when);
        this.label = label;
        this.contextKeyOverlays = contextKeyOverlays;
        this.icon = icon;
    }
}
exports.SubmenuImpl = SubmenuImpl;
//# sourceMappingURL=composite-menu-node.js.map