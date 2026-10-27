"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
exports.TelemetryMainImpl = void 0;
const disposable_1 = require("@theia/core/lib/common/disposable");
const telemetry_consent_provider_1 = require("@theia/telemetry/lib/common/telemetry-consent-provider");
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
/**
 * Forwards the user's telemetry consent to the plugin host. The initial level is seeded through
 * `PluginManagerInitializeParams` so that it is in place before any plugin activates.
 *
 * `TelemetryMain` declares no `$` methods; the instance is registered with the RPC protocol so that the consent
 * subscription is disposed along with the channel.
 *
 * @experimental
 */
class TelemetryMainImpl {
    constructor(rpc, container) {
        this.toDispose = new disposable_1.DisposableCollection();
        this.proxy = rpc.getProxy(plugin_api_rpc_1.MAIN_RPC_CONTEXT.TELEMETRY_EXT);
        const consentProvider = container.get(telemetry_consent_provider_1.TelemetryConsentProvider);
        this.toDispose.push(consentProvider.onDidChangeTelemetryLevel(level => this.proxy.$onDidChangeTelemetryLevel(level)));
    }
    dispose() {
        this.toDispose.dispose();
    }
}
exports.TelemetryMainImpl = TelemetryMainImpl;
//# sourceMappingURL=telemetry-main.js.map