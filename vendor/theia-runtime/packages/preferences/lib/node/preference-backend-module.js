"use strict";
// *****************************************************************************
// Copyright (C) 2024 Typefox and others.
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
const cli_1 = require("@theia/core/lib/node/cli");
const remote_cli_contribution_1 = require("@theia/core/lib/node/remote/remote-cli-contribution");
const preference_cli_contribution_1 = require("./preference-cli-contribution");
const connection_container_module_1 = require("@theia/core/lib/node/messaging/connection-container-module");
const cli_preferences_1 = require("../common/cli-preferences");
const preference_bindings_1 = require("./preference-bindings");
const abstract_resource_preference_provider_1 = require("../common/abstract-resource-preference-provider");
const backend_preference_storage_1 = require("./backend-preference-storage");
const jsonc_editor_1 = require("../common/jsonc-editor");
const encoding_service_1 = require("@theia/core/lib/common/encoding-service");
const disk_file_system_provider_1 = require("@theia/filesystem/lib/node/disk-file-system-provider");
const preferencesConnectionModule = connection_container_module_1.ConnectionContainerModule.create(({ bind, bindBackendService }) => {
    bindBackendService(cli_preferences_1.CliPreferencesPath, cli_preferences_1.CliPreferences);
});
exports.default = new inversify_1.ContainerModule(bind => {
    bind(preference_cli_contribution_1.PreferenceCliContribution).toSelf().inSingletonScope();
    bind(cli_preferences_1.CliPreferences).toService(preference_cli_contribution_1.PreferenceCliContribution);
    bind(cli_1.CliContribution).toService(preference_cli_contribution_1.PreferenceCliContribution);
    bind(remote_cli_contribution_1.RemoteCliContribution).toService(preference_cli_contribution_1.PreferenceCliContribution);
    bind(jsonc_editor_1.JSONCEditor).toSelf().inSingletonScope();
    bind(abstract_resource_preference_provider_1.PreferenceStorageFactory).toFactory(({ container }) => (uri, scope) => new backend_preference_storage_1.BackendPreferenceStorage(container.get(disk_file_system_provider_1.DiskFileSystemProvider), uri, container.get(encoding_service_1.EncodingService), container.get(jsonc_editor_1.JSONCEditor)));
    bind(connection_container_module_1.ConnectionContainerModule).toConstantValue(preferencesConnectionModule);
    (0, preference_bindings_1.bindPreferenceProviders)(bind);
});
//# sourceMappingURL=preference-backend-module.js.map