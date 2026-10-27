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
disableJSDOM();
class StubPreferenceService {
    get(_preferenceName, fallback, _resourceUri) {
        return (this.effectiveValue ?? fallback);
    }
    inspect(_preferenceName, _resourceUri) {
        return this.inspectResult;
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
const PREFERENCE_NAME = 'some.preference';
describe('TrustAwarePreferenceReader', () => {
    let preferences;
    let trust;
    let reader;
    beforeEach(() => {
        preferences = new StubPreferenceService();
        trust = new StubWorkspaceTrustService();
        const container = new inversify_1.Container();
        container.bind(preferences_1.PreferenceService).toConstantValue(preferences);
        container.bind(workspace_trust_service_1.WorkspaceTrustService).toConstantValue(trust);
        container.bind(trust_aware_preference_reader_1.TrustAwarePreferenceReader).toSelf().inSingletonScope();
        reader = container.get(trust_aware_preference_reader_1.TrustAwarePreferenceReader);
    });
    describe('fail-closed default', () => {
        it('returns only user/default/fallback before ready resolves', () => {
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                globalValue: 'user',
                workspaceValue: 'workspace'
            };
            const value = reader.get(PREFERENCE_NAME, 'fallback');
            (0, chai_1.expect)(value).to.equal('user');
        });
        it('returns defaultValue when only workspace value exists before ready', () => {
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                workspaceValue: 'workspace'
            };
            const value = reader.get(PREFERENCE_NAME, 'fallback');
            (0, chai_1.expect)(value).to.equal('default');
        });
        it('returns fallback when nothing is set before ready', () => {
            preferences.effectiveValue = undefined;
            preferences.inspectResult = {};
            const value = reader.get(PREFERENCE_NAME, 'fallback');
            (0, chai_1.expect)(value).to.equal('fallback');
        });
    });
    describe('after ready resolves with trusted = true', () => {
        beforeEach(async () => {
            trust.trustDeferred.resolve(true);
            await reader.ready;
        });
        it('delegates to preferences.get and returns the workspace value', () => {
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                globalValue: 'user',
                workspaceValue: 'workspace'
            };
            const value = reader.get(PREFERENCE_NAME, 'fallback');
            (0, chai_1.expect)(value).to.equal('workspace');
        });
    });
    describe('after ready resolves with trusted = false', () => {
        beforeEach(async () => {
            trust.trustDeferred.resolve(false);
            await reader.ready;
        });
        it('returns globalValue when both global and workspace values exist', () => {
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                globalValue: 'user',
                workspaceValue: 'workspace'
            };
            const value = reader.get(PREFERENCE_NAME, 'fallback');
            (0, chai_1.expect)(value).to.equal('user');
        });
        it('falls back to defaultValue when only workspace value exists', () => {
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                workspaceValue: 'workspace'
            };
            const value = reader.get(PREFERENCE_NAME, 'fallback');
            (0, chai_1.expect)(value).to.equal('default');
        });
        it('returns the supplied fallback when nothing is set', () => {
            preferences.effectiveValue = undefined;
            preferences.inspectResult = {};
            const value = reader.get(PREFERENCE_NAME, 'fallback');
            (0, chai_1.expect)(value).to.equal('fallback');
        });
    });
    describe('suppressUntrusted', () => {
        const inspection = {
            preferenceName: PREFERENCE_NAME,
            defaultValue: 'default',
            globalValue: 'user',
            workspaceValue: 'workspace',
            workspaceFolderValue: 'folder',
            value: 'folder'
        };
        it('clears the workspace and folder values when untrusted', async () => {
            trust.trustDeferred.resolve(false);
            await reader.ready;
            const result = reader.suppressUntrusted({ ...inspection });
            (0, chai_1.expect)(result.workspaceValue).to.equal(undefined);
            (0, chai_1.expect)(result.workspaceFolderValue).to.equal(undefined);
            (0, chai_1.expect)(result.globalValue).to.equal('user');
            (0, chai_1.expect)(result.defaultValue).to.equal('default');
        });
        it('returns the inspection unchanged when trusted', async () => {
            trust.trustDeferred.resolve(true);
            await reader.ready;
            const result = reader.suppressUntrusted({ ...inspection });
            (0, chai_1.expect)(result.workspaceValue).to.equal('workspace');
            (0, chai_1.expect)(result.workspaceFolderValue).to.equal('folder');
        });
    });
    describe('onDidChangeTrust', () => {
        beforeEach(async () => {
            trust.trustDeferred.resolve(false);
            await reader.ready;
        });
        it('fires with the new value when the underlying service emits a change', () => {
            const received = [];
            reader.onDidChangeTrust(value => received.push(value));
            trust.fireTrustChange(true);
            (0, chai_1.expect)(received).to.deep.equal([true]);
        });
        it('does not fire when the value is unchanged', () => {
            const received = [];
            reader.onDidChangeTrust(value => received.push(value));
            trust.fireTrustChange(false);
            (0, chai_1.expect)(received).to.deep.equal([]);
        });
        it('has updated the cached trusted flag by the time listeners run', () => {
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                globalValue: 'user',
                workspaceValue: 'workspace'
            };
            let observedDuringListener;
            reader.onDidChangeTrust(() => {
                observedDuringListener = reader.get(PREFERENCE_NAME, 'fallback');
            });
            trust.fireTrustChange(true);
            (0, chai_1.expect)(observedDuringListener).to.equal('workspace');
        });
    });
    describe('ready', () => {
        it('does not resolve until the initial getWorkspaceTrust promise resolves', async () => {
            let resolved = false;
            reader.ready.then(() => { resolved = true; });
            // Allow microtasks to settle without resolving the deferred.
            await Promise.resolve();
            (0, chai_1.expect)(resolved).to.equal(false);
            trust.trustDeferred.resolve(true);
            await reader.ready;
            (0, chai_1.expect)(resolved).to.equal(true);
        });
        it('resolves via an early change event when it arrives before the initial promise', async () => {
            const received = [];
            reader.onDidChangeTrust(value => received.push(value));
            trust.fireTrustChange(true);
            await reader.ready;
            // The first signal acts as the initial resolution and must not
            // be reported as a change event.
            (0, chai_1.expect)(received).to.deep.equal([]);
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                globalValue: 'user',
                workspaceValue: 'workspace'
            };
            (0, chai_1.expect)(reader.get(PREFERENCE_NAME, 'fallback')).to.equal('workspace');
        });
    });
    describe('race between initial promise and change event', () => {
        it('ignores a stale getWorkspaceTrust resolution after a change event has initialised the reader', async () => {
            const received = [];
            reader.onDidChangeTrust(value => received.push(value));
            // Change event arrives first and initialises the reader.
            trust.fireTrustChange(false);
            // The (now stale) initial promise resolves to a different value.
            trust.trustDeferred.resolve(true);
            await reader.ready;
            // Allow the stale .then callback to run.
            await Promise.resolve();
            await Promise.resolve();
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                globalValue: 'user',
                workspaceValue: 'workspace'
            };
            // Cached trust must still reflect the change event (false), not
            // the stale promise resolution (true).
            (0, chai_1.expect)(reader.get(PREFERENCE_NAME, 'fallback')).to.equal('user');
            // No change event should have been fired for the initial value
            // and none for the stale resolution either.
            (0, chai_1.expect)(received).to.deep.equal([]);
        });
        it('ignores a stale getWorkspaceTrust rejection after a change event has initialised the reader', async () => {
            const received = [];
            reader.onDidChangeTrust(value => received.push(value));
            // Avoid an unhandled rejection warning for the (now stale) initial promise.
            trust.getWorkspaceTrust().catch(() => { });
            // Change event arrives first and initialises the reader.
            trust.fireTrustChange(true);
            // The (now stale) initial promise rejects.
            trust.trustDeferred.reject(new Error('stale failure'));
            // ready must resolve (not reject) because the event already initialised it.
            await reader.ready;
            // Allow the stale rejection callback to run.
            await Promise.resolve();
            await Promise.resolve();
            preferences.effectiveValue = 'workspace';
            preferences.inspectResult = {
                defaultValue: 'default',
                globalValue: 'user',
                workspaceValue: 'workspace'
            };
            // Cached trust must reflect the change event (true).
            (0, chai_1.expect)(reader.get(PREFERENCE_NAME, 'fallback')).to.equal('workspace');
            // No change event should have been fired for the initial value.
            (0, chai_1.expect)(received).to.deep.equal([]);
        });
    });
});
//# sourceMappingURL=trust-aware-preference-reader.spec.js.map