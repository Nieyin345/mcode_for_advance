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
exports.DiscoveringProviderContribution = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const model_discovery_status_service_1 = require("./model-discovery-status-service");
/**
 * The shared half of a provider that discovers its language models: it asks the provider what it
 * offers, registers the answer, unregisters what disappeared, and reports the state of all of that
 * to the {@link ModelDiscoveryStatusService} so the provider's page can show it.
 *
 * A provider brings what only it can know: its id, its manager, the preferences it reads, how a
 * discovered model becomes a model description, and the messages that name it. Everything a provider
 * does beyond discovery (a custom endpoint, a proxy, its own retry settings) stays in the subclass,
 * which hooks into {@link initializeProvider} and {@link handlePreferenceChange}.
 */
let DiscoveringProviderContribution = class DiscoveringProviderContribution {
    constructor() {
        /** The models registered from the last discovery, as the provider reported them. */
        this.discoveredModels = [];
        /** Ensures the env-key consent prompt is shown at most once per session. */
        this.envConsentPrompted = false;
        this.discovering = Promise.resolve();
    }
    /** Prefix of this provider's registered model ids. Defaults to {@link providerId}. */
    get modelIdPrefix() {
        return this.providerId;
    }
    onStart() {
        this.preferenceService.ready.then(() => {
            // Before any key is read: an environment key stays unused until it has been confirmed.
            this.manager.setAllowEnvironmentApiKey(this.isEnvironmentApiKeyAllowed());
            this.initializeProvider();
            this.discoveryStatus.registerProvider({
                providerId: this.providerId,
                label: this.providerLabel,
                modelIdPrefix: this.modelIdPrefix === this.providerId ? undefined : this.modelIdPrefix,
                refresh: () => this.discoverAndRegisterModels()
            });
            this.discoverAndRegisterModels();
            this.preferenceService.onPreferenceChanged(event => {
                if (event.preferenceName === this.allowEnvironmentApiKeyPreference || event.preferenceName === this.modelOverridesPreference) {
                    // Withdrawing the consent has to stop the key being used, not just stop discovering.
                    this.manager.setAllowEnvironmentApiKey(this.isEnvironmentApiKeyAllowed());
                    this.discoverAndRegisterModels();
                }
                else {
                    this.handlePreferenceChange(event);
                }
            });
        });
    }
    /**
     * Hands the provider's own configuration to its manager, before the first discovery run asks it
     * anything. Also the place to register the models and listeners that discovery does not cover.
     */
    initializeProvider() {
    }
    /** Handles a change to a preference of this provider that is not part of discovery itself. */
    handlePreferenceChange(event) {
    }
    /** Fetches what the provider offers and registers it, removing whatever disappeared. */
    async discoverAndRegisterModels() {
        // Runs are queued rather than overlapped: startup, a key change and a manual refresh can all
        // ask within a moment of each other, and two runs in flight would compute what to unregister
        // from the same stale list and leave the registry disagreeing with the provider.
        this.discovering = this.discovering.then(() => this.runDiscovery().catch(error => this.discoveryStatus.reportError(this.providerId, error)));
        return this.discovering;
    }
    async runDiscovery() {
        // A configured model list replaces discovery entirely: the provider is not asked what it
        // offers, so the list is exactly what was configured. This is what pins a catalogue against
        // provider changes, and the way to name models when the list endpoint cannot be reached at all.
        const overrides = this.getModelOverrides();
        if (overrides.length > 0) {
            const configured = overrides.map(id => ({ id }));
            await this.applyDiscoveredModels(configured);
            this.discoveryStatus.updateStatus(this.providerId, {
                state: 'overridden',
                discovered: configured,
                message: this.discoveryMessages.overridden,
                lastFetch: undefined,
                fromCache: false
            });
            return;
        }
        const source = await this.manager.getApiKeySource();
        if (source === 'none') {
            this.removeAllDiscoveredModels();
            this.discoveryStatus.updateStatus(this.providerId, { state: 'no-credentials', message: this.discoveryMessages.noCredentials });
            return;
        }
        // An API key from the environment is only used once the user has confirmed it.
        if (source === 'environment' && !this.isEnvironmentApiKeyAllowed()) {
            this.removeAllDiscoveredModels();
            this.discoveryStatus.updateStatus(this.providerId, { state: 'awaiting-consent', message: this.discoveryMessages.consentRequired });
            this.promptEnvironmentApiKeyConsentOnce();
            return;
        }
        this.discoveryStatus.updateStatus(this.providerId, { state: 'fetching', message: undefined });
        const { models, fromCache, error } = await this.manager.fetchAvailableModels();
        await this.applyDiscoveredModels(models);
        this.discoveryStatus.updateStatus(this.providerId, {
            state: 'ready',
            discovered: models,
            // When served from cache after a failed refresh, keep the models usable but flag staleness.
            message: fromCache && error ? this.discoveryMessages.cached(error) : undefined,
            lastFetch: fromCache ? undefined : Date.now(),
            fromCache
        });
    }
    /** Registers the discovered models and unregisters the ones that are no longer offered. */
    async applyDiscoveredModels(models) {
        const modelIds = models.map(model => model.id);
        const removed = this.discoveredModels.filter(model => !modelIds.includes(model.id));
        this.manager.removeLanguageModels(...removed.map(model => this.qualifiedModelId(model.id)));
        await this.manager.createOrUpdateLanguageModels(...models.map(model => this.createModelDescription(model)));
        this.discoveredModels = models;
    }
    /** Re-applies the descriptions of the already-discovered models, after a preference that feeds them changed. */
    updateDiscoveredModels() {
        this.manager.createOrUpdateLanguageModels(...this.discoveredModels.map(model => this.createModelDescription(model)));
    }
    removeAllDiscoveredModels() {
        if (this.discoveredModels.length > 0) {
            this.manager.removeLanguageModels(...this.discoveredModels.map(model => this.qualifiedModelId(model.id)));
            this.discoveredModels = [];
        }
    }
    qualifiedModelId(modelId) {
        return `${this.modelIdPrefix}/${modelId}`;
    }
    getModelOverrides() {
        return this.preferenceService.get(this.modelOverridesPreference, []);
    }
    isEnvironmentApiKeyAllowed() {
        return this.preferenceService.get(this.allowEnvironmentApiKeyPreference, false);
    }
    /**
     * Asks the user once per session to confirm using an environment-provided API key. Confirming
     * persists {@link allowEnvironmentApiKeyPreference}, which re-triggers discovery.
     */
    promptEnvironmentApiKeyConsentOnce() {
        if (this.envConsentPrompted) {
            return;
        }
        this.envConsentPrompted = true;
        const useKey = this.discoveryMessages.useEnvironmentKey;
        const ignore = core_1.nls.localizeByDefault('Ignore');
        this.messageService.info(this.discoveryMessages.consentPrompt, useKey, ignore).then(choice => {
            if (choice === useKey) {
                this.preferenceService.set(this.allowEnvironmentApiKeyPreference, true, core_1.PreferenceScope.User);
            }
        });
    }
};
exports.DiscoveringProviderContribution = DiscoveringProviderContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], DiscoveringProviderContribution.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(model_discovery_status_service_1.ModelDiscoveryStatusService),
    tslib_1.__metadata("design:type", model_discovery_status_service_1.ModelDiscoveryStatusService)
], DiscoveringProviderContribution.prototype, "discoveryStatus", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], DiscoveringProviderContribution.prototype, "messageService", void 0);
exports.DiscoveringProviderContribution = DiscoveringProviderContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DiscoveringProviderContribution);
//# sourceMappingURL=discovering-provider-contribution.js.map