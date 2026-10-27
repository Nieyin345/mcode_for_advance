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
const chai_1 = require("chai");
const core_1 = require("@theia/core");
const ai_configuration_setting_commands_1 = require("./ai-configuration-setting-commands");
function setup() {
    const setCalls = [];
    const copied = [];
    const contribution = new ai_configuration_setting_commands_1.AiConfigurationSettingCommandContribution();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contribution.aiConfigurationService = {
        set: (id, value, scope, resourceUri) => { setCalls.push([id, value, scope, resourceUri]); return Promise.resolve(); }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contribution.clipboardService = { writeText: (text) => { copied.push(text); } };
    const handlers = new Map();
    contribution.registerCommands({ registerCommand: (command, handler) => handlers.set(command.id, handler) });
    return { handlers, setCalls, copied };
}
const args = { id: 'ai-features.chat.foo', value: true, scope: core_1.PreferenceScope.User };
describe('AiConfigurationSettingCommandContribution', () => {
    it('resets a setting in the row scope via AiConfigurationService (not the Settings widget)', () => {
        const { handlers, setCalls } = setup();
        handlers.get(ai_configuration_setting_commands_1.AiConfigurationSettingCommands.RESET.id).execute({ ...args, scope: core_1.PreferenceScope.Workspace, resourceUri: 'file:///ws' });
        (0, chai_1.expect)(setCalls).to.deep.equal([['ai-features.chat.foo', undefined, core_1.PreferenceScope.Workspace, 'file:///ws']]);
    });
    it('resets via the supplied callback for non-preference (e.g. per-agent) rows, without touching AiConfigurationService', () => {
        const { handlers, setCalls } = setup();
        let called = 0;
        const reset = handlers.get(ai_configuration_setting_commands_1.AiConfigurationSettingCommands.RESET.id);
        (0, chai_1.expect)(reset.isVisible({ reset: () => called++ })).to.equal(true);
        reset.execute({ reset: () => called++ });
        (0, chai_1.expect)(called).to.equal(1);
        (0, chai_1.expect)(setCalls).to.be.empty;
    });
    it('hides the copy commands for non-preference (callback-only) rows', () => {
        const { handlers } = setup();
        (0, chai_1.expect)(handlers.get(ai_configuration_setting_commands_1.AiConfigurationSettingCommands.COPY_ID.id).isVisible({ reset: () => undefined })).to.equal(false);
        (0, chai_1.expect)(handlers.get(ai_configuration_setting_commands_1.AiConfigurationSettingCommands.COPY_JSON.id).isVisible({ reset: () => undefined })).to.equal(false);
    });
    it('copies the setting id and the JSON entry', () => {
        const { handlers, copied } = setup();
        handlers.get(ai_configuration_setting_commands_1.AiConfigurationSettingCommands.COPY_ID.id).execute(args);
        handlers.get(ai_configuration_setting_commands_1.AiConfigurationSettingCommands.COPY_JSON.id).execute(args);
        (0, chai_1.expect)(copied).to.deep.equal(['ai-features.chat.foo', '"ai-features.chat.foo": true']);
    });
    it('guards the commands against malformed arguments', () => {
        const { handlers } = setup();
        const reset = handlers.get(ai_configuration_setting_commands_1.AiConfigurationSettingCommands.RESET.id);
        (0, chai_1.expect)(reset.isVisible(args)).to.equal(true);
        (0, chai_1.expect)(reset.isVisible({ id: 'x' })).to.equal(false); // missing scope
        (0, chai_1.expect)(reset.isVisible(undefined)).to.equal(false);
    });
});
//# sourceMappingURL=ai-configuration-setting-commands.spec.js.map