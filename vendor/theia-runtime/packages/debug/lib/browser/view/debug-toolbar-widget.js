"use strict";
var DebugToolBar_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DebugToolBar = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
const React = require("@theia/core/shared/react");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
const widgets_1 = require("@theia/core/lib/browser/widgets");
const debug_view_model_1 = require("./debug-view-model");
const debug_action_1 = require("./debug-action");
let DebugToolBar = class DebugToolBar extends widgets_1.ReactWidget {
    static { DebugToolBar_1 = this; }
    static { this.MENU = ['debug-toolbar-menu']; }
    static { this.CONTROLS = [...DebugToolBar_1.MENU, 'z_controls']; }
    init() {
        this.id = 'debug:toolbar:' + this.model.id;
        this.addClass('debug-toolbar');
        this.toDispose.push(this.model);
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.toDispose.push(this.keybindingRegistry.onKeybindingsChanged(() => this.update()));
        this.scrollOptions = undefined;
        this.update();
    }
    render() {
        return (0, jsx_runtime_1.jsx)(React.Fragment, { children: this.renderContributedCommands() });
    }
    renderContributedCommands() {
        const debugActions = [];
        // first, search for CompoundMenuNodes:
        this.menuModelRegistry.getMenu(DebugToolBar_1.MENU).children.forEach(compoundMenuNode => {
            if (core_1.CompoundMenuNode.is(compoundMenuNode) && compoundMenuNode.isVisible(DebugToolBar_1.MENU, this.contextKeyService, this.node)) {
                // second, search for nested CommandMenuNodes:
                compoundMenuNode.children.forEach(commandMenuNode => {
                    if (core_1.CommandMenu.is(commandMenuNode) && commandMenuNode.isVisible(DebugToolBar_1.MENU, this.contextKeyService, this.node)) {
                        debugActions.push(this.debugAction(commandMenuNode));
                    }
                });
            }
        });
        return debugActions;
    }
    debugAction(commandMenuNode) {
        const accelerator = this.acceleratorFor(commandMenuNode.id);
        const run = (effectiveMenuPath) => commandMenuNode.run(effectiveMenuPath).catch(e => this.logger.error(e));
        return (0, jsx_runtime_1.jsx)(debug_action_1.DebugAction, { enabled: commandMenuNode.isEnabled(DebugToolBar_1.MENU), label: commandMenuNode.label, tooltip: commandMenuNode.label + (accelerator ? ` (${accelerator})` : ''), iconClass: commandMenuNode.icon || '', run: run }, commandMenuNode.id);
    }
    acceleratorFor(commandId) {
        const keybindings = this.keybindingRegistry.getKeybindingsForCommand(commandId);
        return keybindings.length ? this.keybindingRegistry.acceleratorFor(keybindings[0], '+').join(' ') : undefined;
    }
};
exports.DebugToolBar = DebugToolBar;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MenuModelRegistry),
    tslib_1.__metadata("design:type", core_1.MenuModelRegistry)
], DebugToolBar.prototype, "menuModelRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(browser_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", browser_1.KeybindingRegistry)
], DebugToolBar.prototype, "keybindingRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], DebugToolBar.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_view_model_1.DebugViewModel),
    tslib_1.__metadata("design:type", debug_view_model_1.DebugViewModel)
], DebugToolBar.prototype, "model", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('debug:DebugToolBar'),
    tslib_1.__metadata("design:type", Object)
], DebugToolBar.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugToolBar.prototype, "init", null);
exports.DebugToolBar = DebugToolBar = DebugToolBar_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugToolBar);
//# sourceMappingURL=debug-toolbar-widget.js.map