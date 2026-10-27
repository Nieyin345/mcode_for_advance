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
const sinon = require("sinon");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_consent_provider_1 = require("../common/telemetry-consent-provider");
const telemetry_preferences_1 = require("../common/telemetry-preferences");
const recording_logger_1 = require("../common/test/recording-logger");
const telemetry_service_impl_1 = require("./telemetry-service-impl");
const telemetry_types_1 = require("../common/telemetry-types");
const telemetry_sink_1 = require("./telemetry-sink");
function createPreferences(initialFilters, ready = Promise.resolve()) {
    const emitter = new common_1.Emitter();
    let filters = initialFilters;
    return {
        [telemetry_preferences_1.TELEMETRY_LEVEL]: 'off',
        get [telemetry_preferences_1.TELEMETRY_FILTERS]() {
            return filters;
        },
        ready,
        onPreferenceChanged: emitter.event,
        setFilters: (newFilters) => {
            filters = newFilters;
            emitter.fire({ preferenceName: telemetry_preferences_1.TELEMETRY_FILTERS, affects: () => true });
        }
    };
}
function createSink(id, interests = ['*'], scope) {
    const events = [];
    return {
        id,
        interests,
        scope,
        events,
        handle: event => {
            events.push(event);
        }
    };
}
function createConsentProvider(level) {
    return { level, onDidChangeTelemetryLevel: new common_1.Emitter().event, ready: Promise.resolve() };
}
function createServiceWithPreferences(preferences, sinks, logger = new recording_logger_1.RecordingLogger(), level = 'all') {
    const provider = { getContributions: () => sinks };
    const container = new inversify_1.Container();
    container.bind(telemetry_consent_provider_1.TelemetryConsentProvider).toConstantValue(createConsentProvider(level));
    container.bind(telemetry_preferences_1.TelemetryPreferences).toConstantValue(preferences);
    container.bind(common_1.ContributionProvider).toConstantValue(provider).whenTargetNamed(telemetry_sink_1.TelemetrySink);
    container.bind(common_1.ILogger).toConstantValue(logger).whenTargetNamed('telemetry:TelemetryServiceImpl');
    container.bind(telemetry_service_impl_1.TelemetryServiceImpl).toSelf();
    return container.get(telemetry_service_impl_1.TelemetryServiceImpl);
}
function createService(level, filters, sinks, logger = new recording_logger_1.RecordingLogger()) {
    return createServiceWithPreferences(createPreferences(filters), sinks, logger, level);
}
async function flushDispatch() {
    await Promise.resolve();
    await Promise.resolve();
}
async function reportEvent(service, event = { topic: 'company/action', timestamp: 42 }) {
    service.notifyEvent({ kind: 'usage', session: 'frontend-session', ...event });
    await flushDispatch();
}
describe('TelemetryServiceImpl', () => {
    let clock;
    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: 1234 });
    });
    afterEach(() => clock.restore());
    it('treats undefined filters as no configured filters', async () => {
        const sink = createSink('company/sink');
        const preferences = createPreferences(undefined);
        await reportEvent(createServiceWithPreferences(preferences, [sink]));
        (0, chai_1.expect)(sink.events).to.have.length(1);
    });
    it('allows missing filters and treats an empty filter as disabling the sink', async () => {
        const allowed = createSink('company/allowed');
        const disabled = createSink('company/disabled');
        await reportEvent(createService('all', { 'company/disabled': [] }, [allowed, disabled]));
        (0, chai_1.expect)(allowed.events).to.have.length(1);
        (0, chai_1.expect)(disabled.events).to.be.empty;
    });
    it('gates remote sinks by level while local sinks bypass consent', async () => {
        const remote = createSink('company/remote');
        const local = createSink('company/local', ['*'], 'local');
        const service = createService('error', {}, [remote, local]);
        await reportEvent(service);
        await reportEvent(service, { topic: 'company/error', kind: 'error', timestamp: 43 });
        await reportEvent(service, { topic: 'company/crash', kind: 'crash', timestamp: 44 });
        (0, chai_1.expect)(remote.events.map(event => event.kind)).to.deep.equal(['error', 'crash']);
        (0, chai_1.expect)(local.events.map(event => event.kind)).to.deep.equal(['usage', 'error', 'crash']);
    });
    it('requires both the sink-specific filter and declared interest to match', async () => {
        const first = createSink('company/first', ['company/*']);
        const second = createSink('company/second', ['other/*']);
        const third = createSink('company/third', ['company/*']);
        const service = createService('all', {
            'company/first': ['company/action'],
            'company/second': ['*'],
            'company/third': ['other/*']
        }, [first, second, third]);
        await reportEvent(service);
        (0, chai_1.expect)(first.events).to.have.length(1);
        (0, chai_1.expect)(second.events).to.be.empty;
        (0, chai_1.expect)(third.events).to.be.empty;
    });
    it('supports exact, terminal wildcard, and global filter/interest intersections', async () => {
        const exact = createSink('company/exact', ['company/action']);
        const prefix = createSink('company/prefix', ['company/*']);
        const global = createSink('company/global', ['*']);
        const service = createService('all', {
            'company/exact': ['company/action'],
            'company/prefix': ['company/*'],
            'company/global': ['*']
        }, [exact, prefix, global]);
        await reportEvent(service);
        await reportEvent(service, { topic: 'company/action/deep', timestamp: 43 });
        await reportEvent(service, { topic: 'other/action', timestamp: 44 });
        (0, chai_1.expect)(exact.events.map(event => event.timestamp)).to.deep.equal([42]);
        (0, chai_1.expect)(prefix.events.map(event => event.timestamp)).to.deep.equal([42, 43]);
        (0, chai_1.expect)(global.events).to.have.length(3);
    });
    it('warns once per invalid filter until filters change', async () => {
        const sink = createSink('company/sink');
        const logger = new recording_logger_1.RecordingLogger();
        const preferences = createPreferences({ 'company/sink': ['company/**', '*/action', 'company/action'] });
        const service = createServiceWithPreferences(preferences, [sink], logger);
        await reportEvent(service, { topic: 'other/action', timestamp: 42 });
        await reportEvent(service);
        (0, chai_1.expect)(sink.events).to.have.length(1);
        (0, chai_1.expect)(logger.warnings).to.have.length(2);
        preferences.setFilters({ 'company/sink': ['invalid/**', '*'] });
        await reportEvent(service, { topic: 'other/action', timestamp: 43 });
        (0, chai_1.expect)(sink.events).to.have.length(2);
        (0, chai_1.expect)(logger.warnings).to.have.length(3);
    });
    it('rejects invalid and duplicate sink metadata', async () => {
        const invalidId = createSink('invalid');
        const emptyInterests = createSink('company/empty', []);
        const invalidInterests = createSink('company/interests', ['company/**']);
        const duplicateOne = createSink('company/duplicate');
        const duplicateTwo = createSink('company/duplicate');
        const valid = createSink('company/valid');
        const logger = new recording_logger_1.RecordingLogger();
        const service = createService('all', {
            'company/empty': ['*'],
            'company/interests': ['*'],
            'company/duplicate': ['*'],
            'company/valid': ['*']
        }, [invalidId, emptyInterests, invalidInterests, duplicateOne, duplicateTwo, valid], logger);
        await reportEvent(service);
        (0, chai_1.expect)(invalidId.events).to.be.empty;
        (0, chai_1.expect)(emptyInterests.events).to.be.empty;
        (0, chai_1.expect)(invalidInterests.events).to.be.empty;
        (0, chai_1.expect)(duplicateOne.events).to.be.empty;
        (0, chai_1.expect)(duplicateTwo.events).to.be.empty;
        (0, chai_1.expect)(valid.events).to.have.length(1);
        (0, chai_1.expect)(logger.errors).to.have.length(5);
    });
    it('returns the deduplicated interests of valid local sinks', async () => {
        const local = createSink('company/local', ['company/*', 'shared/*'], 'local');
        const secondLocal = createSink('company/second-local', ['shared/*', 'other/action'], 'local');
        const remote = createSink('company/remote', ['remote/*']);
        const invalid = createSink('invalid', ['invalid/*'], 'local');
        const logger = new recording_logger_1.RecordingLogger();
        const service = createService('off', {}, [local, secondLocal, remote, invalid], logger);
        (0, chai_1.expect)(await service.getLocalSinkInterests()).to.deep.equal(['company/*', 'shared/*', 'other/action']);
        (0, chai_1.expect)(logger.errors).to.have.length(1);
    });
    it('flushes valid sinks on stop and contains flush failures', async () => {
        const logger = new recording_logger_1.RecordingLogger();
        const flushed = [];
        const successful = createSink('company/successful');
        successful.flush = async () => { flushed.push(successful.id); };
        const throwing = createSink('company/throwing');
        throwing.flush = () => { throw new Error('payload-secret'); };
        const rejecting = createSink('company/rejecting');
        rejecting.flush = () => Promise.reject(new Error('payload-secret'));
        const withoutFlush = createSink('company/without-flush');
        const invalid = createSink('invalid');
        invalid.flush = async () => { flushed.push(invalid.id); };
        const service = createService('all', {}, [successful, throwing, rejecting, withoutFlush, invalid], logger);
        await service.onStop();
        (0, chai_1.expect)(flushed).to.deep.equal(['company/successful']);
        (0, chai_1.expect)(logger.errors).to.have.length(3);
        (0, chai_1.expect)(logger.errors.join(' ')).not.to.contain('payload-secret');
    });
    it('uses a snapshot of validated sink metadata', async () => {
        const sink = createSink('company/sink', ['company/action']);
        const service = createService('all', { 'company/sink': ['*'] }, [sink]);
        await reportEvent(service);
        sink.interests = ['other/*'];
        await reportEvent(service);
        await reportEvent(service, { topic: 'other/action', timestamp: 43 });
        (0, chai_1.expect)(sink.events.map(event => event.topic)).to.deep.equal(['company/action', 'company/action']);
    });
    it('dispatches queued events in FIFO order after preference readiness', async () => {
        let resolveReady;
        const ready = new Promise(resolve => resolveReady = resolve);
        const sink = createSink('company/sink');
        const service = createServiceWithPreferences(createPreferences({ 'company/sink': ['*'] }, ready), [sink]);
        service.report('company/first');
        service.report('company/second');
        service.report('company/third');
        (0, chai_1.expect)(sink.events).to.be.empty;
        resolveReady();
        await flushDispatch();
        (0, chai_1.expect)(sink.events.map(event => event.topic)).to.deep.equal(['company/first', 'company/second', 'company/third']);
    });
    it('bounds queued events, discards the oldest, preserves FIFO order, and warns once', async () => {
        let resolveReady;
        const ready = new Promise(resolve => resolveReady = resolve);
        const logger = new recording_logger_1.RecordingLogger();
        const sink = createSink('company/sink');
        const service = createServiceWithPreferences(createPreferences({}, ready), [sink], logger);
        for (let index = 0; index < 1_002; index++) {
            service.report(`company/${index}`);
        }
        (0, chai_1.expect)(logger.warnings).to.have.length(1);
        resolveReady();
        await flushDispatch();
        (0, chai_1.expect)(sink.events).to.have.length(1_000);
        (0, chai_1.expect)(sink.events.map(event => event.topic)).to.deep.equal(Array.from({ length: 1_000 }, (_, index) => `company/${index + 2}`));
        (0, chai_1.expect)(logger.warnings).to.have.length(1);
    });
    it('timestamps direct reports and snapshots payloads before deferred dispatch', async () => {
        let resolveReady;
        const ready = new Promise(resolve => resolveReady = resolve);
        const data = { action: 'open', durations: [1, 2], states: [true, false] };
        const attributes = { source: 'backend', labels: ['stable'] };
        const sink = createSink('company/sink');
        const service = createServiceWithPreferences(createPreferences({ 'company/sink': ['*'] }, ready), [sink]);
        service.report('company/action', data, { kind: 'error', attributes });
        data.action = 'changed';
        attributes.source = 'changed';
        attributes.labels.push('changed');
        data.durations.push(3);
        resolveReady();
        await flushDispatch();
        (0, chai_1.expect)(sink.events).to.have.length(1);
        (0, chai_1.expect)(sink.events[0].data).to.deep.equal({ action: 'open', durations: [1, 2], states: [true, false] });
        (0, chai_1.expect)(sink.events[0].data).not.to.equal(data);
        (0, chai_1.expect)(sink.events[0].kind).to.equal('error');
        (0, chai_1.expect)(sink.events[0].attributes).to.deep.equal({ source: 'backend', labels: ['stable'] });
        (0, chai_1.expect)(sink.events[0].session).to.equal(telemetry_types_1.BACKEND_TELEMETRY_SESSION);
        (0, chai_1.expect)(Object.isFrozen(sink.events[0])).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(sink.events[0].data)).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(sink.events[0].data?.durations)).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(sink.events[0].attributes)).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(sink.events[0].attributes?.labels)).to.be.true;
        (0, chai_1.expect)(sink.events[0].timestamp).to.equal(1234);
    });
    it('preserves RPC timestamps and isolates immutable payloads between sinks', async () => {
        const data = { action: 'open', durations: [1, 2] };
        const event = { topic: 'company/action', kind: 'error', data, attributes: { source: 'rpc', labels: ['stable'] }, session: 'rpc-session', timestamp: 987 };
        const observed = [];
        const mutating = {
            id: 'company/mutating',
            interests: ['*'],
            handle: received => {
                (0, chai_1.expect)(() => Object.assign(received.data, { action: 'changed' })).to.throw();
                (0, chai_1.expect)(() => received.data.durations.push(3)).to.throw();
                (0, chai_1.expect)(() => Object.assign(received.attributes, { source: 'changed' })).to.throw();
                (0, chai_1.expect)(() => received.attributes.labels.push('changed')).to.throw();
            }
        };
        const recording = {
            id: 'company/recording',
            interests: ['*'],
            handle: received => {
                observed.push(received);
            }
        };
        const service = createService('all', { 'company/mutating': ['*'], 'company/recording': ['*'] }, [mutating, recording]);
        await reportEvent(service, event);
        data.action = 'changed';
        data.durations.push(3);
        event.attributes.source = 'changed';
        event.attributes.labels.push('changed');
        (0, chai_1.expect)(observed[0].data).to.deep.equal({ action: 'open', durations: [1, 2] });
        (0, chai_1.expect)(observed[0].kind).to.equal('error');
        (0, chai_1.expect)(observed[0].attributes).to.deep.equal({ source: 'rpc', labels: ['stable'] });
        (0, chai_1.expect)(observed[0].session).to.equal('frontend/rpc-session');
        (0, chai_1.expect)(observed[0].timestamp).to.equal(987);
    });
    it('strips unknown top-level properties from RPC events', async () => {
        const sink = createSink('company/sink');
        const service = createService('all', {}, [sink]);
        service.notifyEvent({
            topic: 'company/action',
            kind: 'usage',
            session: 'frontend-session',
            timestamp: 42,
            unknown: 'value'
        });
        await flushDispatch();
        (0, chai_1.expect)(sink.events).to.have.length(1);
        (0, chai_1.expect)(Object.keys(sink.events[0])).to.deep.equal(['topic', 'kind', 'data', 'attributes', 'session', 'timestamp']);
    });
    it('drops malformed reports and RPC values without logging payload values', async () => {
        const sink = createSink('company/sink');
        const logger = new recording_logger_1.RecordingLogger();
        const service = createService('all', { 'company/sink': ['*'] }, [sink], logger);
        service.report('invalid', { secret: 'payload-secret' });
        service.report('company/action', { mixed: [1, 'payload-secret'] });
        service.report('company/action', undefined, { kind: 'invalid' });
        service.report('company/action', undefined, { attributes: { nested: { secret: 'payload-secret' } } });
        const validEnvelope = { topic: 'company/action', kind: 'usage', session: 'frontend-session', timestamp: 42 };
        service.notifyEvent({ ...validEnvelope, data: { nested: { secret: 'payload-secret' } } });
        service.notifyEvent({ ...validEnvelope, attributes: { nested: { secret: 'payload-secret' } } });
        service.notifyEvent({ ...validEnvelope, kind: 'invalid' });
        service.notifyEvent({ ...validEnvelope, session: '' });
        service.notifyEvent({ ...validEnvelope, timestamp: Number.POSITIVE_INFINITY });
        service.notifyEvent(undefined);
        service.notifyEvent('payload-secret');
        service.notifyEvent({ ...validEnvelope, topic: 42, data: 'payload-secret' });
        service.notifyEvent({ kind: 'usage', session: 'frontend-session', data: { secret: 'payload-secret' }, timestamp: 42 });
        await flushDispatch();
        (0, chai_1.expect)(sink.events).to.be.empty;
        (0, chai_1.expect)(logger.warnings).to.have.length(13);
        (0, chai_1.expect)(logger.warnings.join(' ')).not.to.contain('payload-secret');
    });
    it('dispatches synchronously after preference readiness', async () => {
        const sink = createSink('company/sink');
        const preferences = createPreferences({ 'company/sink': ['*'] });
        const service = createServiceWithPreferences(preferences, [sink]);
        await preferences.ready;
        await flushDispatch();
        service.report('company/action');
        (0, chai_1.expect)(sink.events).to.have.length(1);
    });
    it('delivers queued and subsequent events only to local sinks after preference readiness rejection and logs once', async () => {
        let rejectReady;
        const ready = new Promise((_resolve, reject) => rejectReady = reject);
        const logger = new recording_logger_1.RecordingLogger();
        const local = createSink('company/local', ['*'], 'local');
        const remote = createSink('company/remote');
        const preferences = createPreferences({ 'company/local': ['*'], 'company/remote': ['*'] }, ready);
        const service = createServiceWithPreferences(preferences, [local, remote], logger);
        service.report('company/first', { secret: 'first-secret' });
        service.report('company/second', { secret: 'second-secret' });
        rejectReady(new Error('readiness-secret'));
        await flushDispatch();
        service.report('company/third', { secret: 'third-secret' });
        (0, chai_1.expect)(local.events.map(event => event.topic)).to.deep.equal(['company/first', 'company/second', 'company/third']);
        (0, chai_1.expect)(remote.events).to.be.empty;
        (0, chai_1.expect)(logger.errors).to.have.length(1);
        (0, chai_1.expect)(logger.errors.join(' ')).not.to.contain('secret');
    });
    it('uses the same policy path for direct and RPC reports', async () => {
        const sink = createSink('company/sink', ['company/*']);
        const service = createService('all', { 'company/sink': ['company/*'] }, [sink]);
        service.report('company/direct');
        service.notifyEvent({ topic: 'company/rpc', kind: 'crash', session: 'rpc-session', timestamp: 99 });
        await flushDispatch();
        (0, chai_1.expect)(sink.events.map(event => event.topic)).to.deep.equal(['company/direct', 'company/rpc']);
        (0, chai_1.expect)(sink.events.map(event => event.timestamp)).to.deep.equal([1234, 99]);
        (0, chai_1.expect)(sink.events.map(event => event.kind)).to.deep.equal(['usage', 'crash']);
        (0, chai_1.expect)(sink.events.map(event => event.session)).to.deep.equal([telemetry_types_1.BACKEND_TELEMETRY_SESSION, 'frontend/rpc-session']);
    });
    it('prevents RPC events from impersonating the backend session', async () => {
        const sink = createSink('company/sink');
        const service = createService('all', {}, [sink]);
        service.notifyEvent({
            topic: 'company/rpc',
            kind: 'usage',
            session: telemetry_types_1.BACKEND_TELEMETRY_SESSION,
            timestamp: 99
        });
        await flushDispatch();
        (0, chai_1.expect)(sink.events).to.have.length(1);
        (0, chai_1.expect)(sink.events[0].session).to.equal(`frontend/${telemetry_types_1.BACKEND_TELEMETRY_SESSION}`);
        (0, chai_1.expect)(sink.events[0].session).not.to.equal(telemetry_types_1.BACKEND_TELEMETRY_SESSION);
    });
    it('isolates void handlers, synchronous throws, asynchronous rejections, and slow sinks', async () => {
        const logger = new recording_logger_1.RecordingLogger();
        const successful = createSink('company/successful');
        const throwing = {
            id: 'company/throwing', interests: ['*'], handle: () => { throw new Error('payload-secret'); }
        };
        const rejecting = {
            id: 'company/rejecting', interests: ['*'], handle: () => Promise.reject(new Error('payload-secret'))
        };
        const slow = {
            id: 'company/slow', interests: ['*'], handle: () => new Promise(() => undefined)
        };
        const filters = Object.fromEntries([successful, throwing, rejecting, slow].map(sink => [sink.id, ['*']]));
        await reportEvent(createService('all', filters, [throwing, slow, successful, rejecting], logger));
        await Promise.resolve();
        (0, chai_1.expect)(successful.events).to.have.length(1);
        (0, chai_1.expect)(logger.errors).to.have.length(2);
        (0, chai_1.expect)(logger.errors.join(' ')).not.to.contain('payload-secret');
    });
});
//# sourceMappingURL=telemetry-service-impl.spec.js.map