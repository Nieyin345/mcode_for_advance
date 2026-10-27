"use strict";
// *****************************************************************************
// Copyright (C) 2024 STMicroelectronics and others.
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
exports.BrowserMenuNodeFactory = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const common_1 = require("../../common");
const context_key_service_1 = require("../context-key-service");
const keybinding_1 = require("../keybinding");
let BrowserMenuNodeFactory = class BrowserMenuNodeFactory {
    createGroup(id, orderString, when) {
        return new common_1.GroupImpl(id, orderString, when);
    }
    createCommandMenu(item) {
        return new common_1.ActionMenuNode(item, this.commandRegistry, this.keybindingRegistry, this.contextKeyService);
    }
    createSubmenu(id, label, contextKeyOverlays, orderString, icon, when) {
        return new common_1.SubmenuImpl(id, label, contextKeyOverlays, orderString, icon, when);
    }
    createSubmenuLink(delegate, sortString, when) {
        return new common_1.SubMenuLink(delegate, sortString, when);
    }
};
exports.BrowserMenuNodeFactory = BrowserMenuNodeFactory;
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], BrowserMenuNodeFactory.prototype, "contextKeyService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.CommandRegistry),
    tslib_1.__metadata("design:type", common_1.CommandRegistry)
], BrowserMenuNodeFactory.prototype, "commandRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(keybinding_1.KeybindingRegistry),
    tslib_1.__metadata("design:type", keybinding_1.KeybindingRegistry)
], BrowserMenuNodeFactory.prototype, "keybindingRegistry", void 0);
exports.BrowserMenuNodeFactory = BrowserMenuNodeFactory = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserMenuNodeFactory);
//# sourceMappingURL=browser-menu-node-factory.js.map