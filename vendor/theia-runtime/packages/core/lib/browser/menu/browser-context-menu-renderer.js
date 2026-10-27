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
exports.BrowserContextMenuRenderer = exports.BrowserContextMenuAccess = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const context_menu_renderer_1 = require("../context-menu-renderer");
const browser_menu_plugin_1 = require("./browser-menu-plugin");
class BrowserContextMenuAccess extends context_menu_renderer_1.ContextMenuAccess {
    constructor(menu) {
        super(menu);
        this.menu = menu;
    }
}
exports.BrowserContextMenuAccess = BrowserContextMenuAccess;
let BrowserContextMenuRenderer = class BrowserContextMenuRenderer extends context_menu_renderer_1.ContextMenuRenderer {
    doRender(params) {
        const contextMenu = this.menuFactory.createContextMenu(params.menuPath, params.menu, params.contextMatcher, params.args, params.context);
        const { x, y } = (0, context_menu_renderer_1.coordinateFromAnchor)(params.anchor);
        if (params.onHide) {
            contextMenu.aboutToClose.connect(() => params.onHide());
        }
        contextMenu.open(x, y, { host: params.context?.ownerDocument.body });
        return new BrowserContextMenuAccess(contextMenu);
    }
};
exports.BrowserContextMenuRenderer = BrowserContextMenuRenderer;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_menu_plugin_1.BrowserMainMenuFactory),
    tslib_1.__metadata("design:type", browser_menu_plugin_1.BrowserMainMenuFactory)
], BrowserContextMenuRenderer.prototype, "menuFactory", void 0);
exports.BrowserContextMenuRenderer = BrowserContextMenuRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserContextMenuRenderer);
//# sourceMappingURL=browser-context-menu-renderer.js.map