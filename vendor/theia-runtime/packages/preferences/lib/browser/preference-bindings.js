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
exports.bindWorkspaceFilePreferenceProvider = bindWorkspaceFilePreferenceProvider;
exports.bindPreferenceProviders = bindPreferenceProviders;
const inversify_1 = require("@theia/core/shared/inversify");
const user_preference_provider_1 = require("../common/user-preference-provider");
const workspace_preference_provider_1 = require("./workspace-preference-provider");
const workspace_file_preference_provider_1 = require("./workspace-file-preference-provider");
const folders_preferences_provider_1 = require("./folders-preferences-provider");
const folder_preference_provider_1 = require("./folder-preference-provider");
const section_preference_provider_1 = require("../common/section-preference-provider");
const core_1 = require("@theia/core");
const browser_1 = require("@theia/userstorage/lib/browser");
const user_configs_preference_provider_1 = require("../common/user-configs-preference-provider");
function bindWorkspaceFilePreferenceProvider(bind) {
    bind(workspace_file_preference_provider_1.WorkspaceFilePreferenceProviderFactory).toFactory(ctx => (options) => {
        const child = new inversify_1.Container({ defaultScope: 'Singleton' });
        child.parent = ctx.container;
        child.bind(workspace_file_preference_provider_1.WorkspaceFilePreferenceProvider).toSelf();
        child.bind(workspace_file_preference_provider_1.WorkspaceFilePreferenceProviderOptions).toConstantValue(options);
        return child.get(workspace_file_preference_provider_1.WorkspaceFilePreferenceProvider);
    });
}
function bindPreferenceProviders(bind, unbind) {
    bind(core_1.PreferenceProvider).to(user_configs_preference_provider_1.UserConfigsPreferenceProvider).inSingletonScope().whenTargetNamed(core_1.PreferenceScope.User);
    bind(core_1.PreferenceProvider).to(workspace_preference_provider_1.WorkspacePreferenceProvider).inSingletonScope().whenTargetNamed(core_1.PreferenceScope.Workspace);
    bind(core_1.PreferenceProvider).to(folders_preferences_provider_1.FoldersPreferencesProvider).inSingletonScope().whenTargetNamed(core_1.PreferenceScope.Folder);
    bindWorkspaceFilePreferenceProvider(bind);
    bind(user_configs_preference_provider_1.UserStorageLocationProvider).toConstantValue(() => browser_1.UserStorageUri);
    (0, core_1.bindFactory)(bind, user_preference_provider_1.UserPreferenceProviderFactory, user_preference_provider_1.UserPreferenceProvider, section_preference_provider_1.SectionPreferenceProviderUri, section_preference_provider_1.SectionPreferenceProviderSection);
    (0, core_1.bindFactory)(bind, folder_preference_provider_1.FolderPreferenceProviderFactory, folder_preference_provider_1.FolderPreferenceProvider, section_preference_provider_1.SectionPreferenceProviderUri, section_preference_provider_1.SectionPreferenceProviderSection, folder_preference_provider_1.FolderPreferenceProviderFolder);
}
//# sourceMappingURL=preference-bindings.js.map