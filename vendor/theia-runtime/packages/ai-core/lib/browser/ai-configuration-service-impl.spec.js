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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const promise_util_1 = require("@theia/core/lib/common/promise-util");
const preferences_1 = require("@theia/core/lib/common/preferences");
const workspace_trust_service_1 = require("@theia/workspace/lib/browser/workspace-trust-service");
const trust_aware_preference_reader_1 = require("./trust-aware-preference-reader");
const ai_configuration_service_impl_1 = require("./ai-configuration-service-impl");
disableJSDOM();
const KEY = 'ai-features.someKey';
/**
 * Minimal in-memory `PreferenceService` stub that stores values per scope and derives the
 * effective value with the same precedence as the real service.
 */
class StubPreferenceService {
    constructor() {
        this.ready = Promise.resolve();
        this.isReady = true;
        this.values = new Map();
        this.onPreferenceChangedEmitter = new core_1.Emitter();
        this.onPreferenceChanged = this.onPreferenceChangedEmitter.event;
    }
    scopeMap(key) {
        let map = this.values.get(key);
        if (!map) {
            map = new Map();
            this.values.set(key, map);
        }
        return map;
    }
    setScopeValue(key, scope, value) {
        this.scopeMap(key).set(scope, value);
    }
    get(preferenceName, defaultValue) {
        const inspection = this.inspect(preferenceName);
        return inspection?.value ?? defaultValue;
    }
    set(preferenceName, value, scope = preferences_1.PreferenceScope.User) {
        this.scopeMap(preferenceName).set(scope, value);
        this.fire(preferenceName, scope);
        return Promise.resolve();
    }
    updateValue(preferenceName, value) {
        return this.set(preferenceName, value, preferences_1.PreferenceScope.User);
    }
    inspect(preferenceName) {
        const map = this.values.get(preferenceName);
        const defaultValue = map?.get(preferences_1.PreferenceScope.Default);
        const globalValue = map?.get(preferences_1.PreferenceScope.User);
        const workspaceValue = map?.get(preferences_1.PreferenceScope.Workspace);
        const workspaceFolderValue = map?.get(preferences_1.PreferenceScope.Folder);
        const value = workspaceFolderValue ?? workspaceValue ?? globalValue ?? defaultValue;
        return { preferenceName, defaultValue, globalValue, workspaceValue, workspaceFolderValue, value };
    }
    fire(preferenceName, scope) {
        this.onPreferenceChangedEmitter.fire({
            preferenceName,
            scope,
            domain: undefined,
            affects: () => true
        });
    }
}
class StubWorkspaceTrustService {
    constructor() {
        this.trustDeferred = new promise_util_1.Deferred();
        this.emitter = new core_1.Emitter();
        this.onDidChangeWorkspaceTrust = this.emitter.event;
    }
    getWorkspaceTrust() {
        return this.trustDeferred.promise;
    }
    fireTrustChange(trusted) {
        this.emitter.fire(trusted);
    }
}
describe('AiConfigurationServiceImpl', () => {
    let preferences;
    let trust;
    let service;
    const createService = async (trusted) => {
        preferences = new StubPreferenceService();
        trust = new StubWorkspaceTrustService();
        const container = new inversify_1.Container();
        container.bind(preferences_1.PreferenceService).toConstantValue(preferences);
        container.bind(workspace_trust_service_1.WorkspaceTrustService).toConstantValue(trust);
        container.bind(trust_aware_preference_reader_1.TrustAwarePreferenceReader).toSelf().inSingletonScope();
        container.bind(ai_configuration_service_impl_1.AiConfigurationServiceImpl).toSelf().inSingletonScope();
        service = container.get(ai_configuration_service_impl_1.AiConfigurationServiceImpl);
        trust.trustDeferred.resolve(trusted);
        await service.ready;
    };
    describe('acceptance scenario', () => {
        beforeEach(() => createService(true));
        it('writes at User scope, reads back, reports User as source scope, and fires onDidChange', async () => {
            const changes = [];
            service.onDidChange(change => changes.push(change));
            await service.set(KEY, true, preferences_1.PreferenceScope.User);
            (0, chai_1.expect)(service.get(KEY)).to.equal(true);
            (0, chai_1.expect)(service.inspect(KEY)?.sourceScope).to.equal(preferences_1.PreferenceScope.User);
            (0, chai_1.expect)(changes.some(change => change.preferenceName === KEY)).to.equal(true);
        });
    });
    describe('inspect source-scope derivation (trusted)', () => {
        beforeEach(() => createService(true));
        it('reports undefined source scope when only the default applies', () => {
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.Default, 'default');
            const inspection = service.inspect(KEY);
            (0, chai_1.expect)(inspection?.sourceScope).to.equal(undefined);
            (0, chai_1.expect)(inspection?.value).to.equal('default');
        });
        it('reports User when a user value is set', () => {
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.Default, 'default');
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.User, 'user');
            const inspection = service.inspect(KEY);
            (0, chai_1.expect)(inspection?.sourceScope).to.equal(preferences_1.PreferenceScope.User);
            (0, chai_1.expect)(inspection?.value).to.equal('user');
        });
        it('reports Workspace when a workspace value wins', () => {
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.User, 'user');
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.Workspace, 'workspace');
            const inspection = service.inspect(KEY);
            (0, chai_1.expect)(inspection?.sourceScope).to.equal(preferences_1.PreferenceScope.Workspace);
            (0, chai_1.expect)(inspection?.value).to.equal('workspace');
        });
    });
    describe('trust-aware reads', () => {
        it('ignores the workspace value when untrusted', async () => {
            await createService(false);
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.Default, 'default');
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.User, 'user');
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.Workspace, 'workspace');
            (0, chai_1.expect)(service.get(KEY)).to.equal('user');
            const inspection = service.inspect(KEY);
            (0, chai_1.expect)(inspection?.value).to.equal('user');
            (0, chai_1.expect)(inspection?.sourceScope).to.equal(preferences_1.PreferenceScope.User);
            // The suppressed workspace/folder values are cleared, not just excluded from `value`.
            (0, chai_1.expect)(inspection?.workspaceValue).to.equal(undefined);
            (0, chai_1.expect)(inspection?.workspaceFolderValue).to.equal(undefined);
        });
        it('honors the workspace value when trusted', async () => {
            await createService(true);
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.User, 'user');
            preferences.setScopeValue(KEY, preferences_1.PreferenceScope.Workspace, 'workspace');
            (0, chai_1.expect)(service.get(KEY)).to.equal('workspace');
            (0, chai_1.expect)(service.inspect(KEY)?.value).to.equal('workspace');
        });
        it('fires onDidChange (without a preference name) on a trust transition', async () => {
            await createService(false);
            const changes = [];
            service.onDidChange(change => changes.push(change));
            trust.fireTrustChange(true);
            (0, chai_1.expect)(changes).to.have.lengthOf(1);
            (0, chai_1.expect)(changes[0].preferenceName).to.equal(undefined);
            (0, chai_1.expect)(changes[0].affects()).to.equal(true);
            // A trust transition affects every trust-gated (ai-features.*) key, but not unrelated ones.
            (0, chai_1.expect)(changes[0].affectsPreference(KEY)).to.equal(true);
            (0, chai_1.expect)(changes[0].affectsPreference('ai-features.anythingElse')).to.equal(true);
            (0, chai_1.expect)(changes[0].affectsPreference('editor.fontSize')).to.equal(false);
        });
    });
    describe('set vs update', () => {
        beforeEach(() => createService(true));
        it('set writes the exact scope requested', async () => {
            await service.set(KEY, 'workspace', preferences_1.PreferenceScope.Workspace);
            (0, chai_1.expect)(preferences.inspect(KEY)?.workspaceValue).to.equal('workspace');
            (0, chai_1.expect)(preferences.inspect(KEY)?.globalValue).to.equal(undefined);
        });
        it('update maps to updateValue (User scope)', async () => {
            await service.update(KEY, 'user');
            (0, chai_1.expect)(preferences.inspect(KEY)?.globalValue).to.equal('user');
        });
    });
    describe('onDidChange filtering', () => {
        beforeEach(() => createService(true));
        it('only fires for ai-features.* keys', async () => {
            const changes = [];
            service.onDidChange(change => changes.push(change));
            await service.set('editor.fontSize', 12, preferences_1.PreferenceScope.User);
            await service.set(KEY, true, preferences_1.PreferenceScope.User);
            (0, chai_1.expect)(changes.map(change => change.preferenceName)).to.deep.equal([KEY]);
        });
        it('affectsPreference matches the changed key on a keyed change, not unrelated keys', async () => {
            const changes = [];
            service.onDidChange(change => changes.push(change));
            await service.set(KEY, true, preferences_1.PreferenceScope.User);
            (0, chai_1.expect)(changes).to.have.lengthOf(1);
            (0, chai_1.expect)(changes[0].affectsPreference(KEY)).to.equal(true);
            (0, chai_1.expect)(changes[0].affectsPreference('ai-features.other')).to.equal(false);
        });
    });
});
//# sourceMappingURL=ai-configuration-service-impl.spec.js.map