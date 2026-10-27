"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
const event_1 = require("@theia/core/lib/common/event");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_consent_provider_1 = require("@theia/telemetry/lib/common/telemetry-consent-provider");
const telemetry_main_1 = require("./telemetry-main");
describe('TelemetryMainImpl', () => {
    let level;
    let pushed;
    let levelChanged;
    let container;
    let rpc;
    beforeEach(() => {
        level = 'off';
        pushed = [];
        levelChanged = new event_1.Emitter();
        container = new inversify_1.Container();
        container.bind(telemetry_consent_provider_1.TelemetryConsentProvider).toConstantValue({
            get level() { return level; },
            onDidChangeTelemetryLevel: levelChanged.event,
            ready: Promise.resolve()
        });
        rpc = {
            getProxy(_proxyId) {
                return {
                    $onDidChangeTelemetryLevel: (next) => { pushed.push(next); }
                };
            },
            set: (_identifier, instance) => instance,
            dispose: () => { }
        };
    });
    it('does not push a level on construction, the initial level is seeded through $init', () => {
        new telemetry_main_1.TelemetryMainImpl(rpc, container);
        (0, chai_1.expect)(pushed).to.be.empty;
    });
    it('pushes every level change to the plugin host', () => {
        new telemetry_main_1.TelemetryMainImpl(rpc, container);
        levelChanged.fire('all');
        levelChanged.fire('error');
        (0, chai_1.expect)(pushed).to.deep.equal(['all', 'error']);
    });
    it('stops pushing once disposed', () => {
        const telemetryMain = new telemetry_main_1.TelemetryMainImpl(rpc, container);
        telemetryMain.dispose();
        levelChanged.fire('all');
        (0, chai_1.expect)(pushed).to.be.empty;
    });
});
//# sourceMappingURL=telemetry-main.spec.js.map