"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIViewContribution = void 0;
const tslib_1 = require("tslib");
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const ai_activation_service_1 = require("./ai-activation-service");
const ai_command_handler_factory_1 = require("./ai-command-handler-factory");
let AIViewContribution = class AIViewContribution extends browser_1.AbstractViewContribution {
    init() {
        this.activationService.onDidChangeActiveStatus(active => {
            if (!active) {
                this.closeView();
            }
        });
    }
    registerCommands(commands) {
        if (this.toggleCommand) {
            commands.registerCommand(this.toggleCommand, this.commandHandlerFactory({
                execute: () => this.toggleView(),
            }));
        }
        this.quickView?.registerItem({
            label: this.viewLabel,
            when: ai_activation_service_1.ENABLE_AI_CONTEXT_KEY,
            open: () => this.openView({ activate: true })
        });
    }
    registerMenus(menus) {
        if (this.toggleCommand) {
            menus.registerMenuAction(browser_1.CommonMenus.VIEW_VIEWS, {
                commandId: this.toggleCommand.id,
                when: ai_activation_service_1.ENABLE_AI_CONTEXT_KEY,
                label: this.viewLabel
            });
        }
    }
    registerKeybindings(keybindings) {
        if (this.toggleCommand && this.options.toggleKeybinding) {
            keybindings.registerKeybinding({
                command: this.toggleCommand.id,
                when: ai_activation_service_1.ENABLE_AI_CONTEXT_KEY,
                keybinding: this.options.toggleKeybinding
            });
        }
    }
};
exports.AIViewContribution = AIViewContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], AIViewContribution.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_activation_service_1.AIActivationService),
    tslib_1.__metadata("design:type", Object)
], AIViewContribution.prototype, "activationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_command_handler_factory_1.AICommandHandlerFactory),
    tslib_1.__metadata("design:type", Function)
], AIViewContribution.prototype, "commandHandlerFactory", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], AIViewContribution.prototype, "init", null);
exports.AIViewContribution = AIViewContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AIViewContribution);
//# sourceMappingURL=ai-view-contribution.js.map