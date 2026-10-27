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
const uri_1 = require("@theia/core/lib/common/uri");
const telemetry_protocol_1 = require("./telemetry-protocol");
const telemetry_service_1 = require("./telemetry-service");
const typedPayload = {
    action: 'open',
    duration: 12,
    successful: true,
    tags: ['editor', 'open'],
    measurements: [4, 8],
    states: [true, false]
};
const compileTimeUsage = (service) => service.report('consumer/action', typedPayload, {
    kind: 'error',
    attributes: { source: 'consumer' }
});
describe('telemetry service contract', () => {
    it('supports consumer-defined payload interfaces without an index signature', () => {
        (0, chai_1.expect)(compileTimeUsage).to.be.a('function');
    });
    it('validates event kind, attributes, and session', () => {
        const event = {
            topic: 'consumer/action',
            kind: 'error',
            data: typedPayload,
            attributes: { source: 'consumer' },
            session: 'frontend-session',
            timestamp: 42
        };
        (0, chai_1.expect)((0, telemetry_protocol_1.isValidTelemetryEvent)(event)).to.be.true;
        (0, chai_1.expect)((0, telemetry_protocol_1.isValidTelemetryEvent)({ ...event, kind: 'invalid' })).to.be.false;
        (0, chai_1.expect)((0, telemetry_protocol_1.isValidTelemetryEvent)({ ...event, session: '' })).to.be.false;
        (0, chai_1.expect)((0, telemetry_protocol_1.isValidTelemetryEvent)({ ...event, attributes: { nested: {} } })).to.be.false;
    });
    it('accepts plain flat payloads with primitive telemetry values', () => {
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(typedPayload)).to.be.true;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({})).to.be.true;
    });
    it('accepts homogeneous primitive and empty arrays unchanged', () => {
        const strings = ['editor', 'open'];
        const numbers = [4, 8];
        const booleans = [true, false];
        const empty = [];
        const data = { strings, numbers, booleans, empty };
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(data)).to.be.true;
        (0, chai_1.expect)(data.strings).to.equal(strings);
        (0, chai_1.expect)(data.numbers).to.equal(numbers);
        (0, chai_1.expect)(data.booleans).to.equal(booleans);
        (0, chai_1.expect)(data.empty).to.equal(empty);
    });
    it('creates immutable snapshots without transforming accepted values', () => {
        const strings = ['editor', 'open'];
        const data = { action: 'open', duration: 12, successful: true, strings };
        const snapshot = (0, telemetry_service_1.snapshotTelemetryData)(data);
        (0, chai_1.expect)(snapshot).to.deep.equal(data);
        (0, chai_1.expect)(snapshot).not.to.equal(data);
        (0, chai_1.expect)(snapshot?.strings).not.to.equal(strings);
        (0, chai_1.expect)(Object.isFrozen(snapshot)).to.be.true;
        (0, chai_1.expect)(Object.isFrozen(snapshot?.strings)).to.be.true;
        (0, chai_1.expect)((0, telemetry_service_1.snapshotTelemetryData)(undefined)).to.be.undefined;
    });
    it('rejects non-object payloads', () => {
        for (const value of [undefined, 'value', 1, true]) {
            (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(value)).to.be.false;
        }
        // eslint-disable-next-line no-null/no-null
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(null)).to.be.false;
    });
    it('rejects top-level arrays and nested objects', () => {
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)([])).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: { nested: true } })).to.be.false;
    });
    it('rejects mixed, nested, and sparse arrays', () => {
        const sparse = new Array(2);
        sparse[1] = 'value';
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: ['value', 1] })).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: [['nested']] })).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: sparse })).to.be.false;
    });
    it('rejects unsupported array elements', () => {
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: [{ nested: true }] })).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: ['value', undefined] })).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: ['value', () => 'value'] })).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: ['value', Symbol('value')] })).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: new Uint8Array([1, 2]) })).to.be.false;
    });
    it('rejects special and binary objects', () => {
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(new Error('failure'))).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(new Date())).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(new uri_1.default('file:///workspace'))).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(new Uint8Array([1, 2]))).to.be.false;
    });
    it('rejects class instances even when their properties are flat', () => {
        class Payload {
            constructor() {
                this.value = 'value';
            }
        }
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)(new Payload())).to.be.false;
    });
    it('rejects unsupported values in otherwise plain payloads', () => {
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: undefined })).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: () => 'value' })).to.be.false;
        (0, chai_1.expect)((0, telemetry_service_1.isTelemetryData)({ value: Symbol('value') })).to.be.false;
    });
});
//# sourceMappingURL=telemetry-service.spec.js.map