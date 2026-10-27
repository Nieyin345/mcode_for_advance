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
exports.TelemetryRpc = exports.telemetryServicePath = void 0;
exports.isValidTelemetryEvent = isValidTelemetryEvent;
exports.describeTelemetryTopic = describeTelemetryTopic;
exports.describeTelemetryEventTopic = describeTelemetryEventTopic;
exports.createTelemetryEvent = createTelemetryEvent;
exports.snapshotTelemetryEvent = snapshotTelemetryEvent;
const types_1 = require("@theia/core/lib/common/types");
const telemetry_service_1 = require("./telemetry-service");
const telemetry_topic_1 = require("./telemetry-topic");
const telemetry_types_1 = require("./telemetry-types");
/** @experimental */
function isValidTelemetryEvent(event) {
    if (!(0, types_1.isObject)(event)) {
        return false;
    }
    return (0, telemetry_topic_1.isValidTelemetryTopic)(event.topic)
        && (0, telemetry_types_1.isTelemetryEventKind)(event.kind)
        && typeof event.session === 'string'
        && event.session.length > 0
        && typeof event.timestamp === 'number'
        && Number.isFinite(event.timestamp)
        && (event.data === undefined || (0, telemetry_service_1.isTelemetryData)(event.data))
        && (event.attributes === undefined || (0, telemetry_service_1.isTelemetryData)(event.attributes));
}
/** @experimental */
function describeTelemetryTopic(topic) {
    return typeof topic === 'string' ? topic : '<invalid>';
}
/** @experimental */
function describeTelemetryEventTopic(event) {
    if (!(0, types_1.isObject)(event)) {
        return '<invalid>';
    }
    return describeTelemetryTopic(event.topic);
}
/** @experimental */
function createTelemetryEvent(topic, session, data, options) {
    return {
        topic,
        kind: options?.kind ?? 'usage',
        data,
        attributes: options?.attributes,
        session,
        timestamp: Date.now()
    };
}
/** @experimental */
function snapshotTelemetryEvent(event) {
    return Object.freeze({
        topic: event.topic,
        kind: event.kind,
        data: (0, telemetry_service_1.snapshotTelemetryData)(event.data),
        attributes: (0, telemetry_service_1.snapshotTelemetryData)(event.attributes),
        session: event.session,
        timestamp: event.timestamp
    });
}
/** @experimental */
exports.telemetryServicePath = '/services/telemetry';
/** @experimental */
exports.TelemetryRpc = Symbol('TelemetryRpc');
//# sourceMappingURL=telemetry-protocol.js.map