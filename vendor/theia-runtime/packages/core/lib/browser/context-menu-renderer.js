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
exports.ContextMenuRenderer = exports.ContextMenuAccess = exports.Coordinate = void 0;
exports.coordinateFromAnchor = coordinateFromAnchor;
const tslib_1 = require("tslib");
/* eslint-disable @typescript-eslint/no-explicit-any */
const inversify_1 = require("inversify");
const menu_1 = require("../common/menu");
const disposable_1 = require("../common/disposable");
const context_key_service_1 = require("./context-key-service");
exports.Coordinate = Symbol('Coordinate');
function coordinateFromAnchor(anchor) {
    const { x, y } = anchor instanceof MouseEvent ? { x: anchor.clientX, y: anchor.clientY } : anchor;
    return { x, y };
}
class ContextMenuAccess {
    constructor(toClose) {
        this.toDispose = new disposable_1.DisposableCollection();
        this.onDispose = this.toDispose.onDispose;
        this.toDispose.push(toClose);
    }
    get disposed() {
        return this.toDispose.disposed;
    }
    dispose() {
        this.toDispose.dispose();
    }
}
exports.ContextMenuAccess = ContextMenuAccess;
let ContextMenuRenderer = class ContextMenuRenderer {
    constructor() {
        this.toDisposeOnSetCurrent = new disposable_1.DisposableCollection();
    }
    /**
     * Currently opened context menu.
     * Rendering a new context menu will close the current.
     */
    get current() {
        return this._current;
    }
    set current(current) {
        this.setCurrent(current);
    }
    setCurrent(current) {
        if (this._current === current) {
            return;
        }
        this.toDisposeOnSetCurrent.dispose();
        this._current = current;
        if (current) {
            this.toDisposeOnSetCurrent.push(current.onDispose(() => {
                this._current = undefined;
            }));
            this.toDisposeOnSetCurrent.push(current);
        }
    }
    render(options) {
        let menu = options.menu;
        if (!menu) {
            menu = this.menuRegistry.getMenu(options.menuPath) || new menu_1.GroupImpl('emtpyContextMenu');
        }
        const resolvedOptions = this.resolve(options);
        if (resolvedOptions.skipSingleRootNode) {
            menu = menu_1.MenuModelRegistry.removeSingleRootNode(menu);
        }
        const access = this.doRender({
            menuPath: options.menuPath,
            menu,
            anchor: resolvedOptions.anchor,
            contextMatcher: options.contextKeyService || this.contextKeyService,
            args: resolvedOptions.args,
            context: resolvedOptions.context,
            onHide: resolvedOptions.onHide
        });
        this.setCurrent(access);
        return access;
    }
    resolve(options) {
        const args = options.args ? options.args.slice() : [];
        if (options.includeAnchorArg !== false) {
            args.push(options.anchor);
        }
        return {
            ...options,
            args
        };
    }
};
exports.ContextMenuRenderer = ContextMenuRenderer;
tslib_1.__decorate([
    (0, inversify_1.inject)(menu_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", menu_1.MenuModelRegistry)
], ContextMenuRenderer.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], ContextMenuRenderer.prototype, "contextKeyService", void 0);
exports.ContextMenuRenderer = ContextMenuRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ContextMenuRenderer);
//# sourceMappingURL=context-menu-renderer.js.map