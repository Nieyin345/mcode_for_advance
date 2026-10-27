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
exports.isValidTelemetryTopic = isValidTelemetryTopic;
exports.isValidTelemetrySinkId = isValidTelemetrySinkId;
exports.isValidTelemetryTopicPattern = isValidTelemetryTopicPattern;
exports.matchesTelemetryTopic = matchesTelemetryTopic;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function hasValidSegments(value, minimumSegments) {
    const segments = value.split('/');
    return segments.length >= minimumSegments && segments.every(segment => SEGMENT_PATTERN.test(segment));
}
/** @experimental */
function isValidTelemetryTopic(topic) {
    return typeof topic === 'string' && hasValidSegments(topic, 2);
}
/** @experimental */
function isValidTelemetrySinkId(id) {
    return typeof id === 'string' && hasValidSegments(id, 2);
}
/** @experimental */
function isValidTelemetryTopicPattern(pattern) {
    if (typeof pattern !== 'string') {
        return false;
    }
    if (pattern === '*') {
        return true;
    }
    if (pattern.endsWith('/*')) {
        return hasValidSegments(pattern.slice(0, -2), 1);
    }
    return isValidTelemetryTopic(pattern);
}
/** @experimental */
function matchesTelemetryTopic(pattern, topic) {
    if (!isValidTelemetryTopicPattern(pattern) || !isValidTelemetryTopic(topic)) {
        return false;
    }
    if (pattern === '*') {
        return true;
    }
    if (pattern.endsWith('/*')) {
        return topic.startsWith(`${pattern.slice(0, -2)}/`);
    }
    return pattern === topic;
}
//# sourceMappingURL=telemetry-topic.js.map