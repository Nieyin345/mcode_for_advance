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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Partially copied from https://github.com/microsoft/vscode/blob/a2cab7255c0df424027be05d58e1b7b941f4ea60/src/vs/workbench/contrib/chat/common/chatVariables.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultAIVariableService = exports.AIVariableContribution = exports.AIVariableService = exports.AIVariableResolutionRequest = exports.ResolvedAIContextVariable = exports.ResolvedAIVariable = exports.AIContextVariable = exports.AIVariable = void 0;
exports.createAIResolveVariableCache = createAIResolveVariableCache;
exports.getAllResolvedAIVariables = getAllResolvedAIVariables;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const prompt_text_1 = require("./prompt-text");
var AIVariable;
(function (AIVariable) {
    function is(arg) {
        return !!arg && typeof arg === 'object' &&
            'id' in arg &&
            'name' in arg &&
            'description' in arg;
    }
    AIVariable.is = is;
})(AIVariable || (exports.AIVariable = AIVariable = {}));
var AIContextVariable;
(function (AIContextVariable) {
    function is(arg) {
        return AIVariable.is(arg) && 'isContextVariable' in arg && arg.isContextVariable === true;
    }
    AIContextVariable.is = is;
})(AIContextVariable || (exports.AIContextVariable = AIContextVariable = {}));
var ResolvedAIVariable;
(function (ResolvedAIVariable) {
    function is(arg) {
        return !!arg && typeof arg === 'object' &&
            'variable' in arg &&
            'value' in arg &&
            typeof arg.variable === 'object' &&
            typeof arg.value === 'string';
    }
    ResolvedAIVariable.is = is;
})(ResolvedAIVariable || (exports.ResolvedAIVariable = ResolvedAIVariable = {}));
var ResolvedAIContextVariable;
(function (ResolvedAIContextVariable) {
    function is(arg) {
        return ResolvedAIVariable.is(arg) &&
            'contextValue' in arg &&
            typeof arg.contextValue === 'string';
    }
    ResolvedAIContextVariable.is = is;
})(ResolvedAIContextVariable || (exports.ResolvedAIContextVariable = ResolvedAIContextVariable = {}));
var AIVariableResolutionRequest;
(function (AIVariableResolutionRequest) {
    function is(arg) {
        return !!arg && typeof arg === 'object' &&
            'variable' in arg &&
            typeof arg.variable.name === 'string';
    }
    AIVariableResolutionRequest.is = is;
    function fromResolved(arg) {
        return {
            variable: arg.variable,
            arg: arg.arg
        };
    }
    AIVariableResolutionRequest.fromResolved = fromResolved;
})(AIVariableResolutionRequest || (exports.AIVariableResolutionRequest = AIVariableResolutionRequest = {}));
function isResolverWithDependencies(resolver) {
    return resolver !== undefined && resolver.resolve.length >= 3;
}
exports.AIVariableService = Symbol('AIVariableService');
/** Contributions on the frontend can optionally implement `FrontendVariableContribution`. */
exports.AIVariableContribution = Symbol('AIVariableContribution');
/**
 * Creates a new, empty cache for AI variable resolution to hand into `AIVariableService.resolveVariable`.
 */
function createAIResolveVariableCache() {
    return new Map();
}
/** Utility function to get all resolved AI variables from a {@link ResolveAIVariableCache}  */
async function getAllResolvedAIVariables(cache) {
    const resolvedVariables = [];
    for (const cacheEntry of cache.values()) {
        if (!cacheEntry.inProgress) {
            const resolvedVariable = await cacheEntry.promise;
            if (resolvedVariable) {
                resolvedVariables.push(resolvedVariable);
            }
        }
    }
    return resolvedVariables;
}
let DefaultAIVariableService = class DefaultAIVariableService {
    constructor(contributionProvider) {
        this.contributionProvider = contributionProvider;
        this.variables = new Map();
        this.resolvers = new Map();
        this.argPickers = new Map();
        this.openers = new Map();
        this.argCompletionProviders = new Map();
        this.onDidChangeVariablesEmitter = new core_1.Emitter();
        this.onDidChangeVariables = this.onDidChangeVariablesEmitter.event;
    }
    initContributions() {
        this.contributionProvider.getContributions().forEach(contribution => contribution.registerVariables(this));
    }
    getKey(name) {
        return `${name.toLowerCase()}`;
    }
    async getResolver(name, arg, context) {
        const resolvers = await this.prioritize(name, arg, context);
        return resolvers[0];
    }
    getResolvers(name) {
        return this.resolvers.get(this.getKey(name)) ?? [];
    }
    async prioritize(name, arg, context) {
        const variable = this.getVariable(name);
        if (!variable) {
            return [];
        }
        const prioritized = await core_1.Prioritizeable.prioritizeAll(this.getResolvers(name), async (resolver) => {
            try {
                return await resolver.canResolve({ variable, arg }, context);
            }
            catch {
                return 0;
            }
        });
        return prioritized.map(p => p.value);
    }
    hasVariable(name) {
        return !!this.getVariable(name);
    }
    getVariable(name) {
        return this.variables.get(this.getKey(name));
    }
    getVariables() {
        return [...this.variables.values()];
    }
    getContextVariables() {
        return this.getVariables().filter(AIContextVariable.is);
    }
    registerVariable(variable) {
        const key = this.getKey(variable.name);
        if (!this.variables.get(key)) {
            this.variables.set(key, variable);
            this.onDidChangeVariablesEmitter.fire();
            return core_1.Disposable.create(() => this.unregisterVariable(variable.name));
        }
        return core_1.Disposable.NULL;
    }
    registerResolver(variable, resolver) {
        this.registerVariable(variable);
        const key = this.getKey(variable.name);
        const resolvers = this.resolvers.get(key) ?? [];
        resolvers.push(resolver);
        this.resolvers.set(key, resolvers);
        return core_1.Disposable.create(() => this.unregisterResolver(variable, resolver));
    }
    unregisterResolver(variable, resolver) {
        const key = this.getKey(variable.name);
        const registeredResolvers = this.resolvers.get(key);
        registeredResolvers?.splice(registeredResolvers.indexOf(resolver), 1);
        if (registeredResolvers?.length === 0) {
            this.unregisterVariable(variable.name);
        }
    }
    unregisterVariable(name) {
        this.variables.delete(this.getKey(name));
        this.resolvers.delete(this.getKey(name));
        this.onDidChangeVariablesEmitter.fire();
    }
    registerArgumentPicker(variable, argPicker) {
        this.registerVariable(variable);
        const key = this.getKey(variable.name);
        this.argPickers.set(key, argPicker);
        return core_1.Disposable.create(() => this.unregisterArgumentPicker(variable, argPicker));
    }
    unregisterArgumentPicker(variable, argPicker) {
        const key = this.getKey(variable.name);
        const registeredArgPicker = this.argPickers.get(key);
        if (registeredArgPicker === argPicker) {
            this.argPickers.delete(key);
        }
    }
    async getArgumentPicker(name) {
        return this.argPickers.get(this.getKey(name)) ?? undefined;
    }
    registerArgumentCompletionProvider(variable, completionProvider) {
        this.registerVariable(variable);
        const key = this.getKey(variable.name);
        this.argCompletionProviders.set(key, completionProvider);
        return core_1.Disposable.create(() => this.unregisterArgumentCompletionProvider(variable, completionProvider));
    }
    unregisterArgumentCompletionProvider(variable, completionProvider) {
        const key = this.getKey(variable.name);
        const registeredCompletionProvider = this.argCompletionProviders.get(key);
        if (registeredCompletionProvider === completionProvider) {
            this.argCompletionProviders.delete(key);
        }
    }
    async getArgumentCompletionProvider(name) {
        return this.argCompletionProviders.get(this.getKey(name)) ?? undefined;
    }
    parseRequest(request) {
        const variableName = typeof request === 'string'
            ? request
            : typeof request.variable === 'string'
                ? request.variable
                : request.variable.name;
        const arg = typeof request === 'string' ? undefined : request.arg;
        return { variableName, arg };
    }
    async resolveVariable(request, context, cache = createAIResolveVariableCache()) {
        // Calculate unique variable cache key from variable name and argument
        const { variableName, arg } = this.parseRequest(request);
        const cacheKey = `${variableName}${prompt_text_1.PromptText.VARIABLE_SEPARATOR_CHAR}${arg ?? ''}`;
        // If the current cache key exists and is still in progress, we reached a cycle.
        // If we reach it but it has been resolved, it was part of another resolution branch and we can simply return it.
        if (cache.has(cacheKey)) {
            const existingEntry = cache.get(cacheKey);
            if (existingEntry.inProgress) {
                this.logger.warn(`Cycle detected for variable: ${variableName} with arg: ${arg}. Skipping resolution.`);
                return undefined;
            }
            return existingEntry.promise;
        }
        const entry = { promise: this.doResolve(variableName, arg, context, cache), inProgress: true };
        entry.promise.finally(() => entry.inProgress = false);
        cache.set(cacheKey, entry);
        return entry.promise;
    }
    /**
     * Asynchronously resolves a variable, handling its dependencies while preventing cyclical resolution.
     * Selects the appropriate resolver and resolution strategy based on whether nested dependency resolution is supported.
     */
    async doResolve(variableName, arg, context, cache) {
        const variable = this.getVariable(variableName);
        if (!variable) {
            return undefined;
        }
        const resolver = await this.getResolver(variableName, arg, context);
        let resolved;
        if (isResolverWithDependencies(resolver)) {
            // Explicit cast needed because Typescript does not consider the method parameter length of the type guard at compile time
            resolved = await resolver.resolve({ variable, arg }, context, async (depRequest) => this.resolveVariable(depRequest, context, cache));
        }
        else if (resolver) {
            // Explicit cast needed because Typescript does not consider the method parameter length of the type guard at compile time
            resolved = await resolver.resolve({ variable, arg }, context);
        }
        else {
            resolved = undefined;
        }
        return resolved ? { ...resolved, arg: resolved.arg ?? arg } : undefined;
    }
};
exports.DefaultAIVariableService = DefaultAIVariableService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:DefaultAIVariableService'),
    tslib_1.__metadata("design:type", Object)
], DefaultAIVariableService.prototype, "logger", void 0);
exports.DefaultAIVariableService = DefaultAIVariableService = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__param(0, (0, inversify_1.inject)(core_1.ContributionProvider)),
    tslib_1.__param(0, (0, inversify_1.named)(exports.AIVariableContribution)),
    tslib_1.__metadata("design:paramtypes", [Object])
], DefaultAIVariableService);
//# sourceMappingURL=variable-service.js.map