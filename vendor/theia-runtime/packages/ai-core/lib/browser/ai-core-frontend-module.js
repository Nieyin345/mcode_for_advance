"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@theia/core");
const service_connection_provider_1 = require("@theia/core/lib/browser/messaging/service-connection-provider");
const inversify_1 = require("@theia/core/shared/inversify");
const frontend_language_model_alias_registry_1 = require("./frontend-language-model-alias-registry");
const hide_ai_preferences_contribution_1 = require("./hide-ai-preferences-contribution");
const model_discovery_status_service_1 = require("./model-discovery-status-service");
const favorite_models_service_1 = require("./favorite-models-service");
const trust_aware_preference_reader_1 = require("./trust-aware-preference-reader");
const ai_configuration_service_impl_1 = require("./ai-configuration-service-impl");
const language_model_alias_1 = require("../common/language-model-alias");
const common_1 = require("../common");
const frontend_language_model_registry_1 = require("./frontend-language-model-registry");
const browser_1 = require("@theia/core/lib/browser");
const tab_bar_toolbar_1 = require("@theia/core/lib/browser/shell/tab-bar-toolbar");
const textmate_1 = require("@theia/monaco/lib/browser/textmate");
const ai_core_frontend_application_contribution_1 = require("./ai-core-frontend-application-contribution");
const ai_core_preferences_1 = require("../common/ai-core-preferences");
const ai_settings_service_1 = require("./ai-settings-service");
const frontend_prompt_customization_service_1 = require("./frontend-prompt-customization-service");
const frontend_variable_service_1 = require("./frontend-variable-service");
const prompttemplate_contribution_1 = require("./prompttemplate-contribution");
const file_variable_contribution_1 = require("./file-variable-contribution");
const theia_variable_contribution_1 = require("./theia-variable-contribution");
const today_variable_contribution_1 = require("../common/today-variable-contribution");
const agents_variable_contribution_1 = require("../common/agents-variable-contribution");
const open_editors_variable_contribution_1 = require("./open-editors-variable-contribution");
const skills_variable_contribution_1 = require("./skills-variable-contribution");
const ai_activation_service_1 = require("./ai-activation-service");
const agent_service_1 = require("../common/agent-service");
const ai_command_handler_factory_1 = require("./ai-command-handler-factory");
const settings_service_1 = require("../common/settings-service");
const skill_service_1 = require("./skill-service");
const skill_prompt_coordinator_1 = require("./skill-prompt-coordinator");
const ai_core_command_contribution_1 = require("./ai-core-command-contribution");
const prompt_variable_contribution_1 = require("./prompt-variable-contribution");
const product_name_variable_contribution_1 = require("./product-name-variable-contribution");
const capability_variable_contribution_1 = require("../common/capability-variable-contribution");
const generic_capabilities_variable_contribution_1 = require("./generic-capabilities-variable-contribution");
const generic_capabilities_prompt_fragment_contribution_1 = require("./generic-capabilities-prompt-fragment-contribution");
const language_model_service_1 = require("../common/language-model-service");
const frontend_language_model_service_1 = require("./frontend-language-model-service");
const token_usage_frontend_service_1 = require("./token-usage-frontend-service");
const token_usage_frontend_service_impl_1 = require("./token-usage-frontend-service-impl");
const ai_variable_uri_label_provider_1 = require("./ai-variable-uri-label-provider");
const agent_notification_service_1 = require("./agent-notification-service");
const os_notification_service_1 = require("./os-notification-service");
const window_blink_service_1 = require("./window-blink-service");
exports.default = new inversify_1.ContainerModule(bind => {
    (0, core_1.bindRootContributionProvider)(bind, common_1.Agent);
    (0, core_1.bindRootContributionProvider)(bind, common_1.LanguageModelProvider);
    bind(frontend_language_model_registry_1.FrontendLanguageModelRegistryImpl).toSelf().inSingletonScope();
    bind(common_1.FrontendLanguageModelRegistry).toService(frontend_language_model_registry_1.FrontendLanguageModelRegistryImpl);
    bind(common_1.LanguageModelRegistry).toService(frontend_language_model_registry_1.FrontendLanguageModelRegistryImpl);
    bind(frontend_language_model_registry_1.LanguageModelDelegateClientImpl).toSelf().inSingletonScope();
    bind(common_1.LanguageModelDelegateClient).toService(frontend_language_model_registry_1.LanguageModelDelegateClientImpl);
    bind(common_1.LanguageModelRegistryClient).toService(common_1.LanguageModelDelegateClient);
    bind(common_1.LanguageModelRegistryFrontendDelegate).toDynamicValue(ctx => {
        const connection = ctx.container.get(service_connection_provider_1.RemoteConnectionProvider);
        const client = ctx.container.get(common_1.LanguageModelRegistryClient);
        return connection.createProxy(common_1.languageModelRegistryDelegatePath, client);
    });
    bind(common_1.LanguageModelFrontendDelegate)
        .toDynamicValue(ctx => {
        const connection = ctx.container.get(service_connection_provider_1.RemoteConnectionProvider);
        const client = ctx.container.get(common_1.LanguageModelDelegateClient);
        return connection.createProxy(common_1.languageModelDelegatePath, client);
    })
        .inSingletonScope();
    (0, ai_core_preferences_1.bindAICorePreferences)(bind);
    bind(frontend_prompt_customization_service_1.DefaultPromptFragmentCustomizationService).toSelf().inSingletonScope();
    bind(common_1.PromptFragmentCustomizationService).toService(frontend_prompt_customization_service_1.DefaultPromptFragmentCustomizationService);
    bind(common_1.PromptServiceImpl).toSelf().inSingletonScope();
    bind(common_1.PromptService).toService(common_1.PromptServiceImpl);
    bind(prompttemplate_contribution_1.PromptTemplateContribution).toSelf().inSingletonScope();
    bind(textmate_1.LanguageGrammarDefinitionContribution).toService(prompttemplate_contribution_1.PromptTemplateContribution);
    bind(core_1.CommandContribution).toService(prompttemplate_contribution_1.PromptTemplateContribution);
    bind(tab_bar_toolbar_1.TabBarToolbarContribution).toService(prompttemplate_contribution_1.PromptTemplateContribution);
    bind(ai_settings_service_1.AISettingsServiceImpl).toSelf().inSingletonScope();
    bind(settings_service_1.AISettingsService).toService(ai_settings_service_1.AISettingsServiceImpl);
    bind(skill_service_1.DefaultSkillService).toSelf().inSingletonScope();
    bind(skill_service_1.SkillService).toService(skill_service_1.DefaultSkillService);
    bind(skill_prompt_coordinator_1.SkillPromptCoordinator).toSelf().inSingletonScope();
    bind(browser_1.FrontendApplicationContribution).toService(skill_prompt_coordinator_1.SkillPromptCoordinator);
    (0, core_1.bindRootContributionProvider)(bind, skill_service_1.SkillDirectoryContribution);
    (0, core_1.bindRootContributionProvider)(bind, common_1.AIVariableContribution);
    bind(frontend_variable_service_1.DefaultFrontendVariableService).toSelf().inSingletonScope();
    bind(frontend_variable_service_1.FrontendVariableService).toService(frontend_variable_service_1.DefaultFrontendVariableService);
    bind(common_1.AIVariableService).toService(frontend_variable_service_1.FrontendVariableService);
    bind(browser_1.FrontendApplicationContribution).toService(frontend_variable_service_1.FrontendVariableService);
    bind(theia_variable_contribution_1.TheiaVariableContribution).toSelf().inSingletonScope();
    bind(common_1.AIVariableContribution).toService(theia_variable_contribution_1.TheiaVariableContribution);
    bind(prompt_variable_contribution_1.PromptVariableContribution).toSelf().inSingletonScope();
    bind(common_1.AIVariableContribution).toService(prompt_variable_contribution_1.PromptVariableContribution);
    bind(common_1.AIVariableContribution).to(today_variable_contribution_1.TodayVariableContribution).inSingletonScope();
    bind(common_1.AIVariableContribution).to(file_variable_contribution_1.FileVariableContribution).inSingletonScope();
    bind(agents_variable_contribution_1.AgentsVariableContribution).toSelf().inSingletonScope();
    bind(common_1.AIVariableContribution).toService(agents_variable_contribution_1.AgentsVariableContribution);
    bind(common_1.AIVariableContribution).to(open_editors_variable_contribution_1.OpenEditorsVariableContribution).inSingletonScope();
    bind(skills_variable_contribution_1.SkillsVariableContribution).toSelf().inSingletonScope();
    bind(common_1.AIVariableContribution).toService(skills_variable_contribution_1.SkillsVariableContribution);
    bind(common_1.AIVariableContribution).to(capability_variable_contribution_1.CapabilityVariableContribution).inSingletonScope();
    bind(common_1.AIVariableContribution).to(product_name_variable_contribution_1.ProductNameVariableContribution).inSingletonScope();
    bind(generic_capabilities_variable_contribution_1.GenericCapabilitiesVariableContribution).toSelf().inSingletonScope();
    bind(common_1.AIVariableContribution).toService(generic_capabilities_variable_contribution_1.GenericCapabilitiesVariableContribution);
    bind(generic_capabilities_prompt_fragment_contribution_1.GenericCapabilitiesPromptFragmentContribution).toSelf().inSingletonScope();
    bind(browser_1.FrontendApplicationContribution).toService(generic_capabilities_prompt_fragment_contribution_1.GenericCapabilitiesPromptFragmentContribution);
    bind(browser_1.FrontendApplicationContribution).to(ai_core_frontend_application_contribution_1.AICoreFrontendApplicationContribution).inSingletonScope();
    bind(common_1.ToolInvocationRegistry).to(common_1.ToolInvocationRegistryImpl).inSingletonScope();
    (0, core_1.bindRootContributionProvider)(bind, common_1.ToolProvider);
    bind(ai_activation_service_1.AIActivationServiceImpl).toSelf().inSingletonScope();
    bind(ai_activation_service_1.AIActivationService).toService(ai_activation_service_1.AIActivationServiceImpl);
    bind(browser_1.FrontendApplicationContribution).toService(ai_activation_service_1.AIActivationService);
    bind(agent_service_1.AgentServiceImpl).toSelf().inSingletonScope();
    bind(agent_service_1.AgentService).toService(agent_service_1.AgentServiceImpl);
    bind(ai_command_handler_factory_1.AICommandHandlerFactory).toFactory(context => (handler) => {
        const activationService = context.container.get(ai_activation_service_1.AIActivationService);
        return {
            execute: (...args) => handler.execute(...args),
            isEnabled: (...args) => activationService.canRun && (handler.isEnabled?.(...args) ?? true),
            isVisible: (...args) => activationService.isActive && (handler.isVisible?.(...args) ?? true),
            isToggled: handler.isToggled
        };
    });
    bind(ai_core_command_contribution_1.AiCoreCommandContribution).toSelf().inSingletonScope();
    bind(core_1.CommandContribution).toService(ai_core_command_contribution_1.AiCoreCommandContribution);
    bind(frontend_language_model_service_1.FrontendLanguageModelServiceImpl).toSelf().inSingletonScope();
    bind(language_model_service_1.LanguageModelService).toService(frontend_language_model_service_1.FrontendLanguageModelServiceImpl);
    bind(token_usage_frontend_service_1.TokenUsageFrontendService).to(token_usage_frontend_service_impl_1.TokenUsageFrontendServiceImpl).inSingletonScope();
    bind(common_1.TokenUsageServiceClient).to(token_usage_frontend_service_impl_1.TokenUsageServiceClientImpl).inSingletonScope();
    bind(frontend_language_model_alias_registry_1.DefaultLanguageModelAliasRegistry).toSelf().inSingletonScope();
    bind(language_model_alias_1.LanguageModelAliasRegistry).toService(frontend_language_model_alias_registry_1.DefaultLanguageModelAliasRegistry);
    // Hide all AI preferences from the Settings UI; they are managed in the AI Configuration view (#316).
    bind(core_1.PreferenceContribution).to(hide_ai_preferences_contribution_1.HideAiPreferencesContribution).inSingletonScope();
    // ...and leave a single placeholder entry there that links to the AI Configuration view.
    bind(core_1.PreferenceContribution).toConstantValue({ schema: hide_ai_preferences_contribution_1.aiConfigurationOpenPlaceholderSchema });
    bind(model_discovery_status_service_1.ModelDiscoveryStatusService).toSelf().inSingletonScope();
    bind(favorite_models_service_1.FavoriteModelsService).toSelf().inSingletonScope();
    // Internal implementation detail of AiConfigurationService; consumers inject AiConfigurationService.
    bind(trust_aware_preference_reader_1.TrustAwarePreferenceReader).toSelf().inSingletonScope();
    bind(ai_configuration_service_impl_1.AiConfigurationServiceImpl).toSelf().inSingletonScope();
    bind(common_1.AiConfigurationService).toService(ai_configuration_service_impl_1.AiConfigurationServiceImpl);
    bind(common_1.TokenUsageService).toDynamicValue(ctx => {
        const connection = ctx.container.get(service_connection_provider_1.RemoteConnectionProvider);
        const client = ctx.container.get(common_1.TokenUsageServiceClient);
        return connection.createProxy(common_1.TOKEN_USAGE_SERVICE_PATH, client);
    }).inSingletonScope();
    bind(common_1.AIVariableResourceResolver).toSelf().inSingletonScope();
    bind(core_1.ResourceResolver).toService(common_1.AIVariableResourceResolver);
    bind(ai_variable_uri_label_provider_1.AIVariableUriLabelProvider).toSelf().inSingletonScope();
    bind(browser_1.LabelProviderContribution).toService(ai_variable_uri_label_provider_1.AIVariableUriLabelProvider);
    bind(agent_notification_service_1.AgentNotificationService).toSelf().inSingletonScope();
    bind(os_notification_service_1.OSNotificationService).toSelf().inSingletonScope();
    bind(window_blink_service_1.WindowBlinkService).toSelf().inSingletonScope();
    bind(common_1.ConfigurableInMemoryResources).toSelf().inSingletonScope();
    bind(core_1.ResourceResolver).toService(common_1.ConfigurableInMemoryResources);
});
//# sourceMappingURL=ai-core-frontend-module.js.map