"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource.
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
exports.LmExtImpl = void 0;
const disposable_1 = require("@theia/core/lib/common/disposable");
const lm_protocol_1 = require("../common/lm-protocol");
const plugin_api_rpc_1 = require("../common/plugin-api-rpc");
const logger_1 = require("./logger");
const types_impl_1 = require("./types-impl");
class LmExtImpl {
    constructor(rpc) {
        this.rpc = rpc;
        this.providers = new Map();
        this.providerChangeListeners = new Map();
        this.handleCounter = 0;
        this.announcedMCPProviders = [];
        this.proxy = this.rpc.getProxy(plugin_api_rpc_1.PLUGIN_RPC_CONTEXT.MCP_SERVER_DEFINITION_REGISTRY_MAIN);
        this.logger = new logger_1.PluginLogger(this.rpc, 'lm');
    }
    registerMcpServerDefinitionProvider(id, provider) {
        if (this.announcedMCPProviders.indexOf(id) === -1) {
            this.logger.warn(`An unknown McpProvider tried to register, please check the package.json: ${id}`);
        }
        const handle = this.handleCounter++;
        this.providers.set(handle, provider);
        this.proxy.$registerMcpServerDefinitionProvider(handle, id);
        if (provider.onDidChangeMcpServerDefinitions) {
            const changeListener = provider.onDidChangeMcpServerDefinitions(() => {
                this.proxy.$onDidChangeMcpServerDefinitions(handle);
            });
            this.providerChangeListeners.set(handle, changeListener);
        }
        return disposable_1.Disposable.create(() => {
            this.providers.delete(handle);
            const changeListener = this.providerChangeListeners.get(handle);
            if (changeListener) {
                changeListener.dispose();
                this.providerChangeListeners.delete(handle);
            }
            this.proxy.$unregisterMcpServerDefinitionProvider(handle);
        });
    }
    async $provideServerDefinitions(handle) {
        const provider = this.providers.get(handle);
        if (!provider) {
            return [];
        }
        try {
            const definitions = await provider.provideMcpServerDefinitions();
            if (!definitions) {
                return [];
            }
            return definitions.map(def => this.convertToDto(def));
        }
        catch (error) {
            this.logger.error('Error providing MCP server definitions:', error);
            return [];
        }
    }
    async $resolveServerDefinition(handle, server) {
        const provider = this.providers.get(handle);
        if (!provider || !provider.resolveMcpServerDefinition) {
            return server;
        }
        try {
            const definition = this.convertFromDto(server);
            const resolved = await provider.resolveMcpServerDefinition(definition);
            return resolved ? this.convertToDto(resolved) : undefined;
        }
        catch (error) {
            this.logger.error('Error resolving MCP server definition:', error);
            return server;
        }
    }
    convertToDto(definition) {
        if (isMcpHttpServerDefinition(definition)) {
            return {
                label: definition.label,
                headers: definition.headers,
                uri: definition.uri,
                version: definition.version
            };
        }
        return {
            command: definition.command,
            args: definition.args,
            cwd: definition.cwd,
            version: definition.version,
            label: definition.label,
            env: definition.env
        };
    }
    convertFromDto(dto) {
        if ((0, lm_protocol_1.isMcpHttpServerDefinitionDto)(dto)) {
            return {
                label: dto.label,
                headers: dto.headers,
                uri: types_impl_1.URI.revive(dto.uri),
                version: dto.version
            };
        }
        return {
            command: dto.command,
            args: dto.args,
            cwd: types_impl_1.URI.revive(dto.cwd),
            version: dto.version,
            label: dto.label,
            env: dto.env
        };
    }
    registerMcpContributions(mcpContributions) {
        this.announcedMCPProviders.push(...mcpContributions.map(contribution => contribution.id));
    }
}
exports.LmExtImpl = LmExtImpl;
const isMcpHttpServerDefinition = (definition) => 'uri' in definition;
//# sourceMappingURL=lm-ext.js.map