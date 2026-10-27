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
exports.LanguageModelServiceImpl = exports.LanguageModelService = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const language_model_1 = require("./language-model");
const core_1 = require("@theia/core");
exports.LanguageModelService = Symbol('LanguageModelService');
class LanguageModelServiceImpl {
    constructor() {
        this._sessions = [];
        this.sessionChangedEmitter = new core_1.Emitter();
        this.onSessionChanged = this.sessionChangedEmitter.event;
    }
    get sessions() {
        return this._sessions;
    }
    set sessions(newSessions) {
        this._sessions = newSessions;
        if (newSessions.length === 0) {
            this.sessionChangedEmitter.fire({ type: 'sessionsCleared' });
        }
    }
    async sendRequest(languageModel, languageModelRequest) {
        // Filter messages based on client settings
        languageModelRequest.messages = languageModelRequest.messages.filter(message => {
            if (message.type === 'thinking' && languageModelRequest.clientSettings?.keepThinking === false) {
                return false;
            }
            if ((message.type === 'tool_result' || message.type === 'tool_use' || message.type === 'server_tool_use') &&
                languageModelRequest.clientSettings?.keepToolCalls === false) {
                return false;
            }
            // Keep all other messages
            return true;
        });
        let response = await languageModel.request(languageModelRequest, languageModelRequest.cancellationToken);
        let storedResponse;
        if ((0, language_model_1.isLanguageModelStreamResponse)(response)) {
            const parts = [];
            response = {
                ...response,
                stream: createLoggingAsyncIterable(response.stream, parts, () => this.sessionChangedEmitter.fire({ type: 'responseCompleted', requestId: languageModelRequest.subRequestId ?? languageModelRequest.requestId }))
            };
            storedResponse = { parts };
        }
        else {
            storedResponse = response;
        }
        this.storeRequest(languageModel, languageModelRequest, storedResponse);
        return response;
    }
    storeRequest(languageModel, languageModelRequest, response) {
        // Find or create the session for this request
        let session = this._sessions.find(s => s.id === languageModelRequest.sessionId);
        if (!session) {
            session = {
                id: languageModelRequest.sessionId,
                exchanges: []
            };
            this._sessions.push(session);
        }
        // Find or create the exchange for this request
        let exchange = session.exchanges.find(r => r.id === languageModelRequest.requestId);
        if (!exchange) {
            exchange = {
                id: languageModelRequest.requestId,
                requests: [],
                metadata: { agent: languageModelRequest.agentId }
            };
            session.exchanges.push(exchange);
        }
        // Create and add the LanguageModelExchangeRequest to the exchange
        const exchangeRequest = {
            id: languageModelRequest.subRequestId ?? languageModelRequest.requestId,
            request: languageModelRequest,
            languageModel: languageModel.id,
            response: response,
            metadata: {}
        };
        exchange.requests.push(exchangeRequest);
        exchangeRequest.metadata.agent = languageModelRequest.agentId;
        exchangeRequest.metadata.timestamp = Date.now();
        if (languageModelRequest.promptVariantId) {
            exchangeRequest.metadata.promptVariantId = languageModelRequest.promptVariantId;
        }
        if (languageModelRequest.isPromptVariantCustomized !== undefined) {
            exchangeRequest.metadata.isPromptVariantCustomized = languageModelRequest.isPromptVariantCustomized;
        }
        this.sessionChangedEmitter.fire({ type: 'requestAdded', id: languageModelRequest.subRequestId ?? languageModelRequest.requestId });
    }
}
exports.LanguageModelServiceImpl = LanguageModelServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(language_model_1.LanguageModelRegistry),
    tslib_1.__metadata("design:type", Object)
], LanguageModelServiceImpl.prototype, "languageModelRegistry", void 0);
/**
 * Creates an AsyncIterable wrapper that stores each yielded item while preserving the
 * original AsyncIterable behavior.
 */
async function* createLoggingAsyncIterable(stream, parts, streamFinished) {
    try {
        for await (const part of stream) {
            parts.push(part);
            yield part;
        }
    }
    catch (error) {
        parts.push({ content: `[NOT FROM LLM] An error occurred: ${error.message}` });
        throw error;
    }
    finally {
        streamFinished();
    }
}
//# sourceMappingURL=language-model-service.js.map