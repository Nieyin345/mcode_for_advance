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
exports.MonacoContextMenuService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const browser_1 = require("@theia/editor/lib/browser");
const browser_2 = require("@theia/core/lib/browser");
const widgets_1 = require("@theia/core/shared/@lumino/widgets");
const commands_1 = require("@theia/core/shared/@lumino/commands");
const actions_1 = require("@theia/monaco-editor-core/esm/vs/base/common/actions");
const actions_2 = require("@theia/monaco-editor-core/esm/vs/platform/actions/common/actions");
const event_1 = require("@theia/monaco-editor-core/esm/vs/base/common/event");
const mouseEvent_1 = require("@theia/monaco-editor-core/esm/vs/base/browser/mouseEvent");
let MonacoContextMenuService = class MonacoContextMenuService {
    constructor() {
        this.onDidShowContextMenuEmitter = new event_1.Emitter();
        this.onDidShowContextMenu = this.onDidShowContextMenuEmitter.event;
        this.onDidHideContextMenuEmitter = new event_1.Emitter();
        this.onDidHideContextMenu = this.onDidHideContextMenuEmitter.event;
    }
    toAnchor(anchor) {
        if (anchor instanceof HTMLElement) {
            return { x: anchor.offsetLeft, y: anchor.offsetTop };
        }
        else if (anchor instanceof mouseEvent_1.StandardMouseEvent) {
            return { x: anchor.posx, y: anchor.posy };
        }
        else {
            return anchor;
        }
    }
    getContext(delegate) {
        const anchor = delegate.getAnchor();
        if (anchor instanceof HTMLElement) {
            return anchor;
        }
        else if (anchor instanceof mouseEvent_1.StandardMouseEvent) {
            return anchor.target;
        }
        else {
            return window.document.body; // last resort
        }
    }
    showContextMenu(delegate) {
        const anchor = this.toAnchor(delegate.getAnchor());
        const actions = delegate.getActions();
        const context = this.getContext(delegate);
        const onHide = () => {
            delegate.onHide?.(false);
            this.onDidHideContextMenuEmitter.fire();
        };
        // Actions for editor context menu come as 'MenuItemAction' items
        // In case of 'Quick Fix' actions come as 'CodeActionAction' items
        if (actions.length > 0 && actions[0] instanceof actions_2.MenuItemAction) {
            this.contextMenuRenderer.render({
                context: context,
                menuPath: this.menuPath(),
                anchor,
                onHide
            });
        }
        else {
            const menu = new widgets_1.Menu({ commands: new commands_1.CommandRegistry() });
            this.populateMenu(menu, actions);
            menu.aboutToClose.connect(() => onHide());
            menu.open(anchor.x, anchor.y);
            this.contextMenuRenderer.current = new browser_2.ContextMenuAccess(menu);
        }
        this.onDidShowContextMenuEmitter.fire();
    }
    populateMenu(menu, actions) {
        for (const action of actions) {
            if (action instanceof actions_1.SubmenuAction) {
                const submenu = new widgets_1.Menu({ commands: new commands_1.CommandRegistry() });
                submenu.title.label = action.label;
                submenu.title.caption = action.tooltip;
                if (action.class) {
                    submenu.addClass(action.class);
                }
                this.populateMenu(submenu, action.actions);
                menu.addItem({
                    type: 'submenu',
                    submenu
                });
            }
            else if (action instanceof actions_1.Separator) {
                menu.addItem({
                    type: 'separator'
                });
            }
            else {
                menu.commands.addCommand(action.id, {
                    label: action.label,
                    className: action.class,
                    isToggled: () => Boolean(action.checked),
                    isEnabled: () => action.enabled,
                    execute: () => action.run()
                });
                menu.addItem({
                    type: 'command',
                    command: action.id
                });
            }
        }
    }
    menuPath() {
        return browser_1.EDITOR_CONTEXT_MENU;
    }
};
exports.MonacoContextMenuService = MonacoContextMenuService;
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_2.ContextMenuRenderer),
    tslib_1.__metadata("design:type", browser_2.ContextMenuRenderer)
], MonacoContextMenuService.prototype, "contextMenuRenderer", void 0);
exports.MonacoContextMenuService = MonacoContextMenuService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MonacoContextMenuService);
//# sourceMappingURL=monaco-context-menu.js.map