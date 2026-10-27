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
const sinon = require("sinon");
const promise_util_1 = require("../promise-util");
const stopwatch_1 = require("./stopwatch");
const simple_stopwatch_1 = require("./simple-stopwatch");
/**
 * A fake {@link Measurement} whose log methods are sinon spies, with a
 * configurable duration returned by {@link stop}.
 */
class FakeMeasurement {
    constructor(name, duration = 0) {
        this.log = sinon.spy();
        this.info = sinon.spy();
        this.debug = sinon.spy();
        this.warn = sinon.spy();
        this.error = sinon.spy();
        this.stop = sinon.spy(() => {
            if (this.elapsed === undefined) {
                this.elapsed = this.duration;
            }
            return this.elapsed;
        });
        this.name = name;
        this.duration = duration;
    }
}
/**
 * A fake {@link Stopwatch} that creates {@link FakeMeasurement}s with
 * configurable durations and records all invocations of {@link start}.
 */
class FakeStopwatch extends simple_stopwatch_1.SimpleStopwatch {
    constructor() {
        super('test', () => 0);
        this.defaultDuration = 0;
        this.durationByName = new Map();
        this.created = [];
        this.start = sinon.spy((name, _options) => {
            const duration = this.durationByName.get(name) ?? this.defaultDuration;
            const measurement = new FakeMeasurement(name, duration);
            this.created.push(measurement);
            return measurement;
        });
    }
    /** Return the first measurement created with the given name, or `undefined`. */
    measurementFor(name) {
        return this.created.find(m => m.name === name);
    }
}
class TestContribution {
}
class OtherTestContribution {
}
/**
 * Allow any already-queued microtasks (such as `.then` callbacks attached to
 * already-settled promises) to run before assertions.
 */
async function flushPromises() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}
describe('MeasurementContext', () => {
    let stopwatch;
    beforeEach(() => {
        stopwatch = new FakeStopwatch();
    });
    describe('ensureEntry', () => {
        it('starts a per-contribution measurement', () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 250);
            context.ensureEntry(new TestContribution());
            sinon.assert.calledWith(stopwatch.start, 'TestContribution.settled', sinon.match({ thresholdMillis: 250 }));
        });
        it('starts a per-contribution measurement only once per item', () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            context.ensureEntry(item);
            context.ensureEntry(item);
            const started = stopwatch.start.getCalls().filter(c => c.args[0] === 'TestContribution.settled');
            (0, chai_1.expect)(started).to.have.length(1);
        });
        it('starts independent measurements for distinct items', () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            context.ensureEntry(new TestContribution());
            context.ensureEntry(new TestContribution());
            const started = stopwatch.start.getCalls().filter(c => c.args[0] === 'TestContribution.settled');
            (0, chai_1.expect)(started).to.have.length(2);
        });
    });
    describe('trackSettlement', () => {
        it('is a no-op for a synchronous result', async () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            context.trackSettlement(item, undefined);
            context.armAllSettled();
            await flushPromises();
            const perContribution = stopwatch.measurementFor('TestContribution.settled');
            sinon.assert.notCalled(perContribution.debug);
            sinon.assert.notCalled(perContribution.warn);
            sinon.assert.notCalled(perContribution.info);
            // Synchronous results do not increment allSettledPending, so arming fires the
            // aggregate message immediately.
            const allSettled = stopwatch.measurementFor('frontend-all-settled');
            sinon.assert.calledOnce(allSettled.info);
        });
        it('does not log a per-contribution settlement when only one promise was tracked', async () => {
            // The single lifecycle measurement already describes the duration of a solo tracked
            // promise, so the per-contribution aggregate must stay silent.
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            context.trackSettlement(item, Promise.resolve());
            context.armAllSettled();
            await flushPromises();
            const perContribution = stopwatch.measurementFor('TestContribution.settled');
            sinon.assert.notCalled(perContribution.debug);
            sinon.assert.notCalled(perContribution.warn);
            sinon.assert.notCalled(perContribution.info);
        });
        it('logs a debug settlement message once multiple tracked promises all resolve under the threshold', async () => {
            stopwatch.durationByName.set('TestContribution.settled', 50);
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            const first = new promise_util_1.Deferred();
            const second = new promise_util_1.Deferred();
            context.trackSettlement(item, first.promise);
            context.trackSettlement(item, second.promise);
            // Before any promise resolves, nothing has been logged.
            const perContribution = stopwatch.measurementFor('TestContribution.settled');
            sinon.assert.notCalled(perContribution.debug);
            first.resolve();
            await flushPromises();
            sinon.assert.notCalled(perContribution.debug);
            second.resolve();
            await flushPromises();
            sinon.assert.calledOnceWithExactly(perContribution.debug, 'Frontend TestContribution settled');
            sinon.assert.notCalled(perContribution.warn);
        });
        it('logs a warn settlement message when multiple tracked promises exceed the threshold', async () => {
            stopwatch.durationByName.set('TestContribution.settled', 500);
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            context.trackSettlement(item, Promise.resolve());
            context.trackSettlement(item, Promise.resolve());
            await flushPromises();
            const perContribution = stopwatch.measurementFor('TestContribution.settled');
            sinon.assert.calledOnceWithExactly(perContribution.warn, 'Frontend TestContribution took longer than expected to settle');
            sinon.assert.notCalled(perContribution.debug);
        });
        it('treats a rejected promise as settled', async () => {
            stopwatch.durationByName.set('TestContribution.settled', 10);
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            const rejecting = new promise_util_1.Deferred();
            context.trackSettlement(item, Promise.resolve());
            context.trackSettlement(item, rejecting.promise);
            rejecting.reject(new Error('expected failure'));
            await flushPromises();
            const perContribution = stopwatch.measurementFor('TestContribution.settled');
            sinon.assert.calledOnce(perContribution.debug);
        });
        it('tracks promises independently for each contribution', async () => {
            stopwatch.durationByName.set('TestContribution.settled', 50);
            stopwatch.durationByName.set('OtherTestContribution.settled', 50);
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const a = new TestContribution();
            const b = new OtherTestContribution();
            context.ensureEntry(a);
            context.ensureEntry(b);
            context.trackSettlement(a, Promise.resolve());
            context.trackSettlement(a, Promise.resolve());
            context.trackSettlement(b, Promise.resolve());
            await flushPromises();
            // a had two tracked promises: logs once.
            sinon.assert.calledOnce(stopwatch.measurementFor('TestContribution.settled').debug);
            // b had a single tracked promise: logs nothing.
            sinon.assert.notCalled(stopwatch.measurementFor('OtherTestContribution.settled').debug);
        });
    });
    describe('armAllSettled', () => {
        it('logs the aggregate message immediately when armed with zero pending promises', () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            context.armAllSettled();
            const allSettled = stopwatch.measurementFor('frontend-all-settled');
            sinon.assert.calledOnceWithExactly(allSettled.info, 'All frontend contributions settled');
        });
        it('defers the aggregate log until the last tracked promise settles', async () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            const pending = new promise_util_1.Deferred();
            context.trackSettlement(item, pending.promise);
            context.armAllSettled();
            const allSettled = stopwatch.measurementFor('frontend-all-settled');
            sinon.assert.notCalled(allSettled.info);
            pending.resolve();
            await flushPromises();
            sinon.assert.calledOnce(allSettled.info);
        });
        it('does not log the aggregate message when all promises settle before arming', async () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            context.trackSettlement(item, Promise.resolve());
            await flushPromises();
            const allSettled = stopwatch.measurementFor('frontend-all-settled');
            sinon.assert.notCalled(allSettled.info);
        });
        it('logs the aggregate message when arming after all tracked promises have already settled', async () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const item = new TestContribution();
            context.ensureEntry(item);
            context.trackSettlement(item, Promise.resolve());
            await flushPromises();
            const allSettled = stopwatch.measurementFor('frontend-all-settled');
            sinon.assert.notCalled(allSettled.info);
            context.armAllSettled();
            sinon.assert.calledOnce(allSettled.info);
        });
        it('logs the aggregate message exactly once when multiple contributions finish', async () => {
            const context = new stopwatch_1.MeasurementContext(stopwatch, 'Frontend', 100);
            const a = new TestContribution();
            const b = new OtherTestContribution();
            context.ensureEntry(a);
            context.ensureEntry(b);
            context.trackSettlement(a, Promise.resolve());
            context.trackSettlement(b, Promise.resolve());
            context.armAllSettled();
            await flushPromises();
            const allSettled = stopwatch.measurementFor('frontend-all-settled');
            sinon.assert.calledOnce(allSettled.info);
        });
    });
});
//# sourceMappingURL=stopwatch.spec.js.map