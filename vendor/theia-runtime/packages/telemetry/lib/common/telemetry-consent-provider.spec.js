"use strict";
// *****************************************************************************
// Copyright (C) 2026 STMicroelectronics and others.
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
const chai_1 = require("chai");
const common_1 = require("@theia/core/lib/common");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_consent_provider_1 = require("./telemetry-consent-provider");
const telemetry_preferences_1 = require("./telemetry-preferences");
describe('telemetry consent provider', () => {
    function createPreferences(ready, level, changes) {
        return {
            get [telemetry_preferences_1.TELEMETRY_LEVEL]() {
                return level();
            },
            [telemetry_preferences_1.TELEMETRY_FILTERS]: {},
            ready,
            onPreferenceChanged: changes.event
        };
    }
    function createProvider(preferences) {
        const container = new inversify_1.Container();
        container.bind(telemetry_preferences_1.TelemetryPreferences).toConstantValue(preferences);
        container.bind(telemetry_consent_provider_1.TelemetryConsentProvider).to(telemetry_consent_provider_1.PreferenceTelemetryConsentProvider).inSingletonScope();
        return container.get(telemetry_consent_provider_1.TelemetryConsentProvider);
    }
    it('applies and reports preference changes before readiness', () => {
        const changes = new common_1.Emitter();
        let level = 'off';
        const provider = createProvider(createPreferences(new Promise(() => undefined), () => level, changes));
        const observed = [];
        provider.onDidChangeTelemetryLevel(value => observed.push(value));
        level = 'error';
        changes.fire({ preferenceName: telemetry_preferences_1.TELEMETRY_LEVEL });
        (0, chai_1.expect)(provider.level).to.equal('error');
        (0, chai_1.expect)(observed).to.deep.equal(['error']);
    });
    it('starts off, then reads the preference after readiness and fires on changes', async () => {
        const changes = new common_1.Emitter();
        let resolveReady;
        let level = 'error';
        const provider = createProvider(createPreferences(new Promise(resolve => resolveReady = resolve), () => level, changes));
        const observed = [];
        provider.onDidChangeTelemetryLevel(value => observed.push(value));
        (0, chai_1.expect)(provider.level).to.equal('off');
        resolveReady();
        await provider.ready;
        (0, chai_1.expect)(provider.level).to.equal('error');
        level = 'all';
        changes.fire({ preferenceName: telemetry_preferences_1.TELEMETRY_LEVEL });
        (0, chai_1.expect)(provider.level).to.equal('all');
        (0, chai_1.expect)(observed).to.deep.equal(['error', 'all']);
    });
    it('settles ready with the level left at its default when reading the preferences fails', async () => {
        const provider = createProvider(createPreferences(Promise.reject(new Error('no preferences')), () => 'all', new common_1.Emitter()));
        await provider.ready;
        (0, chai_1.expect)(provider.level).to.equal('off');
    });
});
//# sourceMappingURL=telemetry-consent-provider.spec.js.map