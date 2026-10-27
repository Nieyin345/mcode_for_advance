"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
const inversify_1 = require("@theia/core/shared/inversify");
const language_model_frontend_delegate_1 = require("./language-model-frontend-delegate");
const core_1 = require("@theia/core");
const connection_container_module_1 = require("@theia/core/lib/node/messaging/connection-container-module");
const common_1 = require("../common");
const backend_language_model_registry_1 = require("./backend-language-model-registry");
const token_usage_service_impl_1 = require("./token-usage-service-impl");
const model_snapshot_store_1 = require("./model-snapshot-store");
const model_discovery_fetcher_1 = require("./model-discovery-fetcher");
const agent_preferences_1 = require("../common/agent-preferences");
const ai_core_preferences_1 = require("../common/ai-core-preferences");
// We use a connection module to handle AI services separately for each frontend.
const aiCoreConnectionModule = connection_container_module_1.ConnectionContainerModule.create(({ bind, bindBackendService, bindFrontendService }) => {
    (0, core_1.bindContributionProvider)(bind, common_1.LanguageModelProvider);
    bind(backend_language_model_registry_1.BackendLanguageModelRegistryImpl).toSelf().inSingletonScope();
    bind(common_1.LanguageModelRegistry).toService(backend_language_model_registry_1.BackendLanguageModelRegistryImpl);
    bind(common_1.TokenUsageService).to(token_usage_service_impl_1.TokenUsageServiceImpl).inSingletonScope();
    bind(core_1.ConnectionHandler)
        .toDynamicValue(({ container }) => new core_1.RpcConnectionHandler(common_1.TOKEN_USAGE_SERVICE_PATH, client => {
        const service = container.get(common_1.TokenUsageService);
        service.setClient(client);
        return service;
    }))
        .inSingletonScope();
    bind(common_1.LanguageModelRegistryFrontendDelegate).to(language_model_frontend_delegate_1.LanguageModelRegistryFrontendDelegateImpl).inSingletonScope();
    bind(core_1.ConnectionHandler)
        .toDynamicValue(ctx => new core_1.RpcConnectionHandler(common_1.languageModelRegistryDelegatePath, client => {
        const registryDelegate = ctx.container.get(common_1.LanguageModelRegistryFrontendDelegate);
        registryDelegate.setClient(client);
        return registryDelegate;
    }))
        .inSingletonScope();
    bind(language_model_frontend_delegate_1.LanguageModelFrontendDelegateImpl).toSelf().inSingletonScope();
    bind(common_1.LanguageModelFrontendDelegate).toService(language_model_frontend_delegate_1.LanguageModelFrontendDelegateImpl);
    bind(core_1.ConnectionHandler)
        .toDynamicValue(({ container }) => new core_1.RpcConnectionHandler(common_1.languageModelDelegatePath, client => {
        const service = container.get(language_model_frontend_delegate_1.LanguageModelFrontendDelegateImpl);
        service.setClient(client);
        return service;
    }))
        .inSingletonScope();
    bind(common_1.PromptServiceImpl).toSelf().inSingletonScope();
    bind(common_1.PromptService).toService(common_1.PromptServiceImpl);
});
exports.default = new inversify_1.ContainerModule(bind => {
    bind(core_1.PreferenceContribution).toConstantValue({ schema: agent_preferences_1.AgentSettingsPreferenceSchema });
    (0, ai_core_preferences_1.bindAICorePreferences)(bind);
    // Bound in the root container: the snapshots are per provider, not per frontend connection,
    // and the provider managers resolving them live in connection-scoped child containers.
    bind(model_snapshot_store_1.ModelSnapshotStoreImpl).toSelf().inSingletonScope();
    bind(model_snapshot_store_1.ModelSnapshotStore).toService(model_snapshot_store_1.ModelSnapshotStoreImpl);
    bind(model_discovery_fetcher_1.ModelDiscoveryFetcherImpl).toSelf().inSingletonScope();
    bind(model_discovery_fetcher_1.ModelDiscoveryFetcher).toService(model_discovery_fetcher_1.ModelDiscoveryFetcherImpl);
    bind(connection_container_module_1.ConnectionContainerModule).toConstantValue(aiCoreConnectionModule);
});
//# sourceMappingURL=ai-core-backend-module.js.map