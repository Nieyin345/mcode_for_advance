"use strict";
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
// *****************************************************************************
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindPreferenceProviders = bindPreferenceProviders;
const user_preference_provider_1 = require("../common/user-preference-provider");
const section_preference_provider_1 = require("../common/section-preference-provider");
const core_1 = require("@theia/core");
const user_configs_preference_provider_1 = require("../common/user-configs-preference-provider");
const env_variables_1 = require("@theia/core/lib/common/env-variables");
function bindPreferenceProviders(bind) {
    bind(user_configs_preference_provider_1.UserStorageLocationProvider).toDynamicValue(context => async () => {
        const env = context.container.get(env_variables_1.EnvVariablesServer);
        return new core_1.URI(await env.getConfigDirUri());
    });
    bind(core_1.PreferenceProvider).to(user_configs_preference_provider_1.UserConfigsPreferenceProvider).inSingletonScope().whenTargetNamed(core_1.PreferenceScope.User);
    (0, core_1.bindFactory)(bind, user_preference_provider_1.UserPreferenceProviderFactory, user_preference_provider_1.UserPreferenceProvider, section_preference_provider_1.SectionPreferenceProviderUri, section_preference_provider_1.SectionPreferenceProviderSection);
}
//# sourceMappingURL=preference-bindings.js.map