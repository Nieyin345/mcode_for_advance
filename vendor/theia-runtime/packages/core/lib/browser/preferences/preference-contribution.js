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
exports.FrontendApplicationPreferenceConfig = void 0;
exports.bindPreferenceSchemaProvider = bindPreferenceSchemaProvider;
const common_1 = require("../../common");
const preference_scope_1 = require("../../common/preferences/preference-scope");
const types_1 = require("../../common/types");
const preference_schema_service_1 = require("../../common/preferences/preference-schema-service");
const preference_schema_1 = require("../../common/preferences/preference-schema");
const defaults_preference_provider_1 = require("../../common/preferences/defaults-preference-provider");
const session_preference_provider_1 = require("../../common/preferences/session-preference-provider");
const preference_language_override_service_1 = require("../../common/preferences/preference-language-override-service");
const frontend_config_preference_contributions_1 = require("./frontend-config-preference-contributions");
const preference_configurations_1 = require("../../common/preferences/preference-configurations");
function bindPreferenceSchemaProvider(bind) {
    (0, preference_configurations_1.bindPreferenceConfigurations)(bind);
    bind(preference_scope_1.ValidPreferenceScopes).toConstantValue([
        preference_scope_1.PreferenceScope.Default,
        preference_scope_1.PreferenceScope.User,
        preference_scope_1.PreferenceScope.Workspace,
        preference_scope_1.PreferenceScope.Folder,
        preference_scope_1.PreferenceScope.Session
    ]);
    bind(preference_schema_service_1.PreferenceSchemaServiceImpl).toSelf().inSingletonScope();
    bind(preference_schema_1.PreferenceSchemaService).toService(preference_schema_service_1.PreferenceSchemaServiceImpl);
    bind(common_1.PreferenceProvider).to(defaults_preference_provider_1.DefaultsPreferenceProvider).inSingletonScope().whenTargetNamed(preference_scope_1.PreferenceScope.Default);
    bind(common_1.PreferenceProvider).to(session_preference_provider_1.SessionPreferenceProvider).inSingletonScope().whenTargetNamed(preference_scope_1.PreferenceScope.Session);
    bind(preference_language_override_service_1.PreferenceLanguageOverrideService).toSelf().inSingletonScope();
    (0, common_1.bindRootContributionProvider)(bind, preference_schema_1.PreferenceContribution);
    bind(preference_schema_1.PreferenceContribution).to(frontend_config_preference_contributions_1.FrontendConfigPreferenceContribution).inSingletonScope();
}
var FrontendApplicationPreferenceConfig;
(function (FrontendApplicationPreferenceConfig) {
    function is(config) {
        return (0, types_1.isObject)(config.preferences);
    }
    FrontendApplicationPreferenceConfig.is = is;
})(FrontendApplicationPreferenceConfig || (exports.FrontendApplicationPreferenceConfig = FrontendApplicationPreferenceConfig = {}));
//# sourceMappingURL=preference-contribution.js.map