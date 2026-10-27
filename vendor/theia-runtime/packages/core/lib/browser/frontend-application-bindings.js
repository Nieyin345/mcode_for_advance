"use strict";
// *****************************************************************************
// Copyright (C) 2019 TypeFox and others.
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
exports.bindMessageService = bindMessageService;
exports.bindPreferenceService = bindPreferenceService;
exports.bindResourceProvider = bindResourceProvider;
const common_1 = require("../common");
const preference_provider_1 = require("../common/preferences/preference-provider");
const preferences_1 = require("./preferences");
const preferences_2 = require("../common/preferences");
function bindMessageService(bind) {
    bind(common_1.MessageClient).toSelf().inSingletonScope();
    return bind(common_1.MessageService).toSelf().inSingletonScope();
}
function bindPreferenceService(bind) {
    bind(preferences_2.PreferenceProviderProvider).toFactory(ctx => (scope) => ctx.container.getNamed(preference_provider_1.PreferenceProvider, scope));
    bind(preferences_2.PreferenceServiceImpl).toSelf().inSingletonScope();
    bind(preferences_2.PreferenceService).toService(preferences_2.PreferenceServiceImpl);
    (0, preferences_1.bindPreferenceSchemaProvider)(bind);
    bind(preferences_1.PreferenceValidationService).toSelf().inSingletonScope();
    bind(preferences_2.InjectablePreferenceProxy).toSelf();
    bind(preferences_2.PreferenceProxyFactory).toFactory(({ container }) => (schema, options = {}) => {
        const child = container.createChild();
        child.bind(preferences_2.PreferenceProxyOptions).toConstantValue(options ?? {});
        child.bind(preferences_2.PreferenceProxySchema).toConstantValue(() => schema);
        const handler = child.get(preferences_2.InjectablePreferenceProxy);
        return new Proxy(Object.create(null), handler); // eslint-disable-line no-null/no-null
    });
}
function bindResourceProvider(bind) {
    bind(common_1.DefaultResourceProvider).toSelf().inSingletonScope();
    bind(common_1.ResourceProvider).toProvider(context => uri => context.container.get(common_1.DefaultResourceProvider).get(uri));
    (0, common_1.bindRootContributionProvider)(bind, common_1.ResourceResolver);
}
//# sourceMappingURL=frontend-application-bindings.js.map