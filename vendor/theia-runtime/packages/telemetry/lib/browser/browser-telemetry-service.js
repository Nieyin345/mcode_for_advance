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
exports.BrowserTelemetryService = void 0;
const tslib_1 = require("tslib");
const frontend_id_provider_1 = require("@theia/core/lib/browser/messaging/frontend-id-provider");
const common_1 = require("@theia/core/lib/common");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_consent_provider_1 = require("../common/telemetry-consent-provider");
const telemetry_protocol_1 = require("../common/telemetry-protocol");
const telemetry_types_1 = require("../common/telemetry-types");
const telemetry_topic_1 = require("../common/telemetry-topic");
let BrowserTelemetryService = class BrowserTelemetryService {
    report(topic, data, options) {
        const event = (0, telemetry_protocol_1.createTelemetryEvent)(topic, this.frontendIdProvider.getId(), data, options);
        if (!(0, telemetry_protocol_1.isValidTelemetryEvent)(event)) {
            this.logger.warn(`Ignoring malformed telemetry event for topic '${(0, telemetry_protocol_1.describeTelemetryTopic)(topic)}'.`);
            return;
        }
        this.fetchLocalSinkInterests();
        if (!(0, telemetry_types_1.isKindAllowedByLevel)(this.consentProvider.level, event.kind)
            && this.localSinkInterests !== undefined
            && !this.localSinkInterests.some(pattern => (0, telemetry_topic_1.matchesTelemetryTopic)(pattern, event.topic))) {
            return;
        }
        this.rpc.notifyEvent((0, telemetry_protocol_1.snapshotTelemetryEvent)(event));
    }
    fetchLocalSinkInterests() {
        if (!this.localSinkInterestsPromise) {
            this.localSinkInterestsPromise = this.rpc.getLocalSinkInterests().then(interests => { this.localSinkInterests = interests; }, () => { this.localSinkInterests = []; });
        }
    }
};
exports.BrowserTelemetryService = BrowserTelemetryService;
tslib_1.__decorate([
    (0, inversify_1.inject)(telemetry_protocol_1.TelemetryRpc),
    tslib_1.__metadata("design:type", Object)
], BrowserTelemetryService.prototype, "rpc", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(frontend_id_provider_1.FrontendIdProvider),
    tslib_1.__metadata("design:type", Object)
], BrowserTelemetryService.prototype, "frontendIdProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(telemetry_consent_provider_1.TelemetryConsentProvider),
    tslib_1.__metadata("design:type", Object)
], BrowserTelemetryService.prototype, "consentProvider", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ILogger),
    (0, inversify_1.named)('telemetry:BrowserTelemetryService'),
    tslib_1.__metadata("design:type", Object)
], BrowserTelemetryService.prototype, "logger", void 0);
exports.BrowserTelemetryService = BrowserTelemetryService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BrowserTelemetryService);
//# sourceMappingURL=browser-telemetry-service.js.map