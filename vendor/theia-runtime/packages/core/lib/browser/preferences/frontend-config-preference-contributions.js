"use strict";
// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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
exports.FrontendConfigPreferenceContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const frontend_application_config_provider_1 = require("../frontend-application-config-provider");
const preference_contribution_1 = require("./preference-contribution");
const preference_language_override_service_1 = require("../../common/preferences/preference-language-override-service");
const preferences_1 = require("../../common/preferences");
const application_props_1 = require("@theia/application-package/lib/application-props");
const logger_1 = require("../../common/logger");
let FrontendConfigPreferenceContribution = class FrontendConfigPreferenceContribution {
    constructor() {
        this.schema = { scope: preferences_1.PreferenceScope.Folder, properties: {} };
    }
    async initSchema(service) {
        const config = frontend_application_config_provider_1.FrontendApplicationConfigProvider.get();
        if (preference_contribution_1.FrontendApplicationPreferenceConfig.is(config)) {
            service.registerOverride('workbench.colorTheme', undefined, application_props_1.DefaultTheme.defaultForOSTheme(config.defaultTheme));
            if (config.defaultIconTheme) {
                service.registerOverride('workbench.iconTheme', undefined, config.defaultIconTheme);
            }
            try {
                for (const [key, defaultValue] of Object.entries(config.preferences)) {
                    if (preference_language_override_service_1.PreferenceLanguageOverrideService.testOverrideValue(key, defaultValue)) {
                        for (const [propertyName, value] of Object.entries(defaultValue)) {
                            service.registerOverride(propertyName, key.substring(1, key.length - 1), value);
                        }
                    }
                    else {
                        // regular configuration override
                        service.registerOverride(key, undefined, defaultValue);
                    }
                }
            }
            catch (e) {
                this.logger.error('Failed to load preferences from frontend configuration.', e);
            }
        }
    }
};
exports.FrontendConfigPreferenceContribution = FrontendConfigPreferenceContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(logger_1.ILogger),
    (0, inversify_1.named)('core:FrontendConfigPreferenceContribution'),
    tslib_1.__metadata("design:type", Object)
], FrontendConfigPreferenceContribution.prototype, "logger", void 0);
exports.FrontendConfigPreferenceContribution = FrontendConfigPreferenceContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FrontendConfigPreferenceContribution);
//# sourceMappingURL=frontend-config-preference-contributions.js.map