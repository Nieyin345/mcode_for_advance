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
const telemetry_topic_1 = require("./telemetry-topic");
describe('telemetry topic contract', () => {
    const validNames = ['company/metric', 'Company/Metric', 'company/product/metric', 'company-1/metric_2', 'company.name/metric'];
    const invalidNames = ['', 'company', '/company/metric', 'company/metric/', 'company//metric', 'company/*', '*/metric', 'company/**', 'company/metric!', ' company/metric'];
    for (const name of validNames) {
        it(`accepts topic and sink ID '${name}'`, () => {
            (0, chai_1.expect)((0, telemetry_topic_1.isValidTelemetryTopic)(name)).to.be.true;
            (0, chai_1.expect)((0, telemetry_topic_1.isValidTelemetrySinkId)(name)).to.be.true;
        });
    }
    for (const name of invalidNames) {
        it(`rejects topic and sink ID '${name}'`, () => {
            (0, chai_1.expect)((0, telemetry_topic_1.isValidTelemetryTopic)(name)).to.be.false;
            (0, chai_1.expect)((0, telemetry_topic_1.isValidTelemetrySinkId)(name)).to.be.false;
        });
    }
    it('accepts only exact, terminal prefix, and global patterns', () => {
        for (const pattern of ['company/metric', 'company/product/metric', 'company/*', 'company/product/*', '*']) {
            (0, chai_1.expect)((0, telemetry_topic_1.isValidTelemetryTopicPattern)(pattern), pattern).to.be.true;
        }
        const invalidPatterns = [
            '', 'company', '/company/*', 'company/*/', 'company//metric', '*/metric',
            'company/*/metric', 'company/**', '**', '!company/metric', 'company/(metric)'
        ];
        for (const pattern of invalidPatterns) {
            (0, chai_1.expect)((0, telemetry_topic_1.isValidTelemetryTopicPattern)(pattern), pattern).to.be.false;
        }
    });
    it('matches exact topics case-sensitively', () => {
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('company/metric', 'company/metric')).to.be.true;
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('company/metric', 'company/other')).to.be.false;
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('company/metric', 'Company/metric')).to.be.false;
    });
    it('matches descendants of a terminal prefix only', () => {
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('company/*', 'company/metric')).to.be.true;
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('company/*', 'company/product/metric')).to.be.true;
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('company/*', 'company')).to.be.false;
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('company/*', 'companyElse/metric')).to.be.false;
    });
    it('matches every valid topic with the global pattern', () => {
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('*', 'company/metric')).to.be.true;
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('*', 'company/product/metric')).to.be.true;
    });
    it('does not match invalid patterns or topics', () => {
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('company/**', 'company/metric')).to.be.false;
        (0, chai_1.expect)((0, telemetry_topic_1.matchesTelemetryTopic)('*', 'company')).to.be.false;
    });
});
//# sourceMappingURL=telemetry-topic.spec.js.map