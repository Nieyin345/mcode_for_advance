"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.backendApplicationModule = void 0;
const inversify_1 = require("inversify");
const application_package_1 = require("@theia/application-package");
const request_1 = require("@theia/request");
const common_1 = require("../common");
const backend_application_1 = require("./backend-application");
const cli_1 = require("./cli");
const messaging_1 = require("./messaging");
const application_server_1 = require("./application-server");
const application_protocol_1 = require("../common/application-protocol");
const env_variables_1 = require("./../common/env-variables");
const env_variables_2 = require("./env-variables");
const connection_container_module_1 = require("./messaging/connection-container-module");
const quick_pick_service_1 = require("../common/quick-pick-service");
const ws_request_validators_1 = require("./ws-request-validators");
const key_store_1 = require("../common/key-store");
const key_store_server_1 = require("./key-store-server");
const contribution_filter_1 = require("../common/contribution-filter");
const environment_utils_1 = require("./environment-utils");
const process_utils_1 = require("./process-utils");
const proxy_cli_contribution_1 = require("./request/proxy-cli-contribution");
const performance_1 = require("./performance");
const os_backend_provider_1 = require("./os-backend-provider");
const backend_request_facade_1 = require("./request/backend-request-facade");
const filesystem_locking_1 = require("./filesystem-locking");
const backend_remote_service_1 = require("./remote/backend-remote-service");
const remote_cli_contribution_1 = require("./remote/remote-cli-contribution");
const setting_service_1 = require("./setting-service");
const core_preferences_1 = require("../common/core-preferences");
(0, inversify_1.decorate)((0, inversify_1.injectable)(), application_package_1.ApplicationPackage);
const commandConnectionModule = connection_container_module_1.ConnectionContainerModule.create(({ bindFrontendService }) => {
    bindFrontendService(common_1.commandServicePath, common_1.CommandService);
});
const messageConnectionModule = connection_container_module_1.ConnectionContainerModule.create(({ bind, bindFrontendService }) => {
    bindFrontendService(common_1.messageServicePath, common_1.MessageClient);
    bind(common_1.MessageService).toSelf().inSingletonScope();
});
const quickPickConnectionModule = connection_container_module_1.ConnectionContainerModule.create(({ bindFrontendService }) => {
    bindFrontendService(quick_pick_service_1.quickInputServicePath, quick_pick_service_1.QuickInputService);
    bindFrontendService(quick_pick_service_1.quickPickServicePath, quick_pick_service_1.QuickPickService);
});
exports.backendApplicationModule = new inversify_1.ContainerModule(bind => {
    bind(connection_container_module_1.ConnectionContainerModule).toConstantValue(commandConnectionModule);
    bind(connection_container_module_1.ConnectionContainerModule).toConstantValue(messageConnectionModule);
    bind(connection_container_module_1.ConnectionContainerModule).toConstantValue(quickPickConnectionModule);
    bind(cli_1.CliManager).toSelf().inSingletonScope();
    (0, common_1.bindRootContributionProvider)(bind, cli_1.CliContribution);
    bind(backend_application_1.BackendApplicationCliContribution).toSelf().inSingletonScope();
    bind(cli_1.CliContribution).toService(backend_application_1.BackendApplicationCliContribution);
    bind(backend_application_1.EarlyExpressMiddleware).toSelf().inSingletonScope();
    bind(backend_application_1.BackendApplication).toSelf().inSingletonScope();
    bind(backend_application_1.RootContainer).toDynamicValue(({ container }) => {
        let root = container;
        while (root.parent) {
            root = root.parent;
        }
        return root;
    }).inSingletonScope();
    (0, common_1.bindRootContributionProvider)(bind, backend_application_1.BackendApplicationContribution);
    // Bind the BackendApplicationServer as a BackendApplicationContribution
    // and fallback to an empty contribution if never bound.
    bind(backend_application_1.BackendApplicationContribution).toDynamicValue(ctx => {
        if (ctx.container.isBound(backend_application_1.BackendApplicationServer)) {
            return ctx.container.get(backend_application_1.BackendApplicationServer);
        }
        else {
            console.warn('no BackendApplicationServer is set, frontend might not be available');
            return {};
        }
    }).inSingletonScope();
    bind(messaging_1.IPCConnectionProvider).toSelf().inSingletonScope();
    bind(application_server_1.ApplicationServerImpl).toSelf().inSingletonScope();
    bind(application_protocol_1.ApplicationServer).toService(application_server_1.ApplicationServerImpl);
    bind(common_1.ConnectionHandler).toDynamicValue(ctx => new common_1.RpcConnectionHandler(application_protocol_1.applicationPath, () => ctx.container.get(application_protocol_1.ApplicationServer))).inSingletonScope();
    bind(env_variables_1.EnvVariablesServer).to(env_variables_2.EnvVariablesServerImpl).inSingletonScope();
    bind(common_1.ConnectionHandler).toDynamicValue(ctx => new common_1.RpcConnectionHandler(env_variables_1.envVariablesPath, () => {
        const envVariablesServer = ctx.container.get(env_variables_1.EnvVariablesServer);
        return envVariablesServer;
    })).inSingletonScope();
    bind(application_package_1.ApplicationPackage).toConstantValue(new application_package_1.ApplicationPackage({ projectPath: backend_application_1.BackendApplicationPath }));
    bind(ws_request_validators_1.WsRequestValidator).toSelf().inSingletonScope();
    (0, common_1.bindRootContributionProvider)(bind, ws_request_validators_1.WsRequestValidatorContribution);
    bind(key_store_1.KeyStoreService).to(key_store_server_1.KeyStoreServiceImpl).inSingletonScope();
    bind(common_1.ConnectionHandler).toDynamicValue(ctx => new common_1.RpcConnectionHandler(key_store_1.keyStoreServicePath, () => ctx.container.get(key_store_1.KeyStoreService))).inSingletonScope();
    bind(contribution_filter_1.ContributionFilterRegistry).to(contribution_filter_1.ContributionFilterRegistryImpl).inSingletonScope();
    bind(environment_utils_1.EnvironmentUtils).toSelf().inSingletonScope();
    bind(process_utils_1.ProcessUtils).toSelf().inSingletonScope();
    bind(os_backend_provider_1.OSBackendProviderImpl).toSelf().inSingletonScope();
    bind(common_1.OSBackendProvider).toService(os_backend_provider_1.OSBackendProviderImpl);
    bind(common_1.ConnectionHandler).toDynamicValue(ctx => new common_1.RpcConnectionHandler(common_1.OSBackendProviderPath, () => ctx.container.get(common_1.OSBackendProvider))).inSingletonScope();
    bind(proxy_cli_contribution_1.ProxyCliContribution).toSelf().inSingletonScope();
    bind(cli_1.CliContribution).toService(proxy_cli_contribution_1.ProxyCliContribution);
    (0, common_1.bindRootContributionProvider)(bind, remote_cli_contribution_1.RemoteCliContribution);
    bind(backend_remote_service_1.BackendRemoteService).toSelf().inSingletonScope();
    (0, common_1.bindRootContributionProvider)(bind, backend_request_facade_1.BackendRequestAllowedContribution);
    bind(backend_request_facade_1.BackendRequestFacade).toSelf().inSingletonScope();
    bind(common_1.ConnectionHandler).toDynamicValue(ctx => new common_1.RpcConnectionHandler(request_1.REQUEST_SERVICE_PATH, () => ctx.container.get(backend_request_facade_1.BackendRequestFacade))).inSingletonScope();
    (0, performance_1.bindNodeStopwatch)(bind);
    (0, performance_1.bindBackendStopwatchServer)(bind);
    bind(filesystem_locking_1.FileSystemLocking).to(filesystem_locking_1.FileSystemLockingImpl).inSingletonScope();
    bind(setting_service_1.SettingServiceImpl).toSelf().inSingletonScope();
    bind(setting_service_1.SettingService).toService(setting_service_1.SettingServiceImpl);
    (0, common_1.bindPreferenceConfigurations)(bind);
    bind(common_1.ValidPreferenceScopes).toConstantValue([common_1.PreferenceScope.Default, common_1.PreferenceScope.User]);
    (0, common_1.bindRootContributionProvider)(bind, common_1.PreferenceContribution);
    bind(common_1.PreferenceProviderProvider).toFactory(ctx => (scope) => ctx.container.getNamed(common_1.PreferenceProvider, scope));
    bind(common_1.PreferenceSchemaServiceImpl).toSelf().inSingletonScope();
    bind(common_1.PreferenceSchemaService).toService(common_1.PreferenceSchemaServiceImpl);
    bind(common_1.PreferenceProvider).to(common_1.DefaultsPreferenceProvider).inSingletonScope().whenTargetNamed(common_1.PreferenceScope.Default);
    bind(common_1.PreferenceLanguageOverrideService).toSelf().inSingletonScope();
    bind(common_1.PreferenceServiceImpl).toSelf().inSingletonScope();
    bind(common_1.PreferenceService).toService(common_1.PreferenceServiceImpl);
    (0, core_preferences_1.bindCorePreferences)(bind);
    (0, common_1.bindTreePreferences)(bind);
});
//# sourceMappingURL=backend-application-module.js.map