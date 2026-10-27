"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelDiscoveryFetcherImpl = exports.ModelDiscoveryFetcher = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const inversify_1 = require("@theia/core/shared/inversify");
const model_snapshot_store_1 = require("./model-snapshot-store");
exports.ModelDiscoveryFetcher = Symbol('ModelDiscoveryFetcher');
let ModelDiscoveryFetcherImpl = class ModelDiscoveryFetcherImpl {
    constructor() {
        /** Number of attempts (including the first) for a discovery fetch on a retryable error. */
        this.maxAttempts = 3;
        /** Base linear backoff between attempts; multiplied by the number of the attempt that failed. */
        this.retryDelayMs = 500;
    }
    async fetch(request) {
        try {
            const models = await this.listWithRetry(request);
            await this.snapshotStore.write(request.snapshotFile, models);
            return { models, fromCache: false };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const cached = await this.snapshotStore.read(request.snapshotFile);
            if (cached) {
                this.logger.warn(`${request.providerLabel}: model discovery failed (${message}); using cached snapshot.`);
                return { models: cached, fromCache: true, error: message };
            }
            // A run that never succeeded has no snapshot to fall back on, so record the failure here.
            this.logger.error(`${request.providerLabel}: model discovery failed; no cached snapshot to fall back on.`, error);
            throw error;
        }
    }
    /** Lists the models, retrying a transient failure with a linear backoff. */
    async listWithRetry(request) {
        let lastError;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            try {
                return await request.listModels();
            }
            catch (error) {
                lastError = error;
                if (attempt === this.maxAttempts || !request.isRetryable?.(error)) {
                    break;
                }
                await this.delay(this.retryDelayMs * attempt);
            }
        }
        throw lastError;
    }
    /** Waits between two attempts. Overridable so a test does not have to. */
    delay(ms) {
        return (0, promise_util_1.timeout)(ms);
    }
};
exports.ModelDiscoveryFetcherImpl = ModelDiscoveryFetcherImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(model_snapshot_store_1.ModelSnapshotStore),
    tslib_1.__metadata("design:type", Object)
], ModelDiscoveryFetcherImpl.prototype, "snapshotStore", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:ModelDiscoveryFetcherImpl'),
    tslib_1.__metadata("design:type", Object)
], ModelDiscoveryFetcherImpl.prototype, "logger", void 0);
exports.ModelDiscoveryFetcherImpl = ModelDiscoveryFetcherImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ModelDiscoveryFetcherImpl);
//# sourceMappingURL=model-discovery-fetcher.js.map