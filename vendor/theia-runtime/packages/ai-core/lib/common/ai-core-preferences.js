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
exports.getRequestSettingSpecificity = exports.AICorePreferences = exports.aiCorePreferenceSchema = exports.LANGUAGE_MODEL_ALIASES_PREFERENCE = exports.PREFERENCE_NAME_SERVER_SIDE_COMPACTION_TOKEN_THRESHOLD = exports.PREFERENCE_NAME_SERVER_SIDE_COMPACTION = exports.PREFERENCE_NAME_SKILL_DIRECTORIES = exports.PREFERENCE_NAME_DEFAULT_NOTIFICATION_TYPE = exports.PREFERENCE_NAME_HIDDEN_MODELS = exports.PREFERENCE_NAME_FAVORITE_MODELS = exports.PREFERENCE_NAME_MAX_RETRIES = exports.PREFERENCE_NAME_REASONING = exports.PREFERENCE_NAME_REQUEST_SETTINGS = exports.PREFERENCE_NAME_PROMPT_TEMPLATES = exports.DEDICATED_EDITOR_TYPE_DETAIL = exports.MODEL_PROVIDER_TYPE_DETAIL = exports.AI_CORE_PREFERENCES_TITLE = void 0;
exports.bindAICorePreferences = bindAICorePreferences;
const core_1 = require("@theia/core");
const notification_types_1 = require("./notification-types");
const language_model_1 = require("./language-model");
exports.AI_CORE_PREFERENCES_TITLE = core_1.nls.localize('theia/ai-core/preferences/title', 'AI Features');
/**
 * Key under a preference's schema `typeDetails` where a language-model provider declares the
 * human-readable name of its provider block. The AI Configuration view's Models page reads this to
 * label the provider node (discovered from the `ai-features.<provider>.*` preferences) without
 * having to hard-code provider names. Declare it on any one preference of the provider's block, e.g.
 * `typeDetails: { [MODEL_PROVIDER_TYPE_DETAIL]: 'Anthropic' }`.
 */
exports.MODEL_PROVIDER_TYPE_DETAIL = 'aiModelProvider';
/**
 * Key under a preference's schema `typeDetails` marking a preference that the AI Configuration view
 * edits through a dedicated control of its own, so it should not also appear as a raw settings row.
 * The value stays a plain preference, editable in `settings.json` like any other; it is only the
 * duplicate, less legible editor that is left out. Declare it as
 * `typeDetails: { [DEDICATED_EDITOR_TYPE_DETAIL]: true }`.
 */
exports.DEDICATED_EDITOR_TYPE_DETAIL = 'aiDedicatedEditor';
exports.PREFERENCE_NAME_PROMPT_TEMPLATES = 'ai-features.promptTemplates.promptTemplatesFolder';
exports.PREFERENCE_NAME_REQUEST_SETTINGS = 'ai-features.modelSettings.requestSettings';
exports.PREFERENCE_NAME_REASONING = 'ai-features.reasoning.defaults';
exports.PREFERENCE_NAME_MAX_RETRIES = 'ai-features.modelSettings.maxRetries';
exports.PREFERENCE_NAME_FAVORITE_MODELS = 'ai-features.modelSettings.favoriteModels';
exports.PREFERENCE_NAME_HIDDEN_MODELS = 'ai-features.modelSettings.hiddenModels';
exports.PREFERENCE_NAME_DEFAULT_NOTIFICATION_TYPE = 'ai-features.notifications.default';
exports.PREFERENCE_NAME_SKILL_DIRECTORIES = 'ai-features.skills.skillDirectories';
exports.PREFERENCE_NAME_SERVER_SIDE_COMPACTION = 'ai-features.chat.serverSideCompaction';
exports.PREFERENCE_NAME_SERVER_SIDE_COMPACTION_TOKEN_THRESHOLD = 'ai-features.chat.serverSideCompactionTokenThreshold';
exports.LANGUAGE_MODEL_ALIASES_PREFERENCE = 'ai-features.languageModelAliases';
exports.aiCorePreferenceSchema = {
    properties: {
        [exports.PREFERENCE_NAME_SERVER_SIDE_COMPACTION]: {
            title: exports.AI_CORE_PREFERENCES_TITLE,
            type: 'boolean',
            description: core_1.nls.localize('theia/ai/core/serverSideCompaction/description', 'Enable provider-native server-side compaction by default for chat requests. When on, models that support it ' +
                'may automatically summarize older turns once the conversation grows past their own threshold, letting long ' +
                'sessions continue past the context limit. Each provider offers its own override, and individual chat sessions ' +
                'can override this in their session settings. Models without support ignore it.'),
            default: true,
        },
        [exports.PREFERENCE_NAME_SERVER_SIDE_COMPACTION_TOKEN_THRESHOLD]: {
            title: exports.AI_CORE_PREFERENCES_TITLE,
            type: 'integer',
            minimum: language_model_1.SERVER_SIDE_COMPACTION_TOKEN_THRESHOLD_MINIMUM,
            description: core_1.nls.localize('theia/ai/core/serverSideCompactionTokenThreshold/description', 'Default input-token threshold at which provider-native server-side compaction should run. Providers and individual chat sessions ' +
                'can override this value. When unset, the provider chooses its default threshold. If set, the value must be at least 50,000 tokens.'),
        },
        [exports.PREFERENCE_NAME_PROMPT_TEMPLATES]: {
            title: exports.AI_CORE_PREFERENCES_TITLE,
            description: core_1.nls.localize('theia/ai/core/promptTemplates/description', 'Folder for storing customized prompt templates. If not customized the user config directory is used. Please consider to use a folder, which is\
            under version control to manage your variants of prompt templates.'),
            type: 'string',
            default: '',
            typeDetails: {
                isFilepath: true,
                selectionProps: {
                    openLabel: core_1.nls.localizeByDefault('Select Folder'),
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                }
            },
        },
        [exports.PREFERENCE_NAME_REQUEST_SETTINGS]: {
            title: core_1.nls.localize('theia/ai/core/requestSettings/title', 'Custom Request Settings'),
            markdownDescription: core_1.nls.localize('theia/ai/core/requestSettings/mdDescription', 'Allows specifying custom request settings for multiple models.\n\
            Each setting consists of:\n\
            - `scope`: Defines when the setting applies:\n\
              - `modelId` (optional): The model ID to match\n\
              - `providerId` (optional): The provider ID to match (e.g., huggingface, openai, ollama, llamafile)\n\
              - `agentId` (optional): The agent ID to match\n\
            - `requestSettings`: Model-specific settings as key-value pairs\n\
            - `clientSettings`: Client-side message handling settings:\n\
              - `keepToolCalls` (boolean): Whether to keep tool calls in the context\n\
              - `keepThinking` (boolean): Whether to keep thinking messages\n\
            Settings are matched based on specificity (agent: 100, model: 10, provider: 1 points).\n\
            Refer to [our documentation](https://theia-ide.org/docs/user_ai/#custom-request-settings) for more information.'),
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    scope: {
                        type: 'object',
                        properties: {
                            modelId: {
                                type: 'string',
                                description: core_1.nls.localize('theia/ai/core/requestSettings/scope/modelId/description', 'The (optional) model id')
                            },
                            providerId: {
                                type: 'string',
                                description: core_1.nls.localize('theia/ai/core/requestSettings/scope/providerId/description', 'The (optional) provider id to apply the settings to.'),
                            },
                            agentId: {
                                type: 'string',
                                description: core_1.nls.localize('theia/ai/core/requestSettings/scope/agentId/description', 'The (optional) agent id to apply the settings to.'),
                            },
                        }
                    },
                    requestSettings: {
                        type: 'object',
                        additionalProperties: true,
                        description: core_1.nls.localize('theia/ai/core/requestSettings/modelSpecificSettings/description', 'Settings for the specific model ID.'),
                    },
                    clientSettings: {
                        type: 'object',
                        additionalProperties: false,
                        description: core_1.nls.localize('theia/ai/core/requestSettings/clientSettings/description', 'Client settings for how to handle messages that are send back to the llm.'),
                        properties: {
                            keepToolCalls: {
                                type: 'boolean',
                                default: true,
                                description: core_1.nls.localize('theia/ai/core/requestSettings/clientSettings/keepToolCalls/description', 'If set to false, all tool request and tool responses will be filtered \
                                    before sending the next user request in a multi-turn conversation.')
                            },
                            keepThinking: {
                                type: 'boolean',
                                default: true,
                                description: core_1.nls.localize('theia/ai/core/requestSettings/clientSettings/keepThinking/description', 'If set to false, all thinking output will be filtered before sending the next user request in a multi-turn conversation.')
                            }
                        }
                    },
                },
                additionalProperties: false
            },
            default: [],
        },
        [exports.PREFERENCE_NAME_MAX_RETRIES]: {
            title: core_1.nls.localize('theia/ai/core/maxRetries/title', 'Maximum Retries'),
            markdownDescription: core_1.nls.localize('theia/ai/core/maxRetries/mdDescription', 'The maximum number of retry attempts when a request to an AI provider fails. A value of 0 means no retries.'),
            type: 'number',
            minimum: 0,
            default: 3
        },
        [exports.PREFERENCE_NAME_FAVORITE_MODELS]: {
            title: core_1.nls.localize('theia/ai/core/favoriteModels/title', 'Favorite Models'),
            markdownDescription: core_1.nls.localize('theia/ai/core/favoriteModels/mdDescription', 'Models the AI chat input\'s model picker shows in addition to the newest ones of each provider, as fully qualified ids '
                + '(e.g. `anthropic/claude-opus-5`). This is for keeping an older or release-pinned model at hand. Check a model on its '
                + 'provider\'s page in the AI Configuration view to add it.'),
            type: 'array',
            // The provider pages check models one by one; a second, raw editor for the same ids would
            // invite typos and disagree with what the checks say.
            typeDetails: { [exports.DEDICATED_EDITOR_TYPE_DETAIL]: true },
            items: {
                type: 'string'
            },
            default: []
        },
        [exports.PREFERENCE_NAME_HIDDEN_MODELS]: {
            title: core_1.nls.localizeByDefault('Hidden Models'),
            markdownDescription: core_1.nls.localize('theia/ai/core/hiddenModels/mdDescription', 'Models the AI chat input\'s model picker does not show even though it would by default, as fully qualified ids '
                + '(e.g. `google/gemini-flash-lite-latest`). Only the models shown without being listed as a favorite end up here, '
                + 'i.e. the newest ones of a provider. Uncheck a model on its provider\'s page in the AI Configuration view to add it.'),
            type: 'array',
            typeDetails: { [exports.DEDICATED_EDITOR_TYPE_DETAIL]: true },
            items: {
                type: 'string'
            },
            default: []
        },
        [exports.PREFERENCE_NAME_DEFAULT_NOTIFICATION_TYPE]: {
            title: core_1.nls.localize('theia/ai/core/defaultNotification/title', 'Default Notification Type'),
            markdownDescription: core_1.nls.localize('theia/ai/core/defaultNotification/mdDescription', 'The default notification method used when an AI agent needs your attention, i.e. it completed a task or requests your input. '
                + 'Individual agents can override this setting.'),
            type: 'string',
            enum: [...notification_types_1.NOTIFICATION_TYPES],
            enumItemLabels: notification_types_1.NOTIFICATION_TYPES.map(type => notification_types_1.NOTIFICATION_TYPE_LABELS[type]),
            enumDescriptions: notification_types_1.NOTIFICATION_TYPES.map(type => notification_types_1.NOTIFICATION_TYPE_DESCRIPTIONS[type]),
            default: notification_types_1.NOTIFICATION_TYPE_OFF
        },
        [exports.PREFERENCE_NAME_SKILL_DIRECTORIES]: {
            description: core_1.nls.localize('theia/ai/core/skillDirectories/description', 'Additional directories containing skill definitions (SKILL.md files). Skills provide reusable instructions that can be referenced by AI agents. ' +
                'The .prompts/skills and .agents/skills directories in your workspace, the .agents/skills directory in your home directory, ' +
                'and the skills directory in your product\'s configuration folder are always included.'),
            type: 'array',
            items: {
                type: 'string'
            },
            default: []
        },
        [exports.PREFERENCE_NAME_REASONING]: {
            title: core_1.nls.localize('theia/ai/core/reasoning/title', 'Reasoning Defaults'),
            markdownDescription: core_1.nls.localize('theia/ai/core/reasoning/mdDescription', 'Default value for the chat input\'s reasoning selector, applied to models that support reasoning.\n\n'
                + 'This is a UI-level setting: the chosen level is translated to the provider\'s native API parameters'
                + ' at request time (e.g. Anthropic `thinking` / `output_config.effort`, OpenAI `reasoning.effort`,'
                + ' Gemini `thinkingConfig`) and takes precedence over any raw values supplied via'
                + ' `#ai-features.modelSettings.requestSettings#` for the same fields.\n\n'
                + 'Each entry consists of:\n'
                + '- `scope`: Defines when the setting applies (`modelId`, `providerId`, `agentId`).\n'
                + '- `reasoning.level`: One of `off`, `minimal`, `low`, `medium`, `high`, `auto`.\n\n'
                + 'Precedence at runtime (highest first): session override via the selector → this preference →'
                + ' the model\'s declared default. Whichever the selector displays is what gets sent. To override'
                + ' a provider\'s reasoning field manually via `#ai-features.modelSettings.requestSettings#`, set'
                + ' `reasoning.level` to `off` here so the level-based translation is disabled.\n\n'
                + 'Entries are matched based on scope specificity (agent: 100, model: 10, provider: 1 points).\n\n'
                + 'Example:\n'
                + '```json\n'
                + '[\n'
                + '  { "scope": { "providerId": "anthropic" }, "reasoning": { "level": "medium" } },\n'
                + '  { "scope": { "modelId": "openai/gpt-5" }, "reasoning": { "level": "high" } },\n'
                + '  { "scope": { "agentId": "Coder" }, "reasoning": { "level": "off" } }\n'
                + ']\n'
                + '```'),
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    scope: {
                        type: 'object',
                        properties: {
                            modelId: { type: 'string' },
                            providerId: { type: 'string' },
                            agentId: { type: 'string' }
                        }
                    },
                    reasoning: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            level: {
                                type: 'string',
                                enum: ['off', 'minimal', 'low', 'medium', 'high', 'auto'],
                                default: 'auto'
                            }
                        },
                        required: ['level']
                    }
                },
                additionalProperties: false
            },
            default: []
        },
        [exports.LANGUAGE_MODEL_ALIASES_PREFERENCE]: {
            title: core_1.nls.localize('theia/ai/core/preference/languageModelAliases/title', 'Language Model Aliases'),
            markdownDescription: core_1.nls.localize('theia/ai/core/preference/languageModelAliases/description', 'Configure models for each language model alias in the \
[AI Configuration View]({0}). Alternatiely you can set the settings manually in the settings.json: \n\
```\n\
"default/code": {\n\
  "selectedModel": "anthropic/claude-opus-4-20250514"\n\
}\n\```', 'command:aiConfiguration:open'),
            type: 'object',
            additionalProperties: {
                type: 'object',
                properties: {
                    selectedModel: {
                        type: 'string',
                        description: core_1.nls.localize('theia/ai/core/preference/languageModelAliases/selectedModel', 'The user-selected model for this alias.')
                    }
                },
                required: ['selectedModel'],
                additionalProperties: false
            },
            default: {},
        }
    }
};
exports.AICorePreferences = Symbol('AICorePreferences');
function bindAICorePreferences(bind) {
    bind(exports.AICorePreferences).toDynamicValue(ctx => {
        const factory = ctx.container.get(core_1.PreferenceProxyFactory);
        return factory(exports.aiCorePreferenceSchema);
    }).inSingletonScope();
}
/**
 * Calculates the specificity score of a RequestSetting for a given scope.
 * The score is calculated based on matching criteria:
 * - Agent match: 100 points
 * - Model match: 10 points
 * - Provider match: 1 point
 *
 * @param setting RequestSetting object to check against
 * @param scope Optional scope object containing modelId, providerId, and agentId
 * @returns Specificity score (-1 for non-match, or sum of matching criteria points)
 */
const getRequestSettingSpecificity = (setting, scope) => {
    // If no scope is defined in the setting, return default specificity
    if (!setting.scope) {
        return 0;
    }
    // If no matching criteria are defined in the scope, return default specificity
    if (!setting.scope.modelId && !setting.scope.providerId && !setting.scope.agentId) {
        return 0;
    }
    // Check for explicit non-matches (return -1)
    if (scope?.modelId && setting.scope.modelId && setting.scope.modelId !== scope.modelId) {
        return -1;
    }
    if (scope?.providerId && setting.scope.providerId && setting.scope.providerId !== scope.providerId) {
        return -1;
    }
    if (scope?.agentId && setting.scope.agentId && setting.scope.agentId !== scope.agentId) {
        return -1;
    }
    let specificity = 0;
    // Check provider match (1 point)
    if (scope?.providerId && setting.scope.providerId === scope.providerId) {
        specificity += 1;
    }
    // Check model match (10 points)
    if (scope?.modelId && setting.scope.modelId === scope.modelId) {
        specificity += 10;
    }
    // Check agent match (100 points)
    if (scope?.agentId && setting.scope.agentId === scope.agentId) {
        specificity += 100;
    }
    return specificity;
};
exports.getRequestSettingSpecificity = getRequestSettingSpecificity;
//# sourceMappingURL=ai-core-preferences.js.map