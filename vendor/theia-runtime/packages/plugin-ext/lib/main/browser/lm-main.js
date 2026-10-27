"use strict";
// *****************************************************************************
// Copyright (C) 2025 EclipseSource
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
exports.McpServerDefinitionRegistryMainImpl = void 0;
const lm_protocol_1 = require("../../common/lm-protocol");
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const common_1 = require("@theia/ai-mcp/lib/common");
const core_1 = require("@theia/core");
class McpServerDefinitionRegistryMainImpl {
    constructor(rpc, container) {
        this.providers = new Map();
        this.proxy = rpc.getProxy(plugin_api_rpc_1.MAIN_RPC_CONTEXT.MCP_SERVER_DEFINITION_REGISTRY_EXT);
        try {
            this.mcpServerManager = container.get(common_1.MCPServerManager);
        }
        catch {
            // MCP Server Manager is optional
            this.mcpServerManager = undefined;
        }
    }
    $registerMcpServerDefinitionProvider(handle, name) {
        this.providers.set(handle, name);
        this.loadServerDefinitions(handle);
    }
    async $unregisterMcpServerDefinitionProvider(handle) {
        if (!this.mcpServerManager) {
            console.warn('MCP Server Manager not available - MCP server definitions will not be loaded');
            return;
        }
        const provider = this.providers.get(handle);
        if (!provider) {
            console.warn(`No MCP Server provider found for handle '${handle}' - MCP server definitions will not be loaded`);
            return;
        }
        // Get all servers provided by this provider and remove them server by server
        try {
            const definitions = await this.$getServerDefinitions(handle);
            for (const definition of definitions) {
                await this.mcpServerManager.removeServer(definition.label);
            }
        }
        catch (error) {
            console.error('Error getting server definitions for removal:', error);
        }
        this.providers.delete(handle);
    }
    $onDidChangeMcpServerDefinitions(handle) {
        // Reload server definitions when provider reports changes
        this.loadServerDefinitions(handle);
    }
    async $getServerDefinitions(handle) {
        try {
            return await this.proxy.$provideServerDefinitions(handle);
        }
        catch (error) {
            console.error('Error getting MCP server definitions:', error);
            return [];
        }
    }
    async $resolveServerDefinition(handle, server) {
        try {
            return await this.proxy.$resolveServerDefinition(handle, server);
        }
        catch (error) {
            console.error('Error resolving MCP server definition:', error);
            return server;
        }
    }
    async loadServerDefinitions(handle) {
        if (!this.mcpServerManager) {
            console.warn('MCP Server Manager not available - MCP server definitions will not be loaded');
            return;
        }
        try {
            const definitions = await this.$getServerDefinitions(handle);
            for (const definition of definitions) {
                const mcpServerDescription = this.convertToMcpServerDescription(handle, definition);
                await this.mcpServerManager.addOrUpdateServer(mcpServerDescription);
            }
        }
        catch (error) {
            console.error('Error loading MCP server definitions:', error);
        }
    }
    convertToMcpServerDescription(handle, definition) {
        const self = this;
        if ((0, lm_protocol_1.isMcpHttpServerDefinitionDto)(definition)) {
            // Convert headers values to strings, filtering out null values
            let convertedHeaders;
            if (definition.headers) {
                convertedHeaders = {};
                for (const [key, value] of Object.entries(definition.headers)) {
                    if (value !== null) {
                        convertedHeaders[key] = String(value);
                    }
                }
            }
            const serverDescription = {
                name: definition.label,
                serverUrl: core_1.URI.fromComponents(definition.uri).toString(),
                headers: convertedHeaders,
                autostart: false,
                async resolve(description) {
                    const resolved = await self.$resolveServerDefinition(handle, definition);
                    if (resolved) {
                        return self.convertToMcpServerDescription(handle, resolved);
                    }
                    return description;
                }
            };
            return serverDescription;
        }
        // Convert env values to strings, filtering out null values
        let convertedEnv;
        if (definition.env) {
            convertedEnv = {};
            for (const [key, value] of Object.entries(definition.env)) {
                if (value !== null) {
                    convertedEnv[key] = String(value);
                }
            }
        }
        return {
            name: definition.label,
            command: definition.command,
            args: definition.args,
            env: convertedEnv,
            autostart: false, // Extensions should manage their own server lifecycle
            async resolve(serverDescription) {
                const resolved = await self.$resolveServerDefinition(handle, definition);
                if (resolved) {
                    return self.convertToMcpServerDescription(handle, resolved);
                }
                return serverDescription;
            }
        };
    }
}
exports.McpServerDefinitionRegistryMainImpl = McpServerDefinitionRegistryMainImpl;
//# sourceMappingURL=lm-main.js.map