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
const browser_1 = require("@theia/core/lib/browser");
const inversify_1 = require("@theia/core/shared/inversify");
const telemetry_consent_provider_1 = require("../common/telemetry-consent-provider");
const telemetry_preferences_1 = require("../common/telemetry-preferences");
const telemetry_protocol_1 = require("../common/telemetry-protocol");
const telemetry_service_1 = require("../common/telemetry-service");
const browser_telemetry_service_1 = require("./browser-telemetry-service");
exports.default = new inversify_1.ContainerModule(bind => {
    (0, telemetry_preferences_1.bindTelemetryPreferences)(bind);
    bind(telemetry_consent_provider_1.TelemetryConsentProvider).to(telemetry_consent_provider_1.PreferenceTelemetryConsentProvider).inSingletonScope();
    bind(telemetry_protocol_1.TelemetryRpc).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(browser_1.RemoteConnectionProvider);
        return connectionProvider.createProxy(telemetry_protocol_1.telemetryServicePath);
    }).inSingletonScope();
    bind(browser_telemetry_service_1.BrowserTelemetryService).toSelf().inSingletonScope();
    bind(telemetry_service_1.TelemetryService).toService(browser_telemetry_service_1.BrowserTelemetryService);
});
//# sourceMappingURL=telemetry-frontend-module.js.map