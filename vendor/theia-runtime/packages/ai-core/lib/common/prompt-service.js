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
exports.PromptServiceImpl = exports.PromptService = exports.PromptFragmentCustomizationService = exports.CustomAgentDescription = exports.CustomAgentPromptVariant = void 0;
exports.isBasePromptFragment = isBasePromptFragment;
exports.isCustomizedPromptFragment = isCustomizedPromptFragment;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const variable_service_1 = require("./variable-service");
const tool_invocation_registry_1 = require("./tool-invocation-registry");
const language_model_util_1 = require("./language-model-util");
const prompt_service_util_1 = require("./prompt-service-util");
const settings_service_1 = require("./settings-service");
/**
 * Type guard to check if a PromptFragment is a built-in fragment (not customized)
 * @param fragment The fragment to check
 * @returns True if the fragment is a basic BasePromptFragment (not customized)
 */
function isBasePromptFragment(fragment) {
    return !('customizationId' in fragment && 'priority' in fragment);
}
/**
 * Type guard to check if a PromptFragment is a CustomizedPromptFragment
 * @param fragment The fragment to check
 * @returns True if the fragment is a CustomizedPromptFragment
 */
function isCustomizedPromptFragment(fragment) {
    return 'customizationId' in fragment && 'priority' in fragment;
}
var CustomAgentPromptVariant;
(function (CustomAgentPromptVariant) {
    function equals(a, b) {
        return a.id === b.id && a.template === b.template;
    }
    CustomAgentPromptVariant.equals = equals;
    function arrayEquals(a, b) {
        const aArr = a ?? [];
        const bArr = b ?? [];
        if (aArr.length !== bArr.length) {
            return false;
        }
        for (let i = 0; i < aArr.length; i++) {
            if (!equals(aArr[i], bArr[i])) {
                return false;
            }
        }
        return true;
    }
    CustomAgentPromptVariant.arrayEquals = arrayEquals;
})(CustomAgentPromptVariant || (exports.CustomAgentPromptVariant = CustomAgentPromptVariant = {}));
var CustomAgentDescription;
(function (CustomAgentDescription) {
    /**
     * Type guard to check if an object is a CustomAgentDescription
     */
    function is(entry) {
        // eslint-disable-next-line no-null/no-null
        if (typeof entry !== 'object' || entry === null) {
            return false;
        }
        if (!('id' in entry && typeof entry.id === 'string')) {
            return false;
        }
        if (!('name' in entry && typeof entry.name === 'string')) {
            return false;
        }
        if (!('description' in entry && typeof entry.description === 'string')) {
            return false;
        }
        if (!('prompt' in entry && typeof entry.prompt === 'string')) {
            return false;
        }
        if (!('defaultLLM' in entry && typeof entry.defaultLLM === 'string')) {
            return false;
        }
        if ('showInChat' in entry && typeof entry.showInChat !== 'boolean') {
            return false;
        }
        return true;
    }
    CustomAgentDescription.is = is;
    /**
     * Compares two CustomAgentDescription objects for equality (including prompt variants).
     */
    function equals(a, b) {
        return a.id === b.id
            && a.name === b.name
            && a.description === b.description
            && a.prompt === b.prompt
            && a.defaultLLM === b.defaultLLM
            && a.showInChat === b.showInChat
            && CustomAgentPromptVariant.arrayEquals(a.promptVariants, b.promptVariants);
    }
    CustomAgentDescription.equals = equals;
})(CustomAgentDescription || (exports.CustomAgentDescription = CustomAgentDescription = {}));
/**
 * Service responsible for customizing prompt fragments
 */
exports.PromptFragmentCustomizationService = Symbol('PromptFragmentCustomizationService');
/**
 * Service for managing and resolving prompt fragments
 */
exports.PromptService = Symbol('PromptService');
let PromptServiceImpl = class PromptServiceImpl {
    constructor() {
        // Map to store selected variant for each prompt variant set (key: promptVariantSetId, value: variantId)
        this._selectedVariantsMap = new Map();
        // Collection of built-in prompt fragments
        this._builtInFragments = [];
        // Map to store prompt variants sets (key: promptVariantSetId, value: array of variantIds)
        this._promptVariantSetsMap = new Map();
        // Map to store default variant for each prompt variant set (key: promptVariantSetId, value: variantId)
        this._defaultVariantsMap = new Map();
        // Event emitter for prompt changes
        this._onPromptsChangeEmitter = new core_1.Emitter();
        this.onPromptsChange = this._onPromptsChangeEmitter.event;
        // Event emitter for selected variant changes
        this._onSelectedVariantChangeEmitter = new core_1.Emitter();
        this.onSelectedVariantChange = this._onSelectedVariantChangeEmitter.event;
        this.toDispose = new core_1.DisposableCollection();
    }
    fireOnPromptsChangeDebounced() {
        if (this.promptChangeDebounceTimer) {
            clearTimeout(this.promptChangeDebounceTimer);
        }
        this.promptChangeDebounceTimer = setTimeout(() => {
            this._onPromptsChangeEmitter.fire();
        }, 300);
    }
    init() {
        if (this.customizationService) {
            this.toDispose.pushAll([
                this.customizationService.onDidChangePromptFragmentCustomization(() => {
                    this.fireOnPromptsChangeDebounced();
                }),
                this.customizationService.onDidChangeCustomAgents(() => {
                    this.fireOnPromptsChangeDebounced();
                })
            ]);
        }
        if (this.settingsService) {
            this.recalculateSelectedVariantsMap();
            this.toDispose.push(this.settingsService.onDidChange(async () => {
                await this.recalculateSelectedVariantsMap();
            }));
        }
    }
    /**
     * Recalculates the selected variants map for all variant sets and fires the onSelectedVariantChangeEmitter
     * if the selectedVariants field has changed.
     */
    async recalculateSelectedVariantsMap() {
        if (!this.settingsService) {
            return;
        }
        const agentSettingsMap = await this.settingsService.getSettings();
        const newSelectedVariants = new Map();
        for (const agentSettings of Object.values(agentSettingsMap)) {
            if (agentSettings.selectedVariants) {
                for (const [variantSetId, variantId] of Object.entries(agentSettings.selectedVariants)) {
                    if (!newSelectedVariants.has(variantSetId)) {
                        newSelectedVariants.set(variantSetId, variantId);
                    }
                }
            }
        }
        // Compare with the old map and fire events for changes and removed variant sets
        for (const [variantSetId, newVariantId] of newSelectedVariants.entries()) {
            const oldVariantId = this._selectedVariantsMap.get(variantSetId);
            if (oldVariantId !== newVariantId) {
                this._onSelectedVariantChangeEmitter.fire({ promptVariantSetId: variantSetId, variantId: newVariantId });
            }
        }
        for (const oldVariantSetId of this._selectedVariantsMap.keys()) {
            if (!newSelectedVariants.has(oldVariantSetId)) {
                this._onSelectedVariantChangeEmitter.fire({ promptVariantSetId: oldVariantSetId, variantId: undefined });
            }
        }
        this._selectedVariantsMap = newSelectedVariants;
        // Also fire a full prompts change, because other fields (like effectiveVariantId) might have changed
        this.fireOnPromptsChangeDebounced();
    }
    // ===== Fragment Retrieval Methods =====
    /**
     * Finds a built-in fragment by its ID
     * @param fragmentId The ID of the fragment to find
     * @returns The built-in fragment or undefined if not found
     */
    findBuiltInFragmentById(fragmentId) {
        return this._builtInFragments.find(fragment => fragment.id === fragmentId);
    }
    findBuiltInFragmentByName(fragmentName) {
        return this._builtInFragments.find(fragment => fragment.commandName === fragmentName);
    }
    getRawPromptFragment(fragmentId) {
        if (this.customizationService?.isPromptFragmentCustomized(fragmentId)) {
            const customizedFragment = this.customizationService.getActivePromptFragmentCustomization(fragmentId);
            if (customizedFragment !== undefined) {
                return customizedFragment;
            }
        }
        return this.getBuiltInRawPrompt(fragmentId);
    }
    getBuiltInRawPrompt(fragmentId) {
        return this.findBuiltInFragmentById(fragmentId) ?? this.findBuiltInFragmentByName(fragmentId);
    }
    getPromptFragment(fragmentId) {
        const rawFragment = this.getRawPromptFragment(fragmentId);
        if (!rawFragment) {
            return undefined;
        }
        return {
            ...rawFragment,
            template: (0, prompt_service_util_1.stripFrontMatter)(this.stripComments(rawFragment.template))
        };
    }
    getPromptFragmentByCommandName(commandName) {
        // First check customized fragments
        if (this.customizationService) {
            const customizedIds = this.customizationService.getCustomizedPromptFragmentIds();
            for (const fragmentId of customizedIds) {
                const fragment = this.customizationService.getActivePromptFragmentCustomization(fragmentId);
                if (fragment?.isCommand && fragment.commandName === commandName) {
                    return fragment;
                }
            }
        }
        // Then check built-in fragments
        return this._builtInFragments.find(fragment => fragment.isCommand && fragment.commandName === commandName);
    }
    isKnownCommand(name) {
        if (!name) {
            return false;
        }
        // Both lookups are needed because the `prompt` variable resolves a command either by its
        // command name or, as a fallback, by prompt fragment id.
        return this.getPromptFragmentByCommandName(name) !== undefined || this.getRawPromptFragment(name) !== undefined;
    }
    /**
     * Strips comments from a template string
     * @param templateText The template text to process
     * @returns Template text with comments removed
     */
    stripComments(templateText) {
        const commentRegex = /^\s*{{!--[\s\S]*?--}}\s*\n?/;
        return commentRegex.test(templateText) ? templateText.replace(commentRegex, '').trimStart() : templateText;
    }
    /**
     * Extracts metadata fields from YAML front matter in the template and
     * merges them onto the fragment. Programmatic fields take precedence over
     * front matter values so callers can still override individual fields.
     */
    enrichWithFrontMatter(fragment) {
        const match = fragment.template.match(prompt_service_util_1.FRONT_MATTER_REGEX);
        if (!match) {
            return fragment;
        }
        const yamlBlock = match[1];
        const extracted = {};
        for (const line of yamlBlock.split('\n')) {
            const kv = line.match(/^\s*(\w+)\s*:\s*(.*?)\s*$/);
            if (kv) {
                const [, key, value] = kv;
                if (key === 'name' && !fragment.name) {
                    extracted.name = value;
                }
                else if (key === 'description' && !fragment.description) {
                    extracted.description = value;
                }
            }
        }
        if (extracted.name || extracted.description) {
            return { ...fragment, ...extracted };
        }
        return fragment;
    }
    getSelectedVariantId(variantSetId) {
        return this._selectedVariantsMap.get(variantSetId);
    }
    getEffectiveVariantId(variantSetId) {
        const selectedVariantId = this.getSelectedVariantId(variantSetId);
        // Check if the selected variant actually exists
        if (selectedVariantId) {
            const variantIds = this.getVariantIds(variantSetId);
            if (!variantIds.includes(selectedVariantId)) {
                this.logger.warn(`Selected variant '${selectedVariantId}' for prompt set '${variantSetId}' does not exist. Falling back to default variant.`);
            }
            else {
                return selectedVariantId;
            }
        }
        // Fall back to default variant
        const defaultVariantId = this.getDefaultVariantId(variantSetId);
        if (defaultVariantId) {
            const variantIds = this.getVariantIds(variantSetId);
            if (!variantIds.includes(defaultVariantId)) {
                this.logger.error(`Default variant '${defaultVariantId}' for prompt set '${variantSetId}' does not exist.`);
                return undefined;
            }
            return defaultVariantId;
        }
        // No valid selected or default variant
        if (this.getVariantIds(variantSetId).length > 0) {
            this.logger.error(`No valid selected or default variant found for prompt set '${variantSetId}'.`);
        }
        return undefined;
    }
    getPromptVariantInfo(fragmentId, modeId) {
        // If modeId is provided and is a valid variant, use it; otherwise use effective variant
        let variantId;
        if (modeId) {
            const variantIds = this.getVariantIds(fragmentId);
            if (variantIds.includes(modeId)) {
                variantId = modeId;
            }
        }
        variantId ??= this.getEffectiveVariantId(fragmentId) ?? fragmentId;
        const rawFragment = this.getRawPromptFragment(variantId);
        if (!rawFragment) {
            return undefined;
        }
        const isCustomized = isCustomizedPromptFragment(rawFragment);
        return { variantId, isCustomized };
    }
    resolvePotentialSystemPrompt(promptFragmentId) {
        if (this._promptVariantSetsMap.has(promptFragmentId)) {
            // This is a systemPrompt find the effective variant
            const effectiveVariantId = this.getEffectiveVariantId(promptFragmentId);
            if (effectiveVariantId === undefined) {
                return undefined;
            }
            return this.getPromptFragment(effectiveVariantId);
        }
        return this.getPromptFragment(promptFragmentId);
    }
    // ===== Fragment Resolution Methods =====
    async getResolvedPromptFragment(systemOrFragmentId, args, context) {
        const promptFragment = this.resolvePotentialSystemPrompt(systemOrFragmentId);
        if (promptFragment === undefined) {
            return undefined;
        }
        // First resolve variables and arguments
        let resolvedTemplate = promptFragment.template;
        const variableAndArgResolutions = await this.resolveVariablesAndArgs(promptFragment.template, args, context);
        variableAndArgResolutions.replacements.forEach(replacement => resolvedTemplate = resolvedTemplate.replace(replacement.placeholder, () => replacement.value));
        // Then resolve function references with already resolved variables and arguments
        // This allows to resolve function references contained in resolved variables (e.g. prompt fragments)
        const functionMatches = (0, prompt_service_util_1.matchFunctionsRegEx)(resolvedTemplate);
        const functionMap = new Map();
        const deferredFunctionIds = new Set();
        const functionReplacements = functionMatches.map(match => {
            const completeText = match[0];
            const { id: functionId, deferred } = (0, prompt_service_util_1.parseFunctionReference)(match[1]);
            const toolRequest = this.toolInvocationRegistry?.getFunction(functionId);
            if (toolRequest) {
                functionMap.set(toolRequest.id, toolRequest);
                if (deferred) {
                    deferredFunctionIds.add(toolRequest.id);
                }
            }
            return {
                placeholder: completeText,
                value: toolRequest ? (0, language_model_util_1.toolRequestToPromptText)(toolRequest) : completeText
            };
        });
        functionReplacements.forEach(replacement => resolvedTemplate = resolvedTemplate.replace(replacement.placeholder, () => replacement.value));
        return {
            id: systemOrFragmentId,
            text: resolvedTemplate,
            functionDescriptions: functionMap.size > 0 ? functionMap : undefined,
            deferredFunctionIds: deferredFunctionIds.size > 0 ? deferredFunctionIds : undefined,
            variables: variableAndArgResolutions.resolvedVariables
        };
    }
    async getResolvedPromptFragmentWithoutFunctions(systemOrFragmentId, args, context, resolveVariable) {
        const promptFragment = this.resolvePotentialSystemPrompt(systemOrFragmentId);
        if (promptFragment === undefined) {
            return undefined;
        }
        const resolutions = await this.resolveVariablesAndArgs(promptFragment.template, args, context, resolveVariable);
        let resolvedTemplate = promptFragment.template;
        resolutions.replacements.forEach(replacement => resolvedTemplate = resolvedTemplate.replace(replacement.placeholder, () => replacement.value));
        return {
            id: systemOrFragmentId,
            text: resolvedTemplate,
            variables: resolutions.resolvedVariables
        };
    }
    /**
     * Calculates all variable and argument replacements for an unresolved template.
     *
     * @param templateText the unresolved template text
     * @param args the object with placeholders, mapping the placeholder key to the value
     * @param context the {@link AIVariableContext} to use during variable resolution
     * @param resolveVariable the variable resolving method. Fall back to using the {@link AIVariableService} if not given.
     * @returns Object containing replacements and resolved variables
     */
    async resolveVariablesAndArgs(templateText, args, context, resolveVariable) {
        const variableMatches = (0, prompt_service_util_1.matchVariablesRegEx)(templateText);
        const variableCache = (0, variable_service_1.createAIResolveVariableCache)();
        const replacementsList = [];
        const resolvedVariablesSet = new Set();
        for (const match of variableMatches) {
            const placeholderText = match[0];
            const variableAndArg = match[1];
            let variableName = variableAndArg;
            let argument;
            // First colon only, keeping the whole remainder: `split(':', 2)` truncates instead, which
            // mangles every argument containing a colon, e.g. `{{file:C:\some\path}}`.
            const separatorIndex = variableAndArg.indexOf(':');
            if (separatorIndex >= 0) {
                variableName = variableAndArg.substring(0, separatorIndex);
                argument = variableAndArg.substring(separatorIndex + 1);
            }
            let replacementValue;
            if (args && args[variableAndArg] !== undefined) {
                replacementValue = String(args[variableAndArg]);
            }
            else {
                const variableToResolve = { variable: variableName, arg: argument };
                const resolvedVariable = resolveVariable
                    ? await resolveVariable(variableToResolve)
                    : await this.variableService?.resolveVariable(variableToResolve, context ?? {}, variableCache);
                // Track resolved variable and its dependencies in all resolved variables
                if (resolvedVariable) {
                    resolvedVariablesSet.add(resolvedVariable);
                    resolvedVariable.allResolvedDependencies?.forEach(v => resolvedVariablesSet.add(v));
                }
                replacementValue = String(resolvedVariable?.value ?? placeholderText);
            }
            replacementsList.push({ placeholder: placeholderText, value: replacementValue });
        }
        return {
            replacements: replacementsList,
            resolvedVariables: Array.from(resolvedVariablesSet)
        };
    }
    // ===== Fragment Collection Management Methods =====
    getAllPromptFragments() {
        const fragmentsMap = new Map();
        if (this.customizationService) {
            const customizationIds = this.customizationService.getCustomizedPromptFragmentIds();
            customizationIds.forEach(fragmentId => {
                const customizations = this.customizationService.getAllCustomizations(fragmentId);
                if (customizations.length > 0) {
                    fragmentsMap.set(fragmentId, customizations);
                }
            });
        }
        // Add all built-in fragments
        for (const fragment of this._builtInFragments) {
            if (fragmentsMap.has(fragment.id)) {
                fragmentsMap.get(fragment.id).push(fragment);
            }
            else {
                fragmentsMap.set(fragment.id, [fragment]);
            }
        }
        return fragmentsMap;
    }
    getActivePromptFragments() {
        const activeFragments = [...this._builtInFragments];
        if (this.customizationService) {
            // Fetch all customized fragment IDs once
            const customizedIds = this.customizationService.getCustomizedPromptFragmentIds();
            // For each customized ID, get the active customization
            for (const fragmentId of customizedIds) {
                const customFragment = this.customizationService?.getActivePromptFragmentCustomization(fragmentId);
                if (customFragment) {
                    // Find and replace existing entry with the same ID instead of just adding
                    const existingIndex = activeFragments.findIndex(fragment => fragment.id === fragmentId);
                    if (existingIndex !== -1) {
                        // Replace existing fragment
                        activeFragments[existingIndex] = customFragment;
                    }
                    else {
                        // Add new fragment if no existing one found
                        activeFragments.push(customFragment);
                    }
                }
            }
        }
        return activeFragments;
    }
    removePromptFragment(fragmentId) {
        const index = this._builtInFragments.findIndex(fragment => fragment.id === fragmentId);
        if (index !== -1) {
            this._builtInFragments.splice(index, 1);
        }
        // Remove any variant references
        for (const [promptVariantSetId, variants] of this._promptVariantSetsMap.entries()) {
            if (variants.includes(fragmentId)) {
                this.removeFragmentVariant(promptVariantSetId, fragmentId);
            }
        }
        // Clean up default variants map if needed
        if (this._defaultVariantsMap.has(fragmentId)) {
            this._defaultVariantsMap.delete(fragmentId);
        }
        // Look for this fragmentId as a variant in default variants and remove if found
        for (const [promptVariantSetId, defaultVariantId] of this._defaultVariantsMap.entries()) {
            if (defaultVariantId === fragmentId) {
                this._defaultVariantsMap.delete(promptVariantSetId);
            }
        }
        this.fireOnPromptsChangeDebounced();
    }
    getVariantIds(variantSetId) {
        const builtInVariants = this._promptVariantSetsMap.get(variantSetId) || [];
        // Check for custom variants from customization service
        if (this.customizationService) {
            const allCustomizedIds = this.customizationService.getCustomizedPromptFragmentIds();
            // Find customizations that start with the variant set ID
            // These are considered variants of this variant set
            // Only include IDs that are not the variant set ID itself, start with the variant set ID,
            // and are not customizations of existing variants in this set
            const customVariants = allCustomizedIds.filter(id => id !== variantSetId &&
                id.startsWith(variantSetId) &&
                !builtInVariants.includes(id));
            if (customVariants.length > 0) {
                // Combine built-in variants with custom variants, without modifying the internal state
                return [...builtInVariants, ...customVariants];
            }
        }
        return builtInVariants;
    }
    getDefaultVariantId(promptVariantSetId) {
        return this._defaultVariantsMap.get(promptVariantSetId);
    }
    getPromptVariantSets() {
        const result = new Map(this._promptVariantSetsMap);
        // Check for custom variants from customization service
        if (this.customizationService) {
            const allCustomizedIds = this.customizationService.getCustomizedPromptFragmentIds();
            // Add custom variants to existing variant sets
            for (const [variantSetId, variants] of result.entries()) {
                // Filter out customized fragments that are just customizations of existing variants
                // so we don't treat them as separate variants themselves
                // Only include IDs that are not the variant set ID itself, start with the variant set ID,
                // and are not customizations of existing variants in this set
                const customVariants = allCustomizedIds.filter(id => id !== variantSetId &&
                    id.startsWith(variantSetId) &&
                    !variants.includes(id));
                if (customVariants.length > 0) {
                    // Create a new array without modifying the original
                    result.set(variantSetId, [...variants, ...customVariants]);
                }
            }
        }
        return result;
    }
    addBuiltInPromptFragment(promptFragment, promptVariantSetId, isDefault = false) {
        const enriched = this.enrichWithFrontMatter(promptFragment);
        this.checkCommandUniqueness(enriched);
        const existingIndex = this._builtInFragments.findIndex(fragment => fragment.id === enriched.id);
        if (existingIndex !== -1) {
            // Replace existing fragment with the same ID
            this._builtInFragments[existingIndex] = enriched;
        }
        else {
            // Add new fragment
            this._builtInFragments.push(enriched);
        }
        // If this is a variant of a prompt variant set, record it in the variants map
        if (promptVariantSetId) {
            this.addFragmentVariant(promptVariantSetId, promptFragment.id, isDefault);
        }
        this.fireOnPromptsChangeDebounced();
    }
    checkCommandUniqueness(promptFragment) {
        if (promptFragment.isCommand && promptFragment.commandName) {
            const commandName = promptFragment.commandName;
            const duplicates = this._builtInFragments.filter(f => f.isCommand && f.commandName === commandName && (
            // undefined commandAgents means applicable to all agents
            f.commandAgents === undefined ||
                promptFragment.commandAgents === undefined ||
                // Check for overlapping command agents
                f.commandAgents.some(agent => promptFragment.commandAgents.includes(agent))));
            if (duplicates.length > 0) {
                this.logger.warn(`Command name '${commandName}' is used by multiple fragments: ${promptFragment.id} and ${duplicates.map(d => d.id).join(', ')}`);
            }
        }
    }
    // ===== Variant Management Methods =====
    /**
     * Adds a variant ID to the fragment variants map
     * @param promptVariantSetId The prompt variant set id
     * @param variantId The variant ID to add
     * @param isDefault Whether this variant should be the default for the prompt variant set (defaults to false)
     */
    addFragmentVariant(promptVariantSetId, variantId, isDefault = false) {
        if (!this._promptVariantSetsMap.has(promptVariantSetId)) {
            this._promptVariantSetsMap.set(promptVariantSetId, []);
        }
        const variants = this._promptVariantSetsMap.get(promptVariantSetId);
        if (!variants.includes(variantId)) {
            variants.push(variantId);
        }
        if (isDefault) {
            this._defaultVariantsMap.set(promptVariantSetId, variantId);
        }
    }
    /**
     * Removes a variant ID from the fragment variants map
     * @param promptVariantSetId The prompt variant set id
     * @param variantId The variant ID to remove
     */
    removeFragmentVariant(promptVariantSetId, variantId) {
        if (!this._promptVariantSetsMap.has(promptVariantSetId)) {
            return;
        }
        const variants = this._promptVariantSetsMap.get(promptVariantSetId);
        const index = variants.indexOf(variantId);
        if (index !== -1) {
            variants.splice(index, 1);
            // Remove the key if no variants left
            if (variants.length === 0) {
                this._promptVariantSetsMap.delete(promptVariantSetId);
            }
        }
    }
    async updateSelectedVariantId(agentId, promptVariantSetId, newVariant) {
        if (!this.settingsService) {
            return;
        }
        const defaultVariantId = this.getDefaultVariantId(promptVariantSetId);
        const agentSettings = await this.settingsService.getAgentSettings(agentId);
        const selectedVariants = agentSettings?.selectedVariants || {};
        const updatedVariants = { ...selectedVariants };
        if (newVariant === defaultVariantId) {
            delete updatedVariants[promptVariantSetId];
        }
        else {
            updatedVariants[promptVariantSetId] = newVariant;
        }
        await this.settingsService.updateAgentSettings(agentId, {
            selectedVariants: updatedVariants,
        });
        // Emit the selected variant change event
        this._onSelectedVariantChangeEmitter.fire({ promptVariantSetId, variantId: newVariant });
    }
    // ===== Customization Service Delegation Methods =====
    async createCustomization(fragmentId) {
        if (this.customizationService) {
            await this.customizationService.createPromptFragmentCustomization(fragmentId);
        }
    }
    async createBuiltInCustomization(fragmentId) {
        if (this.customizationService) {
            const builtInTemplate = this.findBuiltInFragmentById(fragmentId);
            await this.customizationService.createBuiltInPromptFragmentCustomization(fragmentId, builtInTemplate?.template);
        }
    }
    async editCustomization(fragmentId, customizationId) {
        if (this.customizationService) {
            await this.customizationService.editPromptFragmentCustomization(fragmentId, customizationId);
        }
    }
    async removeCustomization(fragmentId, customizationId) {
        if (this.customizationService) {
            await this.customizationService.removePromptFragmentCustomization(fragmentId, customizationId);
        }
    }
    async resetAllToBuiltIn() {
        if (this.customizationService) {
            for (const fragment of this._builtInFragments) {
                await this.customizationService.removeAllPromptFragmentCustomizations(fragment.id);
            }
        }
    }
    async resetToBuiltIn(fragmentId) {
        const builtIn = this._builtInFragments.find(b => b.id === fragmentId);
        // Only reset this if it has a built-in, otherwise a delete would be the correct operation
        if (this.customizationService && builtIn) {
            await this.customizationService.removeAllPromptFragmentCustomizations(fragmentId);
        }
    }
    async resetToCustomization(fragmentId, customizationId) {
        if (this.customizationService) {
            await this.customizationService.resetToCustomization(fragmentId, customizationId);
        }
    }
    async getCustomizationDescription(fragmentId, customizationId) {
        if (!this.customizationService) {
            return undefined;
        }
        return await this.customizationService.getPromptFragmentCustomizationDescription(fragmentId, customizationId);
    }
    async getCustomizationType(fragmentId, customizationId) {
        if (!this.customizationService) {
            return undefined;
        }
        return await this.customizationService.getPromptFragmentCustomizationType(fragmentId, customizationId);
    }
    getTemplateIDFromResource(resourceId) {
        if (this.customizationService) {
            return this.customizationService.getPromptFragmentIDFromResource(resourceId);
        }
        return undefined;
    }
    async editBuiltInCustomization(fragmentId) {
        if (this.customizationService) {
            const builtInTemplate = this.findBuiltInFragmentById(fragmentId);
            await this.customizationService.editBuiltInPromptFragmentCustomization(fragmentId, builtInTemplate?.template);
        }
    }
    getCommands(agentId) {
        const allCommands = this.getActivePromptFragments().filter(fragment => fragment.isCommand === true);
        if (!agentId) {
            return allCommands;
        }
        return allCommands.filter(fragment => !fragment.commandAgents || fragment.commandAgents.includes(agentId));
    }
};
exports.PromptServiceImpl = PromptServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:PromptServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], PromptServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(settings_service_1.AISettingsService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], PromptServiceImpl.prototype, "settingsService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(exports.PromptFragmentCustomizationService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], PromptServiceImpl.prototype, "customizationService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(variable_service_1.AIVariableService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], PromptServiceImpl.prototype, "variableService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(tool_invocation_registry_1.ToolInvocationRegistry),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], PromptServiceImpl.prototype, "toolInvocationRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], PromptServiceImpl.prototype, "init", null);
exports.PromptServiceImpl = PromptServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PromptServiceImpl);
//# sourceMappingURL=prompt-service.js.map