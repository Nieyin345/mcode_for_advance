"use strict";
// *****************************************************************************
// Copyright (C) 2024 EclipseSource and others.
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
require("@theia/core/shared/reflect-metadata");
const inversify_1 = require("@theia/core/shared/inversify");
const rpc_protocol_1 = require("../../common/rpc-protocol");
const plugin_host_rpc_1 = require("./plugin-host-rpc");
const plugin_manager_1 = require("../../plugin/plugin-manager");
const node_1 = require("@theia/core/lib/node");
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const env_1 = require("../../plugin/env");
const env_node_ext_1 = require("../../plugin/node/env-node-ext");
const localization_ext_1 = require("../../plugin/localization-ext");
const preference_registry_1 = require("../../plugin/preference-registry");
const debug_ext_1 = require("../../plugin/debug/debug-ext");
const editors_and_documents_1 = require("../../plugin/editors-and-documents");
const workspace_1 = require("../../plugin/workspace");
const message_registry_1 = require("../../plugin/message-registry");
const clipboard_ext_1 = require("../../plugin/clipboard-ext");
const plugin_storage_1 = require("../../plugin/plugin-storage");
const webviews_1 = require("../../plugin/webviews");
const terminal_ext_1 = require("../../plugin/terminal-ext");
const secrets_ext_1 = require("../../plugin/secrets-ext");
const plugin_host_logger_1 = require("./plugin-host-logger");
const lm_ext_1 = require("../../plugin/lm-ext");
const lm_tool_ext_1 = require("../../plugin/lm-tool-ext");
const encoding_service_1 = require("@theia/core/lib/common/encoding-service");
const telemetry_ext_1 = require("../../plugin/telemetry-ext");
exports.default = new inversify_1.ContainerModule(bind => {
    const channel = new node_1.IPCChannel();
    const rpc = new rpc_protocol_1.RPCProtocolImpl(channel);
    (0, plugin_host_logger_1.setupPluginHostLogger)(rpc);
    bind(rpc_protocol_1.RPCProtocol).toConstantValue(rpc);
    bind(plugin_host_rpc_1.PluginContainerModuleLoader).toDynamicValue(({ container }) => (module) => {
        container.load(module);
        const internalModule = module;
        const pluginApiCache = internalModule.initializeApi?.(container);
        return pluginApiCache;
    }).inSingletonScope();
    bind(plugin_host_rpc_1.AbstractPluginHostRPC).toService(plugin_host_rpc_1.PluginHostRPC);
    bind(plugin_manager_1.AbstractPluginManagerExtImpl).toService(plugin_manager_1.PluginManagerExtImpl);
    bind(plugin_manager_1.PluginManagerExtImpl).toSelf().inSingletonScope();
    bind(plugin_host_rpc_1.PluginHostRPC).toSelf().inSingletonScope();
    bind(env_1.EnvExtImpl).to(env_node_ext_1.EnvNodeExtImpl).inSingletonScope();
    bind(plugin_api_rpc_1.LocalizationExt).to(localization_ext_1.LocalizationExtImpl).inSingletonScope();
    bind(plugin_storage_1.InternalStorageExt).toService(plugin_storage_1.KeyValueStorageProxy);
    bind(plugin_storage_1.KeyValueStorageProxy).toSelf().inSingletonScope();
    bind(secrets_ext_1.InternalSecretsExt).toService(secrets_ext_1.SecretsExtImpl);
    bind(secrets_ext_1.SecretsExtImpl).toSelf().inSingletonScope();
    bind(preference_registry_1.PreferenceRegistryExtImpl).toSelf().inSingletonScope();
    bind(debug_ext_1.DebugExtImpl).toSelf().inSingletonScope();
    bind(lm_ext_1.LmExtImpl).toSelf().inSingletonScope();
    bind(lm_tool_ext_1.LanguageModelToolsExtImpl).toSelf().inSingletonScope();
    bind(encoding_service_1.EncodingService).toSelf().inSingletonScope();
    bind(editors_and_documents_1.EditorsAndDocumentsExtImpl).toSelf().inSingletonScope();
    bind(workspace_1.WorkspaceExtImpl).toSelf().inSingletonScope();
    bind(message_registry_1.MessageRegistryExt).toSelf().inSingletonScope();
    bind(clipboard_ext_1.ClipboardExt).toSelf().inSingletonScope();
    bind(webviews_1.WebviewsExtImpl).toSelf().inSingletonScope();
    bind(plugin_manager_1.MinimalTerminalServiceExt).toService(terminal_ext_1.TerminalServiceExtImpl);
    bind(terminal_ext_1.TerminalServiceExtImpl).toSelf().inSingletonScope();
    bind(telemetry_ext_1.TelemetryExtImpl).toSelf().inSingletonScope();
});
//# sourceMappingURL=plugin-host-module.js.map