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
const inversify_1 = require("@theia/core/shared/inversify");
const chai_1 = require("chai");
const telemetry_service_1 = require("../common/telemetry-service");
const browser_only_telemetry_service_1 = require("./browser-only-telemetry-service");
const telemetry_frontend_only_module_1 = require("./telemetry-frontend-only-module");
describe('browser-only telemetry service', () => {
    it('binds the no-op service when telemetry is not already bound', () => {
        const container = new inversify_1.Container();
        container.load(telemetry_frontend_only_module_1.default);
        const service = container.get(telemetry_service_1.TelemetryService);
        (0, chai_1.expect)(service).to.be.instanceOf(browser_only_telemetry_service_1.BrowserOnlyTelemetryService);
        (0, chai_1.expect)(() => service.report('invalid', { malformed: { nested: true } })).not.to.throw();
    });
    it('replaces an existing telemetry service without invoking it', () => {
        const container = new inversify_1.Container();
        let reports = 0;
        container.bind(telemetry_service_1.TelemetryService).toConstantValue({ report: () => reports++ });
        container.load(telemetry_frontend_only_module_1.default);
        const service = container.get(telemetry_service_1.TelemetryService);
        service.report('company/action');
        (0, chai_1.expect)(service).to.be.instanceOf(browser_only_telemetry_service_1.BrowserOnlyTelemetryService);
        (0, chai_1.expect)(reports).to.equal(0);
    });
});
//# sourceMappingURL=browser-only-telemetry-service.spec.js.map