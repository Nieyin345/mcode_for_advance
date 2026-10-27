"use strict";
// *****************************************************************************
// Copyright (C) 2024-2025 EclipseSource GmbH.
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
exports.DefaultLanguageModelRegistryImpl = exports.FrontendLanguageModelRegistry = exports.LanguageModelRegistry = exports.LanguageModel = exports.LanguageModelMetaData = exports.LanguageModelProvider = exports.isLanguageModelParsedResponse = exports.isLanguageModelStreamResponse = exports.createToolCallError = exports.hasToolNotAvailableError = exports.hasToolCallError = exports.isToolNotAvailableError = exports.isToolCallErrorResult = exports.isToolCallContent = exports.isToolCallHtmlAppResult = exports.isCompactionResponsePart = exports.isThinkingResponsePart = exports.isServerToolCallResponsePart = exports.isToolCallResponsePart = exports.isTextResponsePart = exports.isUsageResponsePart = exports.isLanguageModelStreamResponsePart = exports.isLanguageModelTextResponse = exports.SERVER_SIDE_COMPACTION_TOKEN_THRESHOLD_MINIMUM = exports.ToolRequest = exports.ToolInvocationContext = exports.isLanguageModelRequestMessage = exports.ImageContent = exports.LanguageModelMessage = exports.ReasoningSupport = void 0;
exports.resolveCustomModelHeaders = resolveCustomModelHeaders;
exports.resolveCompactionDefault = resolveCompactionDefault;
exports.resolveCompactionTokenThresholdDefault = resolveCompactionTokenThresholdDefault;
exports.resolveCompactionTokenThreshold = resolveCompactionTokenThreshold;
exports.resolveServerSideCompaction = resolveServerSideCompaction;
exports.formatToolCallContentForModel = formatToolCallContentForModel;
exports.isModelMatching = isModelMatching;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
var ReasoningSupport;
(function (ReasoningSupport) {
    /** Levels ordered by increasing effort; `'auto'` sits outside the scale. */
    const EFFORT_SCALE = ['off', 'minimal', 'low', 'medium', 'high'];
    /**
     * Returns `level` when `support` lists it, otherwise the nearest supported level on the effort scale,
     * preferring the higher neighbour (an unsupported `minimal` becomes `low`, not `off`). An unsupported
     * `'auto'` resolves to `defaultLevel`, then to the first supported level. Returns `level` unchanged
     * when nothing suitable is supported.
     */
    function clampLevel(support, level) {
        const supported = support.supportedLevels;
        if (supported.includes(level)) {
            return level;
        }
        if (level === 'auto') {
            return support.defaultLevel && supported.includes(support.defaultLevel) ? support.defaultLevel : supported[0] ?? level;
        }
        const index = EFFORT_SCALE.indexOf(level);
        for (let distance = 1; distance < EFFORT_SCALE.length; distance++) {
            const higher = EFFORT_SCALE[index + distance];
            if (higher && supported.includes(higher)) {
                return higher;
            }
            const lower = EFFORT_SCALE[index - distance];
            if (lower && supported.includes(lower)) {
                return lower;
            }
        }
        return supported.includes('auto') ? 'auto' : level;
    }
    ReasoningSupport.clampLevel = clampLevel;
})(ReasoningSupport || (exports.ReasoningSupport = ReasoningSupport = {}));
var LanguageModelMessage;
(function (LanguageModelMessage) {
    function isTextMessage(obj) {
        return obj.type === 'text';
    }
    LanguageModelMessage.isTextMessage = isTextMessage;
    function isThinkingMessage(obj) {
        return obj.type === 'thinking';
    }
    LanguageModelMessage.isThinkingMessage = isThinkingMessage;
    function isToolUseMessage(obj) {
        return obj.type === 'tool_use';
    }
    LanguageModelMessage.isToolUseMessage = isToolUseMessage;
    function isToolResultMessage(obj) {
        return obj.type === 'tool_result';
    }
    LanguageModelMessage.isToolResultMessage = isToolResultMessage;
    function isServerToolUseMessage(obj) {
        return obj.type === 'server_tool_use';
    }
    LanguageModelMessage.isServerToolUseMessage = isServerToolUseMessage;
    function isImageMessage(obj) {
        return obj.type === 'image';
    }
    LanguageModelMessage.isImageMessage = isImageMessage;
    function isCompactionMessage(obj) {
        return obj.type === 'compaction';
    }
    LanguageModelMessage.isCompactionMessage = isCompactionMessage;
})(LanguageModelMessage || (exports.LanguageModelMessage = LanguageModelMessage = {}));
;
;
var ImageContent;
(function (ImageContent) {
    ImageContent.isUrl = (obj) => 'url' in obj;
    ImageContent.isBase64 = (obj) => 'base64data' in obj && 'mimeType' in obj;
})(ImageContent || (exports.ImageContent = ImageContent = {}));
const isLanguageModelRequestMessage = (obj) => !!(obj && typeof obj === 'object' &&
    'type' in obj &&
    typeof obj.type === 'string' &&
    obj.type === 'text' &&
    'query' in obj &&
    typeof obj.query === 'string');
exports.isLanguageModelRequestMessage = isLanguageModelRequestMessage;
var ToolInvocationContext;
(function (ToolInvocationContext) {
    function is(obj) {
        return !!obj && typeof obj === 'object';
    }
    ToolInvocationContext.is = is;
    /**
     * Creates a new ToolInvocationContext with the given tool call ID and optional cancellation token.
     */
    function create(toolCallId, cancellationToken) {
        return { toolCallId, cancellationToken };
    }
    ToolInvocationContext.create = create;
    /**
     * Extracts the tool call ID from an unknown context object.
     * Returns undefined if the context is not a valid ToolInvocationContext or has no toolCallId.
     */
    function getToolCallId(ctx) {
        if (is(ctx) && 'toolCallId' in ctx && typeof ctx.toolCallId === 'string') {
            return ctx.toolCallId;
        }
        return undefined;
    }
    ToolInvocationContext.getToolCallId = getToolCallId;
    /**
     * Extracts the cancellation token from an unknown context object.
     */
    function getCancellationToken(ctx) {
        if (is(ctx) && 'cancellationToken' in ctx) {
            return ctx.cancellationToken;
        }
        return undefined;
    }
    ToolInvocationContext.getCancellationToken = getCancellationToken;
})(ToolInvocationContext || (exports.ToolInvocationContext = ToolInvocationContext = {}));
var ToolRequest;
(function (ToolRequest) {
    function isToolRequestParameterProperty(obj) {
        if (!obj || typeof obj !== 'object') {
            return false;
        }
        const record = obj;
        // Check that at least one of "type" or "anyOf" exists
        if (!('type' in record) && !('anyOf' in record)) {
            return false;
        }
        // If an "anyOf" field is present, it must be an array where each item is also a valid property.
        if ('anyOf' in record) {
            if (!Array.isArray(record.anyOf)) {
                return false;
            }
            for (const item of record.anyOf) {
                if (!isToolRequestParameterProperty(item)) {
                    return false;
                }
            }
        }
        if ('type' in record && typeof record.type !== 'string') {
            return false;
        }
        // No further checks required for additional properties.
        return true;
    }
    function isToolRequestParametersProperties(obj) {
        if (!obj || typeof obj !== 'object') {
            return false;
        }
        return Object.entries(obj).every(([key, value]) => {
            if (typeof key !== 'string') {
                return false;
            }
            return isToolRequestParameterProperty(value);
        });
    }
    ToolRequest.isToolRequestParametersProperties = isToolRequestParametersProperties;
    function isToolRequestParameters(obj) {
        return !!obj && typeof obj === 'object' &&
            (!('type' in obj) || obj.type === 'object') &&
            'properties' in obj && isToolRequestParametersProperties(obj.properties) &&
            (!('required' in obj) || (Array.isArray(obj.required) && obj.required.every(prop => typeof prop === 'string')));
    }
    ToolRequest.isToolRequestParameters = isToolRequestParameters;
})(ToolRequest || (exports.ToolRequest = ToolRequest = {}));
/**
 * Resolves the `headers` attribute of a custom model preference entry. Since preferences are
 * user-authored JSON, entries with a non-string value are dropped. Returns `undefined` when no
 * usable header remains, so that the default request headers are left untouched. The keys are
 * sorted, so equal header maps stringify identically regardless of their order in the preference.
 */
function resolveCustomModelHeaders(headers) {
    if (typeof headers !== 'object' || !headers || Array.isArray(headers)) {
        return undefined;
    }
    const resolved = Object.entries(headers)
        .filter((entry) => typeof entry[1] === 'string')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return resolved.length > 0 ? Object.fromEntries(resolved) : undefined;
}
// Anthropic requires at least 50,000 tokens, so use one conservative minimum for all compaction settings.
exports.SERVER_SIDE_COMPACTION_TOKEN_THRESHOLD_MINIMUM = 50_000;
/**
 * Resolves a model's default server-side compaction enablement from the global preference and
 * the per-provider override. `'enabled'`/`'disabled'` force the result; `'default'` defers to
 * the global preference. Intended to be called where the preferences are read (the provider's
 * frontend contribution) and stored on the model.
 */
function resolveCompactionDefault(globalEnabled, perProviderOverride) {
    if (perProviderOverride === 'enabled') {
        return true;
    }
    if (perProviderOverride === 'disabled') {
        return false;
    }
    return globalEnabled;
}
function resolveCompactionTokenThresholdDefault(globalThreshold, perProviderThreshold) {
    return perProviderThreshold ?? globalThreshold;
}
function resolveCompactionTokenThreshold(thresholdByDefault, compaction) {
    return compaction?.tokenThreshold ?? thresholdByDefault;
}
/**
 * Resolves whether server-side compaction is effective for a request: the model must support it
 * (capability), then an explicit per-session setting wins, otherwise the model's resolved default applies.
 */
function resolveServerSideCompaction(capability, enabledByDefault, compaction) {
    if (!capability) {
        return false;
    }
    return compaction?.enabled ?? enabledByDefault;
}
const isLanguageModelTextResponse = (obj) => !!(obj && typeof obj === 'object' && 'text' in obj && typeof obj.text === 'string');
exports.isLanguageModelTextResponse = isLanguageModelTextResponse;
const isLanguageModelStreamResponsePart = (part) => (0, exports.isUsageResponsePart)(part) || (0, exports.isTextResponsePart)(part) || (0, exports.isThinkingResponsePart)(part) ||
    (0, exports.isToolCallResponsePart)(part) || (0, exports.isServerToolCallResponsePart)(part) || (0, exports.isCompactionResponsePart)(part);
exports.isLanguageModelStreamResponsePart = isLanguageModelStreamResponsePart;
const isUsageResponsePart = (part) => !!(part && typeof part === 'object' &&
    'input_tokens' in part && typeof part.input_tokens === 'number' &&
    'output_tokens' in part && typeof part.output_tokens === 'number');
exports.isUsageResponsePart = isUsageResponsePart;
const isTextResponsePart = (part) => !!(part && typeof part === 'object' && 'content' in part && typeof part.content === 'string');
exports.isTextResponsePart = isTextResponsePart;
const isToolCallResponsePart = (part) => !!(part && typeof part === 'object' && 'tool_calls' in part && Array.isArray(part.tool_calls));
exports.isToolCallResponsePart = isToolCallResponsePart;
const isServerToolCallResponsePart = (part) => !!(part && typeof part === 'object' && 'server_tool_calls' in part && Array.isArray(part.server_tool_calls));
exports.isServerToolCallResponsePart = isServerToolCallResponsePart;
const isThinkingResponsePart = (part) => !!(part && typeof part === 'object' && 'thought' in part && typeof part.thought === 'string');
exports.isThinkingResponsePart = isThinkingResponsePart;
const isCompactionResponsePart = (part) => !!(part && typeof part === 'object' && 'compaction' in part &&
    typeof part.compaction === 'object' &&
    part.compaction &&
    'provider' in part.compaction &&
    typeof part.compaction.provider === 'string');
exports.isCompactionResponsePart = isCompactionResponsePart;
;
;
;
;
;
const isToolCallHtmlAppResult = (item) => !!(item &&
    typeof item === 'object' &&
    'type' in item && item.type === 'html' &&
    'html' in item &&
    typeof item.html === 'string');
exports.isToolCallHtmlAppResult = isToolCallHtmlAppResult;
const isToolCallContent = (result) => !!(result && typeof result === 'object' && 'content' in result && Array.isArray(result.content));
exports.isToolCallContent = isToolCallContent;
const isToolCallErrorResult = (item) => !!(item && typeof item === 'object' && 'type' in item && item.type === 'error' && 'data' in item);
exports.isToolCallErrorResult = isToolCallErrorResult;
const isToolNotAvailableError = (item) => (0, exports.isToolCallErrorResult)(item) && item.errorKind === 'tool-not-available';
exports.isToolNotAvailableError = isToolNotAvailableError;
const hasToolCallError = (result) => (0, exports.isToolCallContent)(result) && result.content.some(exports.isToolCallErrorResult);
exports.hasToolCallError = hasToolCallError;
const hasToolNotAvailableError = (result) => (0, exports.isToolCallContent)(result) && result.content.some(exports.isToolNotAvailableError);
exports.hasToolNotAvailableError = hasToolNotAvailableError;
const createToolCallError = (message, errorKind) => ({
    content: [errorKind ? { type: 'error', data: message, errorKind } : { type: 'error', data: message }]
});
exports.createToolCallError = createToolCallError;
/**
 * Serializes a {@link ToolCallResult} to a string suitable for sending back to the model.
 *
 * HTML app results are replaced with a compact placeholder so that large bundled HTML
 * (e.g. Plotly charts) does not blow the model's context window. The full HTML is still
 * available in the structured result for rendering in the UI (e.g. via McpAppFrame).
 */
function formatToolCallContentForModel(result) {
    if ((0, exports.isToolCallContent)(result)) {
        return result.content.map(c => {
            if (c.type === 'text') {
                return c.text;
            }
            if (c.type === 'html') {
                return `[interactive app displayed to the user${c.title ? ': ' + c.title : ''}]`;
            }
            if (c.type === 'error') {
                return c.data;
            }
            return JSON.stringify(c);
        }).join('\n');
    }
    if (typeof result === 'string') {
        return result;
    }
    return JSON.stringify(result);
}
const isLanguageModelStreamResponse = (obj) => !!(obj && typeof obj === 'object' && 'stream' in obj);
exports.isLanguageModelStreamResponse = isLanguageModelStreamResponse;
const isLanguageModelParsedResponse = (obj) => !!(obj && typeof obj === 'object' && 'parsed' in obj && 'content' in obj);
exports.isLanguageModelParsedResponse = isLanguageModelParsedResponse;
///////////////////////////////////////////
// Language Model Provider
///////////////////////////////////////////
exports.LanguageModelProvider = Symbol('LanguageModelProvider');
var LanguageModelMetaData;
(function (LanguageModelMetaData) {
    function is(arg) {
        return (0, core_1.isObject)(arg) && 'id' in arg;
    }
    LanguageModelMetaData.is = is;
})(LanguageModelMetaData || (exports.LanguageModelMetaData = LanguageModelMetaData = {}));
var LanguageModel;
(function (LanguageModel) {
    function is(arg) {
        return (0, core_1.isObject)(arg) && 'id' in arg && (0, core_1.isFunction)(arg.request);
    }
    LanguageModel.is = is;
})(LanguageModel || (exports.LanguageModel = LanguageModel = {}));
exports.LanguageModelRegistry = Symbol('LanguageModelRegistry');
exports.FrontendLanguageModelRegistry = Symbol('FrontendLanguageModelRegistry');
let DefaultLanguageModelRegistryImpl = class DefaultLanguageModelRegistryImpl {
    constructor() {
        this.languageModels = [];
        this.initialized = new Promise(resolve => { this.markInitialized = resolve; });
        this.changeEmitter = new core_1.Emitter();
        this.onChange = this.changeEmitter.event;
    }
    init() {
        const contributions = this.languageModelContributions.getContributions();
        const promises = contributions.map(provider => provider());
        Promise.allSettled(promises).then(results => {
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    this.languageModels.push(...result.value);
                }
                else {
                    this.logger.error('Failed to add some language models:', result.reason);
                }
            }
            this.markInitialized();
        });
    }
    addLanguageModels(models) {
        models.forEach(model => {
            if (this.languageModels.find(lm => lm.id === model.id)) {
                this.logger.warn(`Tried to add already existing language model with id ${model.id}. The new model will be ignored.`);
                return;
            }
            this.languageModels.push(model);
            this.changeEmitter.fire({ models: this.languageModels });
        });
    }
    async getLanguageModels() {
        await this.initialized;
        // Return a fresh array (not the internal, mutated-in-place list) so consumers relying on
        // reference equality - e.g. React memoization in the chat model selector - detect changes.
        return [...this.languageModels];
    }
    async getLanguageModel(id) {
        await this.initialized;
        return this.languageModels.find(model => model.id === id);
    }
    removeLanguageModels(ids) {
        ids.forEach(id => {
            const index = this.languageModels.findIndex(model => model.id === id);
            if (index !== -1) {
                this.languageModels.splice(index, 1);
                this.changeEmitter.fire({ models: this.languageModels });
            }
            else {
                this.logger.warn(`Language model with id ${id} was requested to be removed, however it does not exist`);
            }
        });
    }
    async selectLanguageModels(request) {
        await this.initialized;
        // TODO check for actor and purpose against settings
        return this.languageModels.filter(model => model.status.status === 'ready' && isModelMatching(request, model));
    }
    async selectLanguageModel(request) {
        const models = await this.selectLanguageModels(request);
        return models ? models[0] : undefined;
    }
    async patchLanguageModel(id, patch) {
        await this.initialized;
        const model = this.languageModels.find(m => m.id === id);
        if (!model) {
            this.logger.warn(`Language model with id ${id} not found for patch.`);
            return;
        }
        Object.assign(model, patch);
        this.changeEmitter.fire({ models: this.languageModels });
    }
};
exports.DefaultLanguageModelRegistryImpl = DefaultLanguageModelRegistryImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:DefaultLanguageModelRegistryImpl'),
    tslib_1.__metadata("design:type", Object)
], DefaultLanguageModelRegistryImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.LanguageModelProvider),
    tslib_1.__metadata("design:type", Object)
], DefaultLanguageModelRegistryImpl.prototype, "languageModelContributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DefaultLanguageModelRegistryImpl.prototype, "init", null);
exports.DefaultLanguageModelRegistryImpl = DefaultLanguageModelRegistryImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultLanguageModelRegistryImpl);
function isModelMatching(request, model) {
    return (!request.identifier || model.id === request.identifier) &&
        (!request.name || model.name === request.name) &&
        (!request.vendor || model.vendor === request.vendor) &&
        (!request.version || model.version === request.version) &&
        (!request.family || model.family === request.family);
}
//# sourceMappingURL=language-model.js.map