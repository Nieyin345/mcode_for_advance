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
exports.AiConfigurationServiceImpl = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const preferences_1 = require("@theia/core/lib/common/preferences");
const trust_aware_preference_reader_1 = require("./trust-aware-preference-reader");
/**
 * Prefix shared by all AI-related preference keys. Only changes to keys under this namespace are
 * surfaced through {@link AiConfigurationService.onDidChange}.
 */
const AI_PREFERENCE_PREFIX = 'ai-features.';
let AiConfigurationServiceImpl = class AiConfigurationServiceImpl {
    constructor() {
        this.toDispose = new core_1.DisposableCollection();
        this.onDidChangeEmitter = new core_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
        this._ready = new promise_util_1.Deferred();
    }
    get ready() {
        return this._ready.promise;
    }
    init() {
        this._ready.resolve(Promise.all([this.preferenceService.ready, this.trustAwareReader.ready]).then(() => undefined));
        this.toDispose.push(this.onDidChangeEmitter);
        this.toDispose.push(this.preferenceService.onPreferenceChanged(change => {
            if (change.preferenceName.startsWith(AI_PREFERENCE_PREFIX)) {
                this.onDidChangeEmitter.fire({
                    preferenceName: change.preferenceName,
                    affects: resourceUri => change.affects(resourceUri),
                    affectsPreference: preferenceName => preferenceName === change.preferenceName
                });
            }
        }));
        this.toDispose.push(
        // A trust transition can change the effective value of any trust-gated key. Emit a
        // single change with no `preferenceName` and a sentinel `affects()` so listeners
        // re-query, mirroring how trust-aware services already react to trust changes.
        this.trustAwareReader.onDidChangeTrust(() => this.onDidChangeEmitter.fire({
            preferenceName: undefined,
            affects: () => true,
            affectsPreference: preferenceName => preferenceName.startsWith(AI_PREFERENCE_PREFIX)
        })));
    }
    get(key, defaultValue, resourceUri) {
        return this.trustAwareReader.get(key, defaultValue, resourceUri);
    }
    set(key, value, scope, resourceUri) {
        return this.preferenceService.set(key, value, scope, resourceUri);
    }
    update(key, value, resourceUri) {
        return this.preferenceService.updateValue(key, value, resourceUri);
    }
    inspect(key, resourceUri) {
        const inspection = this.preferenceService.inspect(key, resourceUri);
        if (!inspection) {
            return undefined;
        }
        return this.enrichInspection(inspection);
    }
    /**
     * Derives the trust-aware {@link AiConfigurationInspection.sourceScope} and effective `value`
     * from a raw {@link PreferenceInspection}. The workspace-trust rule is applied once, via
     * {@link TrustAwarePreferenceReader.suppressUntrusted} (the single owner of that rule): when
     * untrusted, folder and workspace scope values are cleared, so the scope walk below naturally
     * resolves to the user/default scope and the whole inspection stays consistent with {@link get}.
     *
     * Note: `value` reflects the narrowest defined scope, matching `PreferenceService.inspect`. For
     * object-valued preferences this can differ from {@link get}, which deep-merges across scopes.
     */
    enrichInspection(inspection) {
        const suppressed = this.trustAwareReader.suppressUntrusted(inspection);
        if (suppressed.workspaceFolderValue !== undefined) {
            return { ...suppressed, sourceScope: preferences_1.PreferenceScope.Folder, value: suppressed.workspaceFolderValue };
        }
        if (suppressed.workspaceValue !== undefined) {
            return { ...suppressed, sourceScope: preferences_1.PreferenceScope.Workspace, value: suppressed.workspaceValue };
        }
        if (suppressed.globalValue !== undefined) {
            return { ...suppressed, sourceScope: preferences_1.PreferenceScope.User, value: suppressed.globalValue };
        }
        return { ...suppressed, sourceScope: undefined, value: suppressed.defaultValue };
    }
};
exports.AiConfigurationServiceImpl = AiConfigurationServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(preferences_1.PreferenceService),
    tslib_1.__metadata("design:type", Object)
], AiConfigurationServiceImpl.prototype, "preferenceService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(trust_aware_preference_reader_1.TrustAwarePreferenceReader),
    tslib_1.__metadata("design:type", trust_aware_preference_reader_1.TrustAwarePreferenceReader)
], AiConfigurationServiceImpl.prototype, "trustAwareReader", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], AiConfigurationServiceImpl.prototype, "init", null);
exports.AiConfigurationServiceImpl = AiConfigurationServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AiConfigurationServiceImpl);
//# sourceMappingURL=ai-configuration-service-impl.js.map