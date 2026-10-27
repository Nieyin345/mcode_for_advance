"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource GmbH.
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
exports.AiCoreCommandContribution = exports.AI_SHOW_SETTINGS_COMMAND = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const ai_command_handler_factory_1 = require("./ai-command-handler-factory");
const inversify_1 = require("@theia/core/shared/inversify");
exports.AI_SHOW_SETTINGS_COMMAND = core_1.Command.toLocalizedCommand({
    id: 'ai-chat-ui.show-settings',
    label: 'Show AI Settings',
    iconClass: (0, browser_1.codicon)('settings-gear'),
});
let AiCoreCommandContribution = class AiCoreCommandContribution {
    registerCommands(commands) {
        commands.registerCommand(exports.AI_SHOW_SETTINGS_COMMAND, this.handlerFactory({
            // An explicit AI preference id opens the Settings UI focused on it; anything else (no argument, or
            // the widget the chat toolbar passes) falls back to the whole AI section. `@theia/ai-ide` overrides
            // this handler to open the AI Configuration view instead, forwarding the same argument.
            execute: (target) => commands.executeCommand(browser_1.CommonCommands.OPEN_PREFERENCES.id, typeof target === 'string' && target.trim() ? target : 'ai-features'),
        }));
    }
};
exports.AiCoreCommandContribution = AiCoreCommandContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_command_handler_factory_1.AICommandHandlerFactory),
    tslib_1.__metadata("design:type", Function)
], AiCoreCommandContribution.prototype, "handlerFactory", void 0);
exports.AiCoreCommandContribution = AiCoreCommandContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AiCoreCommandContribution);
//# sourceMappingURL=ai-core-command-contribution.js.map