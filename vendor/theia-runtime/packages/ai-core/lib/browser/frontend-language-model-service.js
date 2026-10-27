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
exports.mergeReasoningSettings = exports.mergeRequestSettings = exports.FrontendLanguageModelServiceImpl = void 0;
const tslib_1 = require("tslib");
const nls_1 = require("@theia/core/lib/common/nls");
const inversify_1 = require("@theia/core/shared/inversify");
const prioritizeable_1 = require("@theia/core/lib/common/prioritizeable");
const workspace_trust_service_1 = require("@theia/workspace/lib/browser/workspace-trust-service");
const common_1 = require("../common");
const language_model_service_1 = require("../common/language-model-service");
const ai_core_preferences_1 = require("../common/ai-core-preferences");
let FrontendLanguageModelServiceImpl = class FrontendLanguageModelServiceImpl extends language_model_service_1.LanguageModelServiceImpl {
    async sendRequest(languageModel, languageModelRequest) {
        const requestSettings = this.aiConfiguration.get(ai_core_preferences_1.PREFERENCE_NAME_REQUEST_SETTINGS, []) ?? [];
        const reasoningEntries = this.aiConfiguration.get(ai_core_preferences_1.PREFERENCE_NAME_REASONING, []) ?? [];
        const trusted = await this.workspaceTrustService.getWorkspaceTrust();
        if (!trusted) {
            throw new Error(nls_1.nls.localize('theia/ai-core/aiDisabledInRestrictedMode', 'AI features are not available in untrusted workspaces.'));
        }
        const ids = languageModel.id.split('/');
        const matchingSetting = (0, exports.mergeRequestSettings)(requestSettings, ids[1], ids[0], languageModelRequest.agentId);
        if (matchingSetting?.requestSettings) {
            // Merge the settings, with user request taking precedence
            languageModelRequest.settings = {
                ...matchingSetting.requestSettings,
                ...languageModelRequest.settings
            };
        }
        if (matchingSetting?.clientSettings) {
            // Merge the clientSettings, with user request taking precedence
            languageModelRequest.clientSettings = {
                ...matchingSetting.clientSettings,
                ...languageModelRequest.clientSettings
            };
        }
        // Reasoning resolution order (highest first): already-set session override → preference entry
        // matching this scope → model's declared `defaultLevel`. The selector displays the same
        // fallback chain, so what the user sees is what gets sent.
        if (!languageModelRequest.reasoning) {
            const matchingReasoning = (0, exports.mergeReasoningSettings)(reasoningEntries, ids[1], ids[0], languageModelRequest.agentId);
            if (matchingReasoning?.reasoning) {
                languageModelRequest.reasoning = matchingReasoning.reasoning;
            }
            else if (languageModel.reasoningSupport?.defaultLevel) {
                languageModelRequest.reasoning = { level: languageModel.reasoningSupport.defaultLevel };
            }
        }
        // A persisted selection or preference entry can name a level the current model does not accept,
        // which the provider would otherwise send as-is; clamp it to the model's declared levels.
        if (languageModelRequest.reasoning && languageModel.reasoningSupport) {
            const level = common_1.ReasoningSupport.clampLevel(languageModel.reasoningSupport, languageModelRequest.reasoning.level);
            if (level !== languageModelRequest.reasoning.level) {
                languageModelRequest.reasoning = { ...languageModelRequest.reasoning, level };
            }
        }
        return super.sendRequest(languageModel, languageModelRequest);
    }
};
exports.FrontendLanguageModelServiceImpl = FrontendLanguageModelServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_trust_service_1.WorkspaceTrustService),
    tslib_1.__metadata("design:type", workspace_trust_service_1.WorkspaceTrustService)
], FrontendLanguageModelServiceImpl.prototype, "workspaceTrustService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.AiConfigurationService),
    tslib_1.__metadata("design:type", Object)
], FrontendLanguageModelServiceImpl.prototype, "aiConfiguration", void 0);
exports.FrontendLanguageModelServiceImpl = FrontendLanguageModelServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FrontendLanguageModelServiceImpl);
const mergeRequestSettings = (requestSettings, modelId, providerId, agentId) => {
    const prioritizedSettings = prioritizeable_1.Prioritizeable.prioritizeAllSync(requestSettings, setting => (0, ai_core_preferences_1.getRequestSettingSpecificity)(setting, {
        modelId,
        providerId,
        agentId
    }));
    // merge all settings from lowest to highest, identical priorities will be overwritten by the following
    const matchingSetting = prioritizedSettings.reduceRight((acc, cur) => ({ ...acc, ...cur.value }), {});
    return matchingSetting;
};
exports.mergeRequestSettings = mergeRequestSettings;
const mergeReasoningSettings = (reasoningEntries, modelId, providerId, agentId) => {
    const prioritizedSettings = prioritizeable_1.Prioritizeable.prioritizeAllSync(reasoningEntries, setting => (0, ai_core_preferences_1.getRequestSettingSpecificity)(setting, {
        modelId,
        providerId,
        agentId
    }));
    const matchingSetting = prioritizedSettings.reduceRight((acc, cur) => {
        if (!acc) {
            return cur.value;
        }
        return {
            ...acc,
            reasoning: {
                ...acc.reasoning,
                ...cur.value.reasoning
            }
        };
    }, undefined);
    return matchingSetting;
};
exports.mergeReasoningSettings = mergeReasoningSettings;
//# sourceMappingURL=frontend-language-model-service.js.map