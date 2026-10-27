"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.AiConfigurationSettingCommandContribution = exports.AiConfigurationSettingCommands = exports.AiConfigurationSettingCommandArgs = exports.AI_CONFIGURATION_SETTING_CONTEXT_MENU = void 0;
exports.bindAiConfigurationSettingCommands = bindAiConfigurationSettingCommands;
const tslib_1 = require("tslib");
const ai_core_1 = require("@theia/ai-core");
const core_1 = require("@theia/core");
const clipboard_service_1 = require("@theia/core/lib/browser/clipboard-service");
const inversify_1 = require("@theia/core/shared/inversify");
/** Context-menu path for the AI Configuration setting-row gear. */
exports.AI_CONFIGURATION_SETTING_CONTEXT_MENU = ['ai-configuration-setting-context-menu'];
var AiConfigurationSettingCommandArgs;
(function (AiConfigurationSettingCommandArgs) {
    /** Preference-backed args: `id` + `scope` present (enables Copy and preference reset). */
    function isPreference(arg) {
        return typeof arg === 'object' && arg !== undefined
            && typeof arg.id === 'string'
            && typeof arg.scope === 'number';
    }
    AiConfigurationSettingCommandArgs.isPreference = isPreference;
    /** Resettable args: either preference-backed or carrying a `reset` callback. */
    function isResettable(arg) {
        return isPreference(arg) || (typeof arg === 'object' && arg !== undefined && typeof arg.reset === 'function');
    }
    AiConfigurationSettingCommandArgs.isResettable = isResettable;
})(AiConfigurationSettingCommandArgs || (exports.AiConfigurationSettingCommandArgs = AiConfigurationSettingCommandArgs = {}));
var AiConfigurationSettingCommands;
(function (AiConfigurationSettingCommands) {
    AiConfigurationSettingCommands.RESET = { id: 'ai-configuration.setting.reset', label: core_1.nls.localizeByDefault('Reset Setting') };
    AiConfigurationSettingCommands.COPY_ID = { id: 'ai-configuration.setting.copyId', label: core_1.nls.localizeByDefault('Copy Setting ID') };
    AiConfigurationSettingCommands.COPY_JSON = { id: 'ai-configuration.setting.copyJson', label: core_1.nls.localizeByDefault('Copy Setting as JSON') };
})(AiConfigurationSettingCommands || (exports.AiConfigurationSettingCommands = AiConfigurationSettingCommands = {}));
/**
 * Commands + menu for the AI Configuration setting-row gear, mirroring the Settings UI's preference
 * context menu (Reset / Copy Setting ID / Copy as JSON) but backed by {@link AiConfigurationService} and
 * acting in the row's own scope. Kept self-contained here rather than reusing the Settings UI's
 * `RESET_PREFERENCE` command, which is bound to the Preferences editor widget (its scope tracker) and
 * misbehaves when invoked from this view.
 */
let AiConfigurationSettingCommandContribution = class AiConfigurationSettingCommandContribution {
    registerCommands(commands) {
        commands.registerCommand(AiConfigurationSettingCommands.RESET, {
            isEnabled: AiConfigurationSettingCommandArgs.isResettable,
            isVisible: AiConfigurationSettingCommandArgs.isResettable,
            execute: (args) => args.reset
                ? args.reset()
                : this.aiConfigurationService.set(args.id, undefined, args.scope, args.resourceUri)
        });
        commands.registerCommand(AiConfigurationSettingCommands.COPY_ID, {
            isEnabled: AiConfigurationSettingCommandArgs.isPreference,
            isVisible: AiConfigurationSettingCommandArgs.isPreference,
            execute: (args) => this.clipboardService.writeText(args.id)
        });
        commands.registerCommand(AiConfigurationSettingCommands.COPY_JSON, {
            isEnabled: AiConfigurationSettingCommandArgs.isPreference,
            isVisible: AiConfigurationSettingCommandArgs.isPreference,
            execute: (args) => this.clipboardService.writeText(`"${args.id}": ${JSON.stringify(args.value)}`)
        });
    }
    registerMenus(menus) {
        menus.registerMenuAction(exports.AI_CONFIGURATION_SETTING_CONTEXT_MENU, { commandId: AiConfigurationSettingCommands.RESET.id, order: 'a' });
        menus.registerMenuAction(exports.AI_CONFIGURATION_SETTING_CONTEXT_MENU, { commandId: AiConfigurationSettingCommands.COPY_ID.id, order: 'b' });
        menus.registerMenuAction(exports.AI_CONFIGURATION_SETTING_CONTEXT_MENU, { commandId: AiConfigurationSettingCommands.COPY_JSON.id, order: 'c' });
    }
};
exports.AiConfigurationSettingCommandContribution = AiConfigurationSettingCommandContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_core_1.AiConfigurationService),
    tslib_1.__metadata("design:type", Object)
], AiConfigurationSettingCommandContribution.prototype, "aiConfigurationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(clipboard_service_1.ClipboardService),
    tslib_1.__metadata("design:type", Object)
], AiConfigurationSettingCommandContribution.prototype, "clipboardService", void 0);
exports.AiConfigurationSettingCommandContribution = AiConfigurationSettingCommandContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AiConfigurationSettingCommandContribution);
function bindAiConfigurationSettingCommands(bind) {
    bind(AiConfigurationSettingCommandContribution).toSelf().inSingletonScope();
    bind(core_1.CommandContribution).toService(AiConfigurationSettingCommandContribution);
    bind(core_1.MenuContribution).toService(AiConfigurationSettingCommandContribution);
}
//# sourceMappingURL=ai-configuration-setting-commands.js.map