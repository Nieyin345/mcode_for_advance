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
require("../../src/browser/style/index.css");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const agent_preferences_1 = require("@theia/ai-core/lib/common/agent-preferences");
const ai_core_preferences_1 = require("@theia/ai-core/lib/common/ai-core-preferences");
const ai_configuration_category_1 = require("./ai-configuration/ai-configuration-category");
const ai_configuration_category_registry_1 = require("./ai-configuration/ai-configuration-category-registry");
const ai_configuration_selection_model_1 = require("./ai-configuration/ai-configuration-selection-model");
const ai_settings_row_service_1 = require("./ai-configuration/components/ai-settings-row-service");
const ai_configuration_setting_commands_1 = require("./ai-configuration/ai-configuration-setting-commands");
exports.default = new inversify_1.ContainerModule(bind => {
    bind(core_1.PreferenceContribution).toConstantValue({ schema: agent_preferences_1.AgentSettingsPreferenceSchema });
    bind(core_1.PreferenceContribution).toConstantValue({ schema: ai_core_preferences_1.aiCorePreferenceSchema });
    (0, core_1.bindRootContributionProvider)(bind, ai_configuration_category_1.AiConfigurationCategory);
    bind(ai_configuration_category_registry_1.AiConfigurationCategoryRegistry).toSelf().inSingletonScope();
    bind(ai_configuration_selection_model_1.AiConfigurationSelectionModel).toSelf().inSingletonScope();
    bind(ai_settings_row_service_1.AiSettingsRowService).toSelf().inSingletonScope();
    (0, ai_configuration_setting_commands_1.bindAiConfigurationSettingCommands)(bind);
});
//# sourceMappingURL=ai-core-ui-frontend-module.js.map