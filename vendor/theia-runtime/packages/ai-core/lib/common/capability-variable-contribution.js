"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CapabilityVariableContribution = exports.CAPABILITY_VARIABLE = void 0;
const tslib_1 = require("tslib");
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
const inversify_1 = require("@theia/core/shared/inversify");
const monaco = require("@theia/monaco-editor-core");
const prompt_service_1 = require("./prompt-service");
const prompt_text_1 = require("./prompt-text");
const capability_utils_1 = require("./capability-utils");
exports.CAPABILITY_VARIABLE = {
    id: 'capability-provider',
    description: core_1.nls.localize('theia/ai/core/capabilityVariable/description', 'Conditionally resolves prompt fragments based on default on/off setting'),
    name: 'capability',
    args: [
        {
            name: 'fragment-id [default on/off]',
            description: core_1.nls.localize('theia/ai/core/capabilityVariable/argDescription', 'The prompt fragment id, optionally followed by "default on" or "default off" (defaults to off)')
        }
    ]
};
let CapabilityVariableContribution = class CapabilityVariableContribution {
    registerVariables(service) {
        service.registerResolver(exports.CAPABILITY_VARIABLE, this);
        service.registerArgumentCompletionProvider(exports.CAPABILITY_VARIABLE, this.provideArgumentCompletionItems.bind(this));
    }
    canResolve(request, context) {
        if (request.variable.name === exports.CAPABILITY_VARIABLE.name) {
            return 1;
        }
        return -1;
    }
    async resolve(request, context, resolveDependency) {
        if (request.variable.name === exports.CAPABILITY_VARIABLE.name) {
            const arg = request.arg?.trim();
            if (arg) {
                const parseResult = (0, capability_utils_1.parseCapabilityArgument)(arg);
                if (!parseResult) {
                    this.logger.warn(`Could not parse capability argument '${arg}'. Expected format: 'fragment-id' or 'fragment-id default on/off'.`);
                    return {
                        variable: request.variable,
                        value: '',
                        allResolvedDependencies: []
                    };
                }
                const { fragmentId, defaultEnabled } = parseResult;
                // Get the enabled state from context overrides, or fall back to the default from the prompt
                const isEnabled = context.capabilityOverrides?.[fragmentId] ?? defaultEnabled;
                this.logger.debug(`Capability '${fragmentId}': enabled=${isEnabled} (override=${context.capabilityOverrides?.[fragmentId]}, default=${defaultEnabled})`);
                // If capability is disabled, return empty string
                if (!isEnabled) {
                    this.logger.debug(`Capability '${fragmentId}' is disabled, returning empty string`);
                    return {
                        variable: request.variable,
                        value: '',
                        allResolvedDependencies: []
                    };
                }
                // Resolve the prompt fragment content (this handles {{variables}} within the fragment)
                const resolvedPrompt = await this.promptService.getResolvedPromptFragmentWithoutFunctions(fragmentId, undefined, context, resolveDependency);
                if (resolvedPrompt) {
                    this.logger.debug(`Capability '${fragmentId}' resolved to ${resolvedPrompt.text.length} chars`);
                    return {
                        variable: request.variable,
                        value: resolvedPrompt.text,
                        allResolvedDependencies: resolvedPrompt.variables
                    };
                }
                this.logger.warn(`Could not find prompt fragment '${fragmentId}' for capability variable.`);
            }
        }
        this.logger.warn(`Could not resolve capability variable '${request.variable.name}' with arg '${request.arg}'. Returning empty string.`);
        return {
            variable: request.variable,
            value: '',
            allResolvedDependencies: []
        };
    }
    async provideArgumentCompletionItems(model, position) {
        const lineContent = model.getLineContent(position.lineNumber);
        // Only provide completions once the variable argument separator is typed
        const triggerCharIndex = lineContent.lastIndexOf(prompt_text_1.PromptText.VARIABLE_SEPARATOR_CHAR, position.column - 1);
        if (triggerCharIndex === -1) {
            return undefined;
        }
        // Check if the text immediately before the trigger is the capability variable
        const requiredVariable = `${prompt_text_1.PromptText.VARIABLE_CHAR}${exports.CAPABILITY_VARIABLE.name}`;
        if (triggerCharIndex < requiredVariable.length ||
            lineContent.substring(triggerCharIndex - requiredVariable.length, triggerCharIndex) !== requiredVariable) {
            return undefined;
        }
        const range = new monaco.Range(position.lineNumber, triggerCharIndex + 2, position.lineNumber, position.column);
        const activePrompts = this.promptService.getActivePromptFragments();
        const completions = [];
        if (activePrompts.length > 0) {
            activePrompts.forEach(prompt => {
                // Add completion for "default on"
                completions.push({
                    label: `${prompt.id} default on`,
                    kind: (0, prompt_service_1.isCustomizedPromptFragment)(prompt) ? monaco.languages.CompletionItemKind.Enum : monaco.languages.CompletionItemKind.Variable,
                    insertText: `${prompt.id} default on`,
                    range,
                    detail: core_1.nls.localize('theia/ai/core/capabilityVariable/completions/detail/on', 'Capability enabled by default'),
                    sortText: `${prompt.id}0`
                });
                // Add completion for "default off"
                completions.push({
                    label: `${prompt.id} default off`,
                    kind: (0, prompt_service_1.isCustomizedPromptFragment)(prompt) ? monaco.languages.CompletionItemKind.Enum : monaco.languages.CompletionItemKind.Variable,
                    insertText: `${prompt.id} default off`,
                    range,
                    detail: core_1.nls.localize('theia/ai/core/capabilityVariable/completions/detail/off', 'Capability disabled by default'),
                    sortText: `${prompt.id}1`
                });
            });
        }
        return completions;
    }
};
exports.CapabilityVariableContribution = CapabilityVariableContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(prompt_service_1.PromptService),
    tslib_1.__metadata("design:type", Object)
], CapabilityVariableContribution.prototype, "promptService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:CapabilityVariableContribution'),
    tslib_1.__metadata("design:type", Object)
], CapabilityVariableContribution.prototype, "logger", void 0);
exports.CapabilityVariableContribution = CapabilityVariableContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], CapabilityVariableContribution);
//# sourceMappingURL=capability-variable-contribution.js.map