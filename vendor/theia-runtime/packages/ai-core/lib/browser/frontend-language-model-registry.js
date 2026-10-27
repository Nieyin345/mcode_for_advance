"use strict";
var FrontendLanguageModelRegistryImpl_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrontendLanguageModelRegistryImpl = exports.LanguageModelDelegateClientImpl = void 0;
const tslib_1 = require("tslib");
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
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const output_channel_1 = require("@theia/output/lib/browser/output-channel");
const common_1 = require("../common");
let LanguageModelDelegateClientImpl = class LanguageModelDelegateClientImpl {
    onLanguageModelUpdated(id) {
        this.receiver.onLanguageModelUpdated(id);
    }
    setReceiver(receiver) {
        this.receiver = receiver;
    }
    send(id, token) {
        this.receiver.send(id, token);
    }
    toolCall(requestId, toolId, args_string, toolCallId) {
        return this.receiver.toolCall(requestId, toolId, args_string, toolCallId);
    }
    error(id, error) {
        this.receiver.error(id, error);
    }
    languageModelAdded(metadata) {
        this.receiver.languageModelAdded(metadata);
    }
    languageModelRemoved(id) {
        this.receiver.languageModelRemoved(id);
    }
};
exports.LanguageModelDelegateClientImpl = LanguageModelDelegateClientImpl;
exports.LanguageModelDelegateClientImpl = LanguageModelDelegateClientImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], LanguageModelDelegateClientImpl);
let FrontendLanguageModelRegistryImpl = class FrontendLanguageModelRegistryImpl extends common_1.DefaultLanguageModelRegistryImpl {
    constructor() {
        super(...arguments);
        this.streams = new Map();
        this.requests = new Map();
    }
    static { FrontendLanguageModelRegistryImpl_1 = this; }
    // called by backend
    languageModelAdded(metadata) {
        this.addLanguageModels([metadata]);
    }
    // called by backend
    languageModelRemoved(id) {
        this.removeLanguageModels([id]);
    }
    // called by backend when a model is updated
    onLanguageModelUpdated(id) {
        this.updateLanguageModelFromBackend(id);
    }
    /**
     * Fetch the updated model metadata from the backend and update the registry.
     */
    async updateLanguageModelFromBackend(id) {
        try {
            const backendModels = await this.registryDelegate.getLanguageModelDescriptions();
            const updated = backendModels.find((m) => m.id === id);
            if (updated) {
                // Remove the old model and add the updated one
                this.removeLanguageModels([id]);
                this.addLanguageModels([updated]);
            }
        }
        catch (err) {
            this.logger.error('Failed to update language model from backend', err);
        }
    }
    static { this.requestCounter = 0; }
    addLanguageModels(models) {
        let modelAdded = false;
        for (const model of models) {
            if (this.languageModels.find(m => m.id === model.id)) {
                this.logger.warn(`Tried to add an existing model ${model.id}`);
                continue;
            }
            if (common_1.LanguageModel.is(model)) {
                this.languageModels.push(new Proxy(model, languageModelOutputHandler(() => this.outputChannelManager.getChannel(model.id))));
                modelAdded = true;
            }
            else {
                this.languageModels.push(new Proxy(this.createFrontendLanguageModel(model), languageModelOutputHandler(() => this.outputChannelManager.getChannel(model.id))));
                modelAdded = true;
            }
        }
        if (modelAdded) {
            this.changeEmitter.fire({ models: this.languageModels });
        }
    }
    init() {
        this.client.setReceiver(this);
        const contributions = this.languageModelContributions.getContributions();
        const promises = contributions.map(provider => provider());
        const backendDescriptions = this.registryDelegate.getLanguageModelDescriptions();
        Promise.allSettled([backendDescriptions, ...promises]).then(results => {
            const backendDescriptionsResult = results[0];
            if (backendDescriptionsResult.status === 'fulfilled') {
                this.addLanguageModels(backendDescriptionsResult.value);
            }
            else {
                this.logger.error('Failed to add language models contributed from the backend', backendDescriptionsResult.reason);
            }
            for (let i = 1; i < results.length; i++) {
                // assert that index > 0 contains only language models
                const languageModelResult = results[i];
                if (languageModelResult.status === 'fulfilled') {
                    this.addLanguageModels(languageModelResult.value);
                }
                else {
                    this.logger.error('Failed to add some language models:', languageModelResult.reason);
                }
            }
            this.markInitialized();
        });
    }
    createFrontendLanguageModel(description) {
        return {
            ...description,
            request: async (request, cancellationToken) => {
                const requestId = `${FrontendLanguageModelRegistryImpl_1.requestCounter++}`;
                this.requests.set(requestId, request);
                cancellationToken?.onCancellationRequested(() => {
                    this.providerDelegate.cancel(requestId);
                });
                const response = await this.providerDelegate.request(description.id, request, requestId, cancellationToken);
                if ((0, common_1.isLanguageModelTextResponse)(response) || (0, common_1.isLanguageModelParsedResponse)(response)) {
                    return response;
                }
                if ((0, common_1.isLanguageModelStreamResponseDelegate)(response)) {
                    if (!this.streams.has(response.streamId)) {
                        const newStreamState = {
                            id: response.streamId,
                            tokens: [],
                        };
                        this.streams.set(response.streamId, newStreamState);
                    }
                    const streamState = this.streams.get(response.streamId);
                    return {
                        stream: this.getIterable(streamState),
                    };
                }
                this.logger.error(`Received unknown response in frontend for request to language model ${description.id}. Trying to continue without touching the response.`, response);
                return response;
            },
        };
    }
    async *getIterable(state) {
        let current = -1;
        while (true) {
            if (current < state.tokens.length - 1) {
                current++;
                const token = state.tokens[current];
                if (token === undefined) {
                    // message is finished
                    break;
                }
                if (token !== undefined) {
                    yield token;
                }
            }
            else {
                await new Promise((resolve, reject) => {
                    state.resolve = resolve;
                    state.reject = reject;
                });
            }
        }
        this.streams.delete(state.id);
    }
    // called by backend via the "delegate client" with new tokens
    send(id, token) {
        if (!this.streams.has(id)) {
            const newStreamState = {
                id,
                tokens: [],
            };
            this.streams.set(id, newStreamState);
        }
        const streamState = this.streams.get(id);
        streamState.tokens.push(token);
        if (streamState.resolve) {
            streamState.resolve(token);
        }
    }
    // called by backend once tool is invoked
    async toolCall(id, toolId, arg_string, toolCallId) {
        if (!this.requests.has(id)) {
            return (0, common_1.createToolCallError)(`No request found for ID '${id}'. The request may have been cancelled or completed.`);
        }
        const request = this.requests.get(id);
        const tool = request.tools?.find(t => t.id === toolId);
        if (tool) {
            try {
                return await tool.handler(arg_string, common_1.ToolInvocationContext.create(toolCallId));
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return (0, common_1.createToolCallError)(`Error executing tool '${toolId}': ${errorMessage}`);
            }
        }
        return (0, common_1.createToolCallError)(`Tool '${toolId}' not found in the available tools for this request.`, 'tool-not-available');
    }
    // called by backend via the "delegate client" with the error to use for rejection
    error(id, error) {
        if (!this.streams.has(id)) {
            const newStreamState = {
                id,
                tokens: [],
            };
            this.streams.set(id, newStreamState);
        }
        const streamState = this.streams.get(id);
        streamState.reject?.(error);
    }
    async selectLanguageModels(request) {
        await this.initialized;
        const userSettings = (await this.settingsService.getAgentSettings(request.agent))?.languageModelRequirements?.find(req => req.purpose === request.purpose);
        const identifier = userSettings?.identifier ?? request.identifier;
        if (identifier) {
            const model = await this.getReadyLanguageModel(identifier);
            if (model) {
                return [model];
            }
        }
        // Previously we returned the default model here, but this is not really transparent for the user so we do not select any model here.
        return undefined;
    }
    async getReadyLanguageModel(idOrAlias) {
        await this.aliasRegistry.ready;
        const modelIds = this.aliasRegistry.resolveAlias(idOrAlias);
        if (modelIds) {
            for (const modelId of modelIds) {
                const model = await this.getLanguageModel(modelId);
                if (model?.status.status === 'ready') {
                    return model;
                }
            }
            return undefined;
        }
        const languageModel = await this.getLanguageModel(idOrAlias);
        return languageModel?.status.status === 'ready' ? languageModel : undefined;
    }
};
exports.FrontendLanguageModelRegistryImpl = FrontendLanguageModelRegistryImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.LanguageModelAliasRegistry),
    tslib_1.__metadata("design:type", Object)
], FrontendLanguageModelRegistryImpl.prototype, "aliasRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.LanguageModelRegistryFrontendDelegate),
    tslib_1.__metadata("design:type", Object)
], FrontendLanguageModelRegistryImpl.prototype, "registryDelegate", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.LanguageModelFrontendDelegate),
    tslib_1.__metadata("design:type", Object)
], FrontendLanguageModelRegistryImpl.prototype, "providerDelegate", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(LanguageModelDelegateClientImpl),
    tslib_1.__metadata("design:type", LanguageModelDelegateClientImpl)
], FrontendLanguageModelRegistryImpl.prototype, "client", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(output_channel_1.OutputChannelManager),
    tslib_1.__metadata("design:type", output_channel_1.OutputChannelManager)
], FrontendLanguageModelRegistryImpl.prototype, "outputChannelManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.AISettingsService),
    tslib_1.__metadata("design:type", Object)
], FrontendLanguageModelRegistryImpl.prototype, "settingsService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:FrontendLanguageModelRegistryImpl'),
    tslib_1.__metadata("design:type", Object)
], FrontendLanguageModelRegistryImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], FrontendLanguageModelRegistryImpl.prototype, "init", null);
exports.FrontendLanguageModelRegistryImpl = FrontendLanguageModelRegistryImpl = FrontendLanguageModelRegistryImpl_1 = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FrontendLanguageModelRegistryImpl);
const formatJsonWithIndentation = (obj) => {
    // eslint-disable-next-line no-null/no-null
    const jsonString = JSON.stringify(obj, null, 2);
    const lines = jsonString.split('\n');
    const formattedLines = [];
    lines.forEach(line => {
        const subLines = line.split('\\n');
        const index = indexOfValue(subLines[0]) + 1;
        formattedLines.push(subLines[0]);
        const prefix = index > 0 ? ' '.repeat(index) : '';
        if (index !== -1) {
            for (let i = 1; i < subLines.length; i++) {
                formattedLines.push(prefix + subLines[i]);
            }
        }
    });
    return formattedLines;
};
const indexOfValue = (jsonLine) => {
    const pattern = /"([^"]+)"\s*:\s*/g;
    const match = pattern.exec(jsonLine);
    return match ? match.index + match[0].length : -1;
};
const languageModelOutputHandler = (outputChannelGetter) => ({
    get(target, prop) {
        const original = target[prop];
        if (prop === 'request' && typeof original === 'function') {
            return async function (...args) {
                const outputChannel = outputChannelGetter();
                outputChannel.appendLine('Sending request:');
                const formattedRequest = formatJsonWithIndentation(args[0]);
                outputChannel.append(formattedRequest.join('\n'));
                if (args[1]) {
                    args[1] = new Proxy(args[1], {
                        get(cTarget, cProp) {
                            if (cProp === 'onCancellationRequested') {
                                return (...cargs) => cTarget.onCancellationRequested(() => {
                                    outputChannel.appendLine('\nCancel requested', output_channel_1.OutputChannelSeverity.Warning);
                                    cargs[0]();
                                }, cargs[1], cargs[2]);
                            }
                            return cTarget[cProp];
                        }
                    });
                }
                try {
                    const result = await original.apply(target, args);
                    if ((0, common_1.isLanguageModelStreamResponse)(result)) {
                        outputChannel.appendLine('Received a response stream');
                        const stream = result.stream;
                        const loggedStream = {
                            async *[Symbol.asyncIterator]() {
                                for await (const part of stream) {
                                    outputChannel.append(((0, common_1.isTextResponsePart)(part) && part.content) || '');
                                    yield part;
                                }
                                outputChannel.append('\n');
                                outputChannel.appendLine('End of stream');
                            },
                        };
                        return {
                            ...result,
                            stream: loggedStream,
                        };
                    }
                    else {
                        outputChannel.appendLine('Received a response');
                        outputChannel.appendLine(JSON.stringify(result));
                        return result;
                    }
                }
                catch (err) {
                    outputChannel.appendLine('An error occurred');
                    if (err instanceof Error) {
                        outputChannel.appendLine(err.message, output_channel_1.OutputChannelSeverity.Error);
                    }
                    throw err;
                }
            };
        }
        return original;
    },
});
//# sourceMappingURL=frontend-language-model-registry.js.map