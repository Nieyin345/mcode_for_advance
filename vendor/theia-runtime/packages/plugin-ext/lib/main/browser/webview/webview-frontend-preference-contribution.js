"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebviewFrontendPreferenceContribution = void 0;
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
const core_1 = require("@theia/core");
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
const schema = {
    properties: {
        'webview.warnIfUnsecure': {
            scope: core_1.PreferenceScope.Default,
            type: 'boolean',
            description: core_1.nls.localize('theia/plugin-ext/webviewWarnIfUnsecure', 'Warns users that webviews are currently deployed insecurely.'),
            default: true,
        }
    }
};
class WebviewFrontendPreferenceContribution {
    async initSchema(service) {
        const frontendConfig = frontend_application_config_provider_1.FrontendApplicationConfigProvider.get();
        if (frontendConfig.securityWarnings) {
            service.addSchema(schema);
        }
    }
}
exports.WebviewFrontendPreferenceContribution = WebviewFrontendPreferenceContribution;
;
//# sourceMappingURL=webview-frontend-preference-contribution.js.map