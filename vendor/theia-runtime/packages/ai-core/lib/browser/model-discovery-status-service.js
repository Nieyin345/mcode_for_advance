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
exports.ModelDiscoveryStatusService = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
/**
 * Frontend registry of provider-level model-discovery status.
 *
 * Provider frontend contributions push their state here as they fetch models; the AI
 * configuration UI observes {@link onDidChange} to render fetching/error/no-credentials state.
 * This is the provider-level counterpart to the per-model `LanguageModelStatus`.
 */
let ModelDiscoveryStatusService = class ModelDiscoveryStatusService {
    constructor() {
        this.descriptors = new Map();
        this.statuses = new Map();
        this.onDidChangeEmitter = new core_1.Emitter();
        /** Fired whenever a provider's status changes; the argument is the new status. */
        this.onDidChange = this.onDidChangeEmitter.event;
    }
    /**
     * Register a provider. Idempotent: re-registering keeps any existing status and only
     * updates the refresh callback and label.
     */
    registerProvider(descriptor) {
        this.descriptors.set(descriptor.providerId, descriptor);
        if (!this.statuses.has(descriptor.providerId)) {
            this.statuses.set(descriptor.providerId, {
                providerId: descriptor.providerId,
                label: descriptor.label,
                modelIdPrefix: descriptor.modelIdPrefix,
                state: 'idle'
            });
        }
        this.onDidChangeEmitter.fire(this.statuses.get(descriptor.providerId));
    }
    /**
     * Update a provider's status. Only the provided fields are changed; the rest are carried
     * over from the previous status. Passing `undefined` for an optional field explicitly clears it.
     */
    updateStatus(providerId, update) {
        const previous = this.statuses.get(providerId);
        const next = {
            providerId,
            label: update.label ?? previous?.label ?? providerId,
            modelIdPrefix: 'modelIdPrefix' in update ? update.modelIdPrefix : previous?.modelIdPrefix,
            state: update.state ?? previous?.state ?? 'idle',
            stateLabel: 'stateLabel' in update ? update.stateLabel : previous?.stateLabel,
            message: 'message' in update ? update.message : previous?.message,
            lastFetch: 'lastFetch' in update ? update.lastFetch : previous?.lastFetch,
            fromCache: 'fromCache' in update ? update.fromCache : previous?.fromCache,
            discovered: 'discovered' in update ? update.discovered : previous?.discovered,
            action: 'action' in update ? update.action : previous?.action
        };
        this.statuses.set(providerId, next);
        this.onDidChangeEmitter.fire(next);
    }
    /**
     * Reports a failed discovery run. Any step of a run can fail, including the ones that only talk to
     * the backend, and nothing awaits the promise a rejection would travel on: a provider's startup
     * does not, and a refresh button cannot act on it. What the previous state offered is cleared, so
     * a failure does not keep reading like the state before it (a badge, a sign-in button).
     */
    reportError(providerId, error) {
        // A run can also fail on this side of the RPC boundary, where nothing else would record it.
        this.logger.error(`Model discovery failed for provider '${providerId}':`, error);
        this.updateStatus(providerId, {
            state: 'error',
            stateLabel: undefined,
            message: error instanceof Error ? error.message : String(error),
            action: undefined
        });
    }
    getStatus(providerId) {
        return this.statuses.get(providerId);
    }
    getStatuses() {
        return [...this.statuses.values()];
    }
    /** Trigger a manual refresh for the given provider, if it is registered. */
    async refresh(providerId) {
        await this.descriptors.get(providerId)?.refresh();
    }
};
exports.ModelDiscoveryStatusService = ModelDiscoveryStatusService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:ModelDiscoveryStatusService'),
    tslib_1.__metadata("design:type", Object)
], ModelDiscoveryStatusService.prototype, "logger", void 0);
exports.ModelDiscoveryStatusService = ModelDiscoveryStatusService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ModelDiscoveryStatusService);
//# sourceMappingURL=model-discovery-status-service.js.map