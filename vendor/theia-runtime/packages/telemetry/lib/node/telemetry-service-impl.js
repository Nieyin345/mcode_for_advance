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
exports.TelemetryServiceImpl = void 0;
const tslib_1 = require("tslib");
const common_1 = require("@theia/core/lib/common");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_consent_provider_1 = require("../common/telemetry-consent-provider");
const telemetry_preferences_1 = require("../common/telemetry-preferences");
const telemetry_protocol_1 = require("../common/telemetry-protocol");
const telemetry_topic_1 = require("../common/telemetry-topic");
const telemetry_types_1 = require("../common/telemetry-types");
const telemetry_sink_1 = require("./telemetry-sink");
const MAX_PENDING_EVENTS = 1_000;
let TelemetryServiceImpl = class TelemetryServiceImpl {
    constructor() {
        this.readinessState = 'pending';
        this.pendingEvents = [];
        this.pendingQueueOverflowWarned = false;
    }
    init() {
        this.preferences.onPreferenceChanged(change => {
            if (change.preferenceName === telemetry_preferences_1.TELEMETRY_FILTERS) {
                this.filters = undefined;
            }
        });
        this.preferences.ready.then(() => {
            this.readinessState = 'ready';
            const pendingEvents = this.pendingEvents;
            this.pendingEvents = [];
            this.pendingQueueOverflowWarned = false;
            pendingEvents.forEach(event => this.doDispatch(event));
        }, () => {
            this.readinessState = 'failed';
            const pendingEvents = this.pendingEvents;
            this.pendingEvents = [];
            this.pendingQueueOverflowWarned = false;
            this.logger.error('Telemetry preferences failed to become ready; remote telemetry is disabled.');
            pendingEvents.forEach(event => this.doDispatch(event));
        });
    }
    report(topic, data, options) {
        this.dispatch((0, telemetry_protocol_1.createTelemetryEvent)(topic, telemetry_types_1.BACKEND_TELEMETRY_SESSION, data, options));
    }
    notifyEvent(event) {
        this.dispatch(event, true);
    }
    async getLocalSinkInterests() {
        return [...new Set(this.getSinks()
                .filter(sink => sink.scope === 'local')
                .flatMap(sink => sink.interests))];
    }
    async onStop() {
        await Promise.all(this.getSinks().map(async (validatedSink) => {
            try {
                await validatedSink.sink.flush?.();
            }
            catch {
                this.logger.error(`Telemetry sink '${validatedSink.id}' failed while flushing.`);
            }
        }));
    }
    dispatch(event, rpcOrigin = false) {
        if (!(0, telemetry_protocol_1.isValidTelemetryEvent)(event)) {
            this.logger.warn(`Ignoring malformed telemetry event for topic '${(0, telemetry_protocol_1.describeTelemetryEventTopic)(event)}'.`);
            return;
        }
        const snapshot = (0, telemetry_protocol_1.snapshotTelemetryEvent)(rpcOrigin ? { ...event, session: `frontend/${event.session}` } : event);
        if (this.readinessState === 'ready' || this.readinessState === 'failed') {
            this.doDispatch(snapshot);
        }
        else if (this.readinessState === 'pending') {
            if (this.pendingEvents.length >= MAX_PENDING_EVENTS) {
                this.pendingEvents.shift();
                if (!this.pendingQueueOverflowWarned) {
                    this.pendingQueueOverflowWarned = true;
                    this.logger.warn('Telemetry pending event queue is full; dropping oldest event.');
                }
            }
            this.pendingEvents.push(snapshot);
        }
    }
    doDispatch(event) {
        const filters = this.getFilters();
        for (const validatedSink of this.getSinks()) {
            if (this.readinessState === 'failed' && validatedSink.scope === 'remote') {
                continue;
            }
            const filterPatterns = filters.get(validatedSink.id);
            if ((filterPatterns && !filterPatterns.some(pattern => (0, telemetry_topic_1.matchesTelemetryTopic)(pattern, event.topic)))
                || !validatedSink.interests.some(pattern => (0, telemetry_topic_1.matchesTelemetryTopic)(pattern, event.topic))
                || (validatedSink.scope === 'remote' && !(0, telemetry_types_1.isKindAllowedByLevel)(this.consentProvider.level, event.kind))) {
                continue;
            }
            try {
                Promise.resolve(validatedSink.sink.handle(event)).catch(() => this.logSinkFailure(validatedSink.id, event.topic));
            }
            catch {
                this.logSinkFailure(validatedSink.id, event.topic);
            }
        }
    }
    getSinks() {
        if (this.sinks) {
            return this.sinks;
        }
        const contributions = this.sinkProvider.getContributions();
        const idCounts = new Map();
        for (const sink of contributions) {
            if ((0, telemetry_topic_1.isValidTelemetrySinkId)(sink.id)) {
                idCounts.set(sink.id, (idCounts.get(sink.id) ?? 0) + 1);
            }
        }
        this.sinks = contributions.flatMap(sink => {
            const id = sink.id;
            const interests = sink.interests;
            if (!(0, telemetry_topic_1.isValidTelemetrySinkId)(id)) {
                this.logger.error(`Ignoring telemetry sink with invalid ID '${String(id)}'.`);
                return [];
            }
            if (idCounts.get(id) !== 1) {
                this.logger.error(`Ignoring duplicate telemetry sink ID '${id}'.`);
                return [];
            }
            if (!Array.isArray(interests) || interests.length === 0
                || !interests.every(interest => (0, telemetry_topic_1.isValidTelemetryTopicPattern)(interest))) {
                this.logger.error(`Ignoring telemetry sink '${id}' with invalid interests.`);
                return [];
            }
            const scope = sink.scope ?? 'remote';
            if (scope !== 'local' && scope !== 'remote') {
                this.logger.error(`Ignoring telemetry sink '${id}' with invalid scope.`);
                return [];
            }
            return [{ sink, id, interests: Object.freeze([...interests]), scope }];
        });
        return this.sinks;
    }
    getFilters() {
        if (this.filters) {
            return this.filters;
        }
        const filters = new Map();
        for (const [sinkId, patterns] of Object.entries(this.preferences[telemetry_preferences_1.TELEMETRY_FILTERS] ?? {})) {
            if (!Array.isArray(patterns)) {
                this.logger.warn(`Ignoring invalid telemetry filters for sink '${sinkId}'.`);
                filters.set(sinkId, Object.freeze([]));
                continue;
            }
            const validPatterns = patterns.filter(pattern => {
                if ((0, telemetry_topic_1.isValidTelemetryTopicPattern)(pattern)) {
                    return true;
                }
                this.logger.warn(`Ignoring invalid telemetry filter pattern for sink '${sinkId}'.`);
                return false;
            });
            filters.set(sinkId, Object.freeze(validPatterns));
        }
        this.filters = filters;
        return filters;
    }
    logSinkFailure(sinkId, topic) {
        this.logger.error(`Telemetry sink '${sinkId}' failed while handling topic '${topic}'.`);
    }
};
exports.TelemetryServiceImpl = TelemetryServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(telemetry_consent_provider_1.TelemetryConsentProvider),
    tslib_1.__metadata("design:type", Object)
], TelemetryServiceImpl.prototype, "consentProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(telemetry_preferences_1.TelemetryPreferences),
    tslib_1.__metadata("design:type", Object)
], TelemetryServiceImpl.prototype, "preferences", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ContributionProvider),
    (0, inversify_1.named)(telemetry_sink_1.TelemetrySink),
    tslib_1.__metadata("design:type", Object)
], TelemetryServiceImpl.prototype, "sinkProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ILogger),
    (0, inversify_1.named)('telemetry:TelemetryServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], TelemetryServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], TelemetryServiceImpl.prototype, "init", null);
exports.TelemetryServiceImpl = TelemetryServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TelemetryServiceImpl);
//# sourceMappingURL=telemetry-service-impl.js.map