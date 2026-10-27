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
exports.LanguageModelFrontendDelegateImpl = exports.LanguageModelRegistryFrontendDelegateImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const common_1 = require("../common");
const backend_language_model_registry_1 = require("./backend-language-model-registry");
let LanguageModelRegistryFrontendDelegateImpl = class LanguageModelRegistryFrontendDelegateImpl {
    setClient(client) {
        this.registry.setClient(client);
    }
    async getLanguageModelDescriptions() {
        return (await this.registry.getLanguageModels()).map(model => this.registry.mapToMetaData(model));
    }
};
exports.LanguageModelRegistryFrontendDelegateImpl = LanguageModelRegistryFrontendDelegateImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.LanguageModelRegistry),
    tslib_1.__metadata("design:type", backend_language_model_registry_1.BackendLanguageModelRegistryImpl)
], LanguageModelRegistryFrontendDelegateImpl.prototype, "registry", void 0);
exports.LanguageModelRegistryFrontendDelegateImpl = LanguageModelRegistryFrontendDelegateImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], LanguageModelRegistryFrontendDelegateImpl);
let LanguageModelFrontendDelegateImpl = class LanguageModelFrontendDelegateImpl {
    constructor() {
        this.requestCancellationTokenMap = new Map();
    }
    setClient(client) {
        this.frontendDelegateClient = client;
    }
    cancel(requestId) {
        this.requestCancellationTokenMap.get(requestId)?.cancel();
    }
    async request(modelId, request, requestId, cancellationToken) {
        const model = await this.registry.getLanguageModel(modelId);
        if (!model) {
            throw new Error(`Request was sent to non-existent language model ${modelId}`);
        }
        request.tools?.forEach(tool => {
            tool.handler = async (args_string, ctx) => this.frontendDelegateClient.toolCall(requestId, tool.id, args_string, ctx?.toolCallId);
        });
        if (cancellationToken) {
            const tokenSource = new core_1.CancellationTokenSource();
            cancellationToken = tokenSource.token;
            this.requestCancellationTokenMap.set(requestId, tokenSource);
        }
        const response = await model.request(request, cancellationToken);
        if ((0, common_1.isLanguageModelTextResponse)(response) || (0, common_1.isLanguageModelParsedResponse)(response)) {
            return response;
        }
        if ((0, common_1.isLanguageModelStreamResponse)(response)) {
            const delegate = {
                streamId: (0, core_1.generateUuid)(),
            };
            this.sendTokens(delegate.streamId, response.stream, cancellationToken);
            return delegate;
        }
        this.logger.error(`Received unexpected response from language model ${modelId}. Trying to continue without touching the response.`, response);
        return response;
    }
    sendTokens(id, stream, cancellationToken) {
        (async () => {
            try {
                for await (const token of stream) {
                    this.frontendDelegateClient.send(id, token);
                }
            }
            catch (e) {
                if (!cancellationToken?.isCancellationRequested) {
                    this.frontendDelegateClient.error(id, e);
                }
            }
            finally {
                this.frontendDelegateClient.send(id, undefined);
            }
        })();
    }
};
exports.LanguageModelFrontendDelegateImpl = LanguageModelFrontendDelegateImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.LanguageModelRegistry),
    tslib_1.__metadata("design:type", Object)
], LanguageModelFrontendDelegateImpl.prototype, "registry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:LanguageModelFrontendDelegateImpl'),
    tslib_1.__metadata("design:type", Object)
], LanguageModelFrontendDelegateImpl.prototype, "logger", void 0);
exports.LanguageModelFrontendDelegateImpl = LanguageModelFrontendDelegateImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], LanguageModelFrontendDelegateImpl);
//# sourceMappingURL=language-model-frontend-delegate.js.map