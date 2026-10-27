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
exports.FavoriteModelsService = exports.FEATURED_MODEL_COUNT = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const ai_core_preferences_1 = require("../common/ai-core-preferences");
const model_discovery_util_1 = require("../common/model-discovery-util");
const model_discovery_status_service_1 = require("./model-discovery-status-service");
/**
 * How many of a provider's models are offered without the user asking. Enough to cover a provider's
 * current line-up (a flagship, a fast one, a cheap one and their immediate predecessors) without
 * turning the model pickers back into a catalogue.
 */
exports.FEATURED_MODEL_COUNT = 5;
/**
 * Decides which models the model picker in the AI chat input offers.
 *
 * Discovery registers everything a provider offers, including one entry per release, which is far
 * more than anyone picks between while chatting. What that picker shows is therefore the *favorites*:
 * the models that are featured automatically plus the ones the user marked. Everywhere a model is
 * chosen deliberately — an agent's model, a model alias — every discovered model stays on offer.
 *
 * A model is featured when it is one of the {@link FEATURED_MODEL_COUNT} most recently released
 * undated ids of its provider — so `claude-opus-5` is featured while `claude-opus-5-20260401` is
 * not. Because the featured set is derived from each discovery rather than stored, a model released
 * tomorrow is offered the day it appears, and the user cannot end up pinned to a stale line-up.
 *
 * Both directions are the user's to override, and only the override is stored: a model offered by
 * default is taken out of the picker by an entry in {@link PREFERENCE_NAME_HIDDEN_MODELS}, any other
 * model is put into it by an entry in {@link PREFERENCE_NAME_FAVORITE_MODELS}. A model nobody touched
 * appears in neither.
 *
 * Models of a provider that does not participate in discovery — one whose models are configured by
 * hand, or a custom endpoint — are all favorites: listing them *was* the user's choice.
 */
let FavoriteModelsService = class FavoriteModelsService {
    constructor() {
        this.onDidChangeEmitter = new core_1.Emitter();
        /** Fired when the marked models or the featured set change. */
        this.onDidChange = this.onDidChangeEmitter.event;
    }
    init() {
        this.discoveryStatus.onDidChange(status => {
            this.derived = undefined;
            this.pruneFavorites(status);
            this.onDidChangeEmitter.fire();
        });
        this.preferenceService.onPreferenceChanged(event => {
            if (event.preferenceName === ai_core_preferences_1.PREFERENCE_NAME_FAVORITE_MODELS || event.preferenceName === ai_core_preferences_1.PREFERENCE_NAME_HIDDEN_MODELS) {
                this.onDidChangeEmitter.fire();
            }
        });
    }
    /** Whether the chat input's model picker offers this model, be it featured, marked or hand-configured. */
    isFavorite(modelId) {
        if (this.getHidden().includes(modelId)) {
            return false;
        }
        return this.isOfferedByDefault(modelId) || this.getFavorites().includes(modelId);
    }
    /**
     * Whether the picker would offer this model without the user marking it: one of the newest of a
     * provider that discovers, or any model of a provider that does not. Nothing was discovered for
     * the latter, so its models are there because someone put them there - a manually configured
     * provider, or a custom endpoint. That is choice enough.
     */
    isOfferedByDefault(modelId) {
        return !this.participatesInDiscovery(modelId) || this.isFeatured(modelId);
    }
    /** Whether the model's provider reports a discovery status, i.e. whether featuring applies to it at all. */
    participatesInDiscovery(modelId) {
        const separator = modelId.indexOf('/');
        if (separator <= 0) {
            return false;
        }
        return this.getDerived().discoveryPrefixes.has(modelId.substring(0, separator));
    }
    /**
     * Whether the model is offered automatically because it is among its provider's newest, in which
     * case it cannot be unmarked.
     */
    isFeatured(modelId) {
        return this.getFeatured().has(modelId);
    }
    /** The ids the user marked explicitly, the ones offered by default excluded. */
    getFavorites() {
        return this.preferenceService.get(ai_core_preferences_1.PREFERENCE_NAME_FAVORITE_MODELS, []);
    }
    /** The ids the user took out of the picker, which would otherwise be offered by default. */
    getHidden() {
        return this.preferenceService.get(ai_core_preferences_1.PREFERENCE_NAME_HIDDEN_MODELS, []);
    }
    /**
     * Whether the user decided anything about this provider's models, i.e. whether resetting it to the
     * models it offers by default would change what the picker shows.
     *
     * @param modelIdPrefix prefix of the provider's registered model ids, e.g. `openai`
     */
    hasOverrides(modelIdPrefix) {
        return [...this.getFavorites(), ...this.getHidden()].some(id => id.startsWith(`${modelIdPrefix}/`));
    }
    /**
     * Drops what the user decided about one provider's models, so the picker shows the models that
     * provider offers by default again. The other providers are left alone.
     *
     * @param modelIdPrefix prefix of the provider's registered model ids, e.g. `openai`
     */
    async resetToDefaults(modelIdPrefix) {
        for (const preferenceName of [ai_core_preferences_1.PREFERENCE_NAME_FAVORITE_MODELS, ai_core_preferences_1.PREFERENCE_NAME_HIDDEN_MODELS]) {
            const ids = this.preferenceService.get(preferenceName, []);
            const kept = ids.filter(id => !id.startsWith(`${modelIdPrefix}/`));
            if (kept.length !== ids.length) {
                await this.write(preferenceName, kept);
            }
        }
    }
    /**
     * Puts a model into the picker or takes it out of it, whichever the current state calls for. Only
     * the deviation from the default is stored: a model offered by default is taken out by an entry in
     * the hidden list, and any other by dropping its entry from the favorites (or adding one).
     */
    async toggleFavorite(modelId) {
        const favorites = this.getFavorites();
        const hidden = this.getHidden();
        if (this.isFavorite(modelId)) {
            if (favorites.includes(modelId)) {
                await this.write(ai_core_preferences_1.PREFERENCE_NAME_FAVORITE_MODELS, favorites.filter(id => id !== modelId));
            }
            if (this.isOfferedByDefault(modelId)) {
                await this.write(ai_core_preferences_1.PREFERENCE_NAME_HIDDEN_MODELS, [...hidden, modelId]);
            }
            return;
        }
        if (hidden.includes(modelId)) {
            await this.write(ai_core_preferences_1.PREFERENCE_NAME_HIDDEN_MODELS, hidden.filter(id => id !== modelId));
        }
        // A model that was hidden while it was featured and has since fallen out of the featured set
        // needs a mark of its own, or removing the entry would not bring it back.
        if (!this.isOfferedByDefault(modelId)) {
            await this.write(ai_core_preferences_1.PREFERENCE_NAME_FAVORITE_MODELS, [...favorites, modelId]);
        }
    }
    async write(preferenceName, ids) {
        await this.preferenceService.set(preferenceName, ids, core_1.PreferenceScope.User);
    }
    /** The featured ids across all providers that participate in discovery, fully qualified. */
    getFeatured() {
        return this.getDerived().featured;
    }
    /**
     * What the last discovery implies, computed once and kept until it changes. The chat input asks
     * per model on every render, and ranking each provider's models per question would mean sorting
     * the whole catalogue as many times as it has entries.
     */
    getDerived() {
        if (!this.derived) {
            const featured = new Set();
            const discoveryPrefixes = new Set();
            for (const status of this.discoveryStatus.getStatuses()) {
                const prefix = status.modelIdPrefix ?? status.providerId;
                discoveryPrefixes.add(prefix);
                for (const model of this.selectFeatured(status)) {
                    featured.add(`${prefix}/${model.id}`);
                }
            }
            this.derived = { featured, discoveryPrefixes };
        }
        return this.derived;
    }
    /**
     * The models of one provider that are offered automatically: at most {@link FEATURED_MODEL_COUNT}
     * of its undated ids. A release-pinned id is never featured — the undated form of the same model
     * already is, and pinning a release is the deliberate choice the switch on its row makes.
     *
     * They are ranked by what the provider reports about them, in that order:
     *
     * 1. most recently released, where the provider reports release dates (Anthropic, OpenAI);
     * 2. a `-latest` pointer the provider maintains at the current model of a family, which only
     *    decides where there are no dates: a provider that reports them dates its pointers as well;
     * 3. highest version in the id, which is what is left for Gemini — the naming of those models
     *    carries their generation (`gemini-3.7-flash` over `gemini-2.5-pro`).
     *
     * What the model aliases name has no say in this: an alias is a curated list of its own, pointing
     * at the model a purpose should use, which is a different question from which models are worth
     * offering in the picker.
     *
     * An explicitly configured list (`modelOverrides`) is featured in full: the user named it. So is a
     * provider's own nomination ({@link DiscoveredModel.featured}), which a provider makes when the
     * generic ranking cannot serve it — Copilot carries models of many vendors and nominates one each
     * of the three the other providers offer directly, where "the newest five" would pick five of
     * whichever vendor numbers its models highest.
     */
    selectFeatured(status) {
        const discovered = status.discovered ?? [];
        if (status.state === 'overridden') {
            return [...discovered];
        }
        const nominated = discovered.filter(model => model.featured);
        if (nominated.length > 0) {
            return nominated;
        }
        return discovered
            .filter(model => model_discovery_util_1.DiscoveredModels.undatedId(model.id) === undefined)
            .map((model, index) => ({ model, index }))
            .sort((left, right) => this.compareFeatured(left, right))
            .slice(0, exports.FEATURED_MODEL_COUNT)
            .map(entry => entry.model);
    }
    /** Orders two candidates of the same provider; `index` preserves the reported order as the last resort. */
    compareFeatured(left, right) {
        const byRelease = (right.model.released ?? 0) - (left.model.released ?? 0);
        if (byRelease !== 0) {
            return byRelease;
        }
        // Only where a provider reports no dates: a pointer at its current model of a family is as
        // current as a model gets, and it carries no version, so it would otherwise sort behind every
        // id that does. Where there are dates, the pointer carries one too and has been ordered by it.
        const byPointer = Number(model_discovery_util_1.DiscoveredModels.isLatestPointer(right.model.id)) - Number(model_discovery_util_1.DiscoveredModels.isLatestPointer(left.model.id));
        if (byPointer !== 0) {
            return byPointer;
        }
        const byVersion = model_discovery_util_1.DiscoveredModels.compareByVersion(left.model.id, right.model.id);
        return byVersion !== 0 ? byVersion : left.index - right.index;
    }
    /**
     * Drops the marked and hidden ids of a provider that a successful discovery no longer offers, so
     * that neither list accumulates models that no longer exist. Only a live discovery prunes: a
     * cached result, a failure or a missing credential says nothing about what the provider offers.
     */
    pruneFavorites(status) {
        if (status.state !== 'ready' || status.fromCache || !status.discovered) {
            return;
        }
        const prefix = status.modelIdPrefix ?? status.providerId;
        const offered = new Set(status.discovered.map(model => `${prefix}/${model.id}`));
        for (const preferenceName of [ai_core_preferences_1.PREFERENCE_NAME_FAVORITE_MODELS, ai_core_preferences_1.PREFERENCE_NAME_HIDDEN_MODELS]) {
            const ids = this.preferenceService.get(preferenceName, []);
            const kept = ids.filter(id => !id.startsWith(`${prefix}/`) || offered.has(id));
            if (kept.length !== ids.length) {
                this.write(preferenceName, kept);
            }
        }
    }
};
exports.FavoriteModelsService = FavoriteModelsService;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], FavoriteModelsService.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(model_discovery_status_service_1.ModelDiscoveryStatusService),
    tslib_1.__metadata("design:type", model_discovery_status_service_1.ModelDiscoveryStatusService)
], FavoriteModelsService.prototype, "discoveryStatus", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], FavoriteModelsService.prototype, "init", null);
exports.FavoriteModelsService = FavoriteModelsService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FavoriteModelsService);
//# sourceMappingURL=favorite-models-service.js.map