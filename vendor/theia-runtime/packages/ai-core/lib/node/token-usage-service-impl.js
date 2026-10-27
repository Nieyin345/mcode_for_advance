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
exports.TokenUsageServiceImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
let TokenUsageServiceImpl = class TokenUsageServiceImpl {
    constructor() {
        this.tokenUsages = [];
    }
    /**
     * Sets the client to notify about token usage changes
     */
    setClient(client) {
        this.client = client;
    }
    /**
     * Records token usage for a model interaction.
     *
     * @param model The model identifier
     * @param params Token usage parameters
     * @returns A promise that resolves when the token usage has been recorded
     */
    async recordTokenUsage(model, params) {
        const usage = {
            inputTokens: params.inputTokens,
            cachedInputTokens: params.cachedInputTokens,
            readCachedInputTokens: params.readCachedInputTokens,
            outputTokens: params.outputTokens,
            model,
            timestamp: new Date(),
            requestId: params.requestId
        };
        this.tokenUsages.push(usage);
        this.client?.notifyTokenUsage(usage);
        let logMessage = `Input Tokens: ${params.inputTokens};`;
        if (params.cachedInputTokens) {
            logMessage += ` Input Tokens written to cache: ${params.cachedInputTokens};`;
        }
        if (params.readCachedInputTokens) {
            logMessage += ` Input Tokens read from cache: ${params.readCachedInputTokens};`;
        }
        logMessage += ` Output Tokens: ${params.outputTokens}; Model: ${model};`;
        if (params.requestId) {
            logMessage += `; RequestId: ${params.requestId}`;
        }
        this.logger.debug(logMessage);
        // For now we just store in memory
        // In the future, this could be persisted to disk, a database, or sent to a service
        return Promise.resolve();
    }
    /**
     * Gets all token usage records stored in this service.
     */
    async getTokenUsages() {
        return [...this.tokenUsages];
    }
};
exports.TokenUsageServiceImpl = TokenUsageServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:TokenUsageServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], TokenUsageServiceImpl.prototype, "logger", void 0);
exports.TokenUsageServiceImpl = TokenUsageServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TokenUsageServiceImpl);
//# sourceMappingURL=token-usage-service-impl.js.map