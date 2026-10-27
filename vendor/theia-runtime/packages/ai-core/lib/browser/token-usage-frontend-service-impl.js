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
exports.TokenUsageFrontendServiceImpl = exports.TokenUsageServiceClientImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const token_usage_service_1 = require("../common/token-usage-service");
const protocol_1 = require("../common/protocol");
let TokenUsageServiceClientImpl = class TokenUsageServiceClientImpl {
    constructor() {
        this._onTokenUsageUpdated = new core_1.Emitter();
        this.onTokenUsageUpdated = this._onTokenUsageUpdated.event;
    }
    notifyTokenUsage(usage) {
        this._onTokenUsageUpdated.fire(usage);
    }
};
exports.TokenUsageServiceClientImpl = TokenUsageServiceClientImpl;
exports.TokenUsageServiceClientImpl = TokenUsageServiceClientImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TokenUsageServiceClientImpl);
let TokenUsageFrontendServiceImpl = class TokenUsageFrontendServiceImpl {
    constructor() {
        this._onTokenUsageUpdated = new core_1.Emitter();
        this.onTokenUsageUpdated = this._onTokenUsageUpdated.event;
        this.cachedUsageData = [];
    }
    init() {
        this.tokenUsageServiceClient.onTokenUsageUpdated(() => {
            this.getTokenUsageData().then(data => {
                this._onTokenUsageUpdated.fire(data);
            });
        });
    }
    /**
     * Gets the current token usage data for all models
     */
    async getTokenUsageData() {
        try {
            const usages = await this.tokenUsageService.getTokenUsages();
            this.cachedUsageData = this.aggregateTokenUsages(usages);
            return this.cachedUsageData;
        }
        catch (error) {
            this.logger.error('Failed to get token usage data:', error);
            return [];
        }
    }
    /**
     * Aggregates token usages by model
     */
    aggregateTokenUsages(usages) {
        // Group by model
        const modelMap = new Map();
        // Process each usage record
        for (const usage of usages) {
            const existing = modelMap.get(usage.model);
            if (existing) {
                existing.inputTokens += usage.inputTokens;
                existing.outputTokens += usage.outputTokens;
                // Add cached tokens if they exist
                if (usage.cachedInputTokens !== undefined) {
                    existing.cachedInputTokens += usage.cachedInputTokens;
                }
                // Add read cached tokens if they exist
                if (usage.readCachedInputTokens !== undefined) {
                    existing.readCachedInputTokens += usage.readCachedInputTokens;
                }
                // Update last used if this usage is more recent
                if (!existing.lastUsed || (usage.timestamp && usage.timestamp > existing.lastUsed)) {
                    existing.lastUsed = usage.timestamp;
                }
            }
            else {
                modelMap.set(usage.model, {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cachedInputTokens: usage.cachedInputTokens || 0,
                    readCachedInputTokens: usage.readCachedInputTokens || 0,
                    lastUsed: usage.timestamp
                });
            }
        }
        // Convert map to array of model usage data
        const result = [];
        for (const [modelId, data] of modelMap.entries()) {
            const modelData = {
                modelId,
                inputTokens: data.inputTokens,
                outputTokens: data.outputTokens,
                lastUsed: data.lastUsed
            };
            // Only include cache-related fields if they have non-zero values
            if (data.cachedInputTokens > 0) {
                modelData.cachedInputTokens = data.cachedInputTokens;
            }
            if (data.readCachedInputTokens > 0) {
                modelData.readCachedInputTokens = data.readCachedInputTokens;
            }
            result.push(modelData);
        }
        return result;
    }
};
exports.TokenUsageFrontendServiceImpl = TokenUsageFrontendServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(protocol_1.TokenUsageServiceClient),
    tslib_1.__metadata("design:type", Object)
], TokenUsageFrontendServiceImpl.prototype, "tokenUsageServiceClient", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(token_usage_service_1.TokenUsageService),
    tslib_1.__metadata("design:type", Object)
], TokenUsageFrontendServiceImpl.prototype, "tokenUsageService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:TokenUsageFrontendServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], TokenUsageFrontendServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], TokenUsageFrontendServiceImpl.prototype, "init", null);
exports.TokenUsageFrontendServiceImpl = TokenUsageFrontendServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TokenUsageFrontendServiceImpl);
//# sourceMappingURL=token-usage-frontend-service-impl.js.map