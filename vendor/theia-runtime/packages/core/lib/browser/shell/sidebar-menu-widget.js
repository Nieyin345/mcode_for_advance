"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidebarMenuWidget = exports.SidebarMenuItem = exports.SidebarBottomMenuWidgetFactory = exports.SidebarTopMenuWidgetFactory = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2020 Alibaba Inc. and others.
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
const inversify_1 = require("inversify");
const React = require("react");
const widgets_1 = require("../widgets");
const context_menu_renderer_1 = require("../context-menu-renderer");
const menu_1 = require("../../common/menu");
const hover_service_1 = require("../hover-service");
const common_1 = require("../../common");
const context_key_service_1 = require("../context-key-service");
exports.SidebarTopMenuWidgetFactory = Symbol('SidebarTopMenuWidgetFactory');
exports.SidebarBottomMenuWidgetFactory = Symbol('SidebarBottomMenuWidgetFactory');
class SidebarMenuItem {
    get badge() {
        if (this._badge <= 0) {
            return '';
        }
        else if (this._badge > 99) {
            return '99+';
        }
        else {
            return this._badge.toString();
        }
    }
    ;
    constructor(menu) {
        this.onDidBadgeChangeEmitter = new common_1.Emitter();
        this.onDidBadgeChange = this.onDidBadgeChangeEmitter.event;
        this._badge = 0;
        this.toDispose = new common_1.DisposableCollection();
        this.menu = menu;
        if (menu.onDidBadgeChange) {
            this.toDispose.push(menu.onDidBadgeChange(value => {
                this._badge = value;
                this.onDidBadgeChangeEmitter.fire(value);
            }));
        }
    }
    dispose() {
        this.toDispose.dispose();
        this.onDidBadgeChangeEmitter.dispose();
    }
}
exports.SidebarMenuItem = SidebarMenuItem;
/**
 * The menu widget placed on the sidebar.
 */
let SidebarMenuWidget = class SidebarMenuWidget extends widgets_1.ReactWidget {
    constructor() {
        super();
        /**
         * Flag indicating whether a context menu is open. While a context menu is open, the `preservedContext` should not be cleared.
         */
        this.preservingContext = false;
        this.onMouseDown = () => {
            const { activeElement } = document;
            if (activeElement instanceof HTMLElement && !this.node.contains(activeElement)) {
                this.preservedContext = activeElement;
            }
        };
        this.onMouseOut = () => {
            if (!this.preservingContext) {
                this.preservedContext = undefined;
            }
        };
        this.onMouseEnter = (event, title) => {
            if (title && event.nativeEvent.currentTarget) {
                this.hoverService.requestHover({
                    content: title,
                    target: event.currentTarget,
                    position: 'right'
                });
            }
        };
        this.items = [];
    }
    addMenu(menu) {
        const exists = this.items.find(item => item.menu.id === menu.id);
        if (exists) {
            return;
        }
        const newItem = new SidebarMenuItem(menu);
        newItem.onDidBadgeChange(() => this.update());
        this.items.push(newItem);
        this.items.sort((a, b) => a.menu.order - b.menu.order);
        this.update();
    }
    removeMenu(menuId) {
        const index = this.items.findIndex(m => m.menu.id === menuId);
        if (index !== -1) {
            this.items[index].dispose();
            this.items.splice(index, 1);
            this.update();
        }
    }
    onClick(e, menuPath) {
        this.preservingContext = true;
        const button = e.currentTarget.getBoundingClientRect();
        const menu = this.menuRegistry.getMenuNode(menuPath);
        this.contextMenuRenderer.render({
            menuPath: menuPath,
            menu: menu,
            includeAnchorArg: false,
            anchor: {
                x: button.left + button.width,
                y: button.top,
            },
            context: e.currentTarget,
            contextKeyService: this.contextKeyService,
            onHide: () => {
                this.preservingContext = false;
                if (this.preservedContext) {
                    this.preservedContext.focus({ preventScroll: true });
                    this.preservedContext = undefined;
                }
            }
        });
    }
    render() {
        return (0, jsx_runtime_1.jsx)(React.Fragment, { children: this.items.map(item => this.renderItem(item)) });
    }
    renderItem(item) {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'theia-sidebar-menu-item', onClick: e => this.onClick(e, item.menu.menuPath), onMouseDown: this.onMouseDown, onMouseEnter: e => this.onMouseEnter(e, item.menu.title), onMouseLeave: this.onMouseOut, children: [(0, jsx_runtime_1.jsx)("i", { className: item.menu.iconClass }), item.badge && (0, jsx_runtime_1.jsx)("div", { className: 'theia-badge-decorator-sidebar', children: item.badge })] }, item.menu.id);
    }
};
exports.SidebarMenuWidget = SidebarMenuWidget;
tslib_1.__decorate([
    (0, inversify_1.inject)(context_menu_renderer_1.ContextMenuRenderer),
    tslib_1.__metadata("design:type", context_menu_renderer_1.ContextMenuRenderer)
], SidebarMenuWidget.prototype, "contextMenuRenderer", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(menu_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", menu_1.MenuModelRegistry)
], SidebarMenuWidget.prototype, "menuRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(hover_service_1.HoverService),
    tslib_1.__metadata("design:type", hover_service_1.HoverService)
], SidebarMenuWidget.prototype, "hoverService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], SidebarMenuWidget.prototype, "contextKeyService", void 0);
exports.SidebarMenuWidget = SidebarMenuWidget = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], SidebarMenuWidget);
//# sourceMappingURL=sidebar-menu-widget.js.map