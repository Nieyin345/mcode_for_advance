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
const frontend_id_provider_1 = require("@theia/core/lib/browser/messaging/frontend-id-provider");
const common_1 = require("@theia/core/lib/common");
const sinon = require("sinon");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_consent_provider_1 = require("../common/telemetry-consent-provider");
const telemetry_protocol_1 = require("../common/telemetry-protocol");
const recording_logger_1 = require("../common/test/recording-logger");
const browser_telemetry_service_1 = require("./browser-telemetry-service");
const FRONTEND_ID = 'test-frontend-id';
function createConsentProvider(initialLevel) {
    const emitter = new common_1.Emitter();
    let level = initialLevel;
    return {
        get level() {
            return level;
        },
        onDidChangeTelemetryLevel: emitter.event,
        ready: Promise.resolve(),
        setLevel: newLevel => {
            level = newLevel;
            emitter.fire(level);
        }
    };
}
function createRpc(events, localSinkInterests = Promise.resolve([])) {
    return {
        notifyEvent: event => { events.push(event); },
        getLocalSinkInterests: () => localSinkInterests
    };
}
function createService(rpc, consentProvider, logger = new recording_logger_1.RecordingLogger()) {
    const container = new inversify_1.Container();
    container.bind(telemetry_protocol_1.TelemetryRpc).toConstantValue(rpc);
    container.bind(frontend_id_provider_1.FrontendIdProvider).toConstantValue({ getId: () => FRONTEND_ID });
    container.bind(telemetry_consent_provider_1.TelemetryConsentProvider).toConstantValue(consentProvider);
    container.bind(common_1.ILogger).toConstantValue(logger).whenTargetNamed('telemetry:BrowserTelemetryService');
    container.bind(browser_telemetry_service_1.BrowserTelemetryService).toSelf();
    return container.get(browser_telemetry_service_1.BrowserTelemetryService);
}
describe('BrowserTelemetryService', () => {
    let clock;
    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: 1234 });
    });
    afterEach(() => clock.restore());
    it('assigns report-time timestamps and forwards valid events when allowed', () => {
        const events = [];
        const service = createService(createRpc(events), createConsentProvider('all'));
        service.report('company/action', { enabled: true });
        clock.tick(10);
        service.report('company/other', { count: 3 });
        (0, chai_1.expect)(events).to.have.length(2);
        (0, chai_1.expect)(events[0]).to.deep.include({ topic: 'company/action', kind: 'usage', data: { enabled: true }, timestamp: 1234 });
        (0, chai_1.expect)(events[1]).to.deep.include({ topic: 'company/other', kind: 'usage', data: { count: 3 }, timestamp: 1244 });
        (0, chai_1.expect)(events.map(event => event.session)).to.deep.equal([FRONTEND_ID, FRONTEND_ID]);
    });
    it('forwards optimistically until local interests are ready, then applies consent and local interests', async () => {
        const events = [];
        let resolveInterests;
        const interests = new Promise(resolve => resolveInterests = resolve);
        const consentProvider = createConsentProvider('off');
        const service = createService(createRpc(events, interests), consentProvider);
        service.report('company/optimistic');
        resolveInterests(['company/local/*']);
        await interests;
        await Promise.resolve();
        service.report('company/remote');
        service.report('company/local/action');
        consentProvider.setLevel('all');
        service.report('company/enabled');
        (0, chai_1.expect)(events.map(event => event.topic)).to.deep.equal(['company/optimistic', 'company/local/action', 'company/enabled']);
    });
    it('fetches local interests once and treats RPC failure as no local interests', async () => {
        const events = [];
        const rpc = createRpc(events, Promise.reject(new Error('connection failed')));
        const getLocalSinkInterests = sinon.spy(rpc, 'getLocalSinkInterests');
        const service = createService(rpc, createConsentProvider('off'));
        service.report('company/optimistic');
        await Promise.resolve();
        await Promise.resolve();
        service.report('company/dropped');
        (0, chai_1.expect)(getLocalSinkInterests.calledOnce).to.be.true;
        (0, chai_1.expect)(events.map(event => event.topic)).to.deep.equal(['company/optimistic']);
    });
    it('forwards immutable snapshots of data and attributes with report options', () => {
        const events = [];
        const service = createService(createRpc(events), createConsentProvider('all'));
        const data = {
            text: 'value',
            count: 3,
            enabled: true,
            strings: ['first', 'second'],
            numbers: [1, 2],
            booleans: [true, false],
            empty: []
        };
        const attributes = { source: 'browser', labels: ['stable'] };
        service.report('company/action', data, { kind: 'error', attributes });
        (0, chai_1.expect)(events).to.have.length(1);
        (0, chai_1.expect)(events[0].kind).to.equal('error');
        (0, chai_1.expect)(events[0].session).to.equal(FRONTEND_ID);
        (0, chai_1.expect)(events[0].data).to.deep.equal(data);
        (0, chai_1.expect)(events[0].attributes).to.deep.equal(attributes);
        (0, chai_1.expect)(events[0].attributes).not.to.equal(attributes);
        (0, chai_1.expect)(events[0].attributes?.labels).not.to.equal(attributes.labels);
        (0, chai_1.expect)(events[0].data).not.to.equal(data);
        (0, chai_1.expect)(events[0].data?.strings).not.to.equal(data.strings);
        (0, chai_1.expect)(events[0].data?.numbers).not.to.equal(data.numbers);
        (0, chai_1.expect)(events[0].data?.booleans).not.to.equal(data.booleans);
        (0, chai_1.expect)(events[0].data?.empty).not.to.equal(data.empty);
        (0, chai_1.expect)(Object.isFrozen(events[0])).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(events[0].data)).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(events[0].data?.strings)).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(events[0].attributes)).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(events[0].attributes?.labels)).to.be.true;
        data.text = 'changed';
        attributes.source = 'changed';
        attributes.labels.push('changed');
        data.strings.push('changed');
        (0, chai_1.expect)(events[0].data?.text).to.equal('value');
        (0, chai_1.expect)(events[0].data?.strings).to.deep.equal(['first', 'second']);
        (0, chai_1.expect)(events[0].attributes).to.deep.equal({ source: 'browser', labels: ['stable'] });
    });
    it('does not forward invalid topics or payloads', () => {
        const events = [];
        const logger = new recording_logger_1.RecordingLogger();
        const service = createService(createRpc(events), createConsentProvider('all'), logger);
        const sparse = new Array(2);
        sparse[1] = 'value';
        const invalidCases = [
            ['invalid', { value: true }],
            ['company/action', ['value']],
            ['company/action', { values: ['value', 1] }],
            ['company/action', { values: [['value']] }],
            ['company/action', { values: sparse }]
        ];
        for (const [topic, data] of invalidCases) {
            service.report(topic, data);
        }
        service.report('company/action', undefined, { kind: 'invalid' });
        service.report('company/action', undefined, { attributes: { nested: {} } });
        (0, chai_1.expect)(events).to.be.empty;
        (0, chai_1.expect)(logger.warnings).to.have.length(invalidCases.length + 2);
    });
});
//# sourceMappingURL=browser-telemetry-service.spec.js.map