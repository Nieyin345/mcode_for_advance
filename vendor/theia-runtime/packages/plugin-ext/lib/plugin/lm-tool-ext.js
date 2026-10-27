"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource.
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
exports.LanguageModelToolsExtImpl = void 0;
const cancellation_1 = require("@theia/core/lib/common/cancellation");
const lm_tool_protocol_1 = require("../common/lm-tool-protocol");
const plugin_api_rpc_1 = require("../common/plugin-api-rpc");
const logger_1 = require("./logger");
const types_impl_1 = require("./types-impl");
class LanguageModelToolsExtImpl {
    constructor(rpc) {
        this.rpc = rpc;
        this.handleCounter = 0;
        this.tools = new Map();
        this.toolNameToHandle = new Map();
        this.toolContributions = new Map();
        this.registeredToolMetadata = new Map();
        this.proxy = this.rpc.getProxy(plugin_api_rpc_1.PLUGIN_RPC_CONTEXT.LM_TOOLS_MAIN);
        this.logger = new logger_1.PluginLogger(this.rpc, 'lm-tools');
    }
    registerToolContributions(contributions) {
        for (const contribution of contributions) {
            this.toolContributions.set(contribution.name, contribution);
        }
    }
    registerTool(name, tool, pluginId) {
        const contribution = this.toolContributions.get(name);
        if (!contribution) {
            this.logger.warn(`Tool '${name}' is not declared in package.json contributes.languageModelTools.`);
        }
        if (this.toolNameToHandle.has(name)) {
            this.logger.warn(`Tool '${name}' is already registered. Ignoring duplicate registration.`);
            return types_impl_1.Disposable.NULL;
        }
        const handle = this.handleCounter++;
        const metadata = {
            name,
            description: contribution?.modelDescription,
            inputSchema: contribution?.inputSchema,
            tags: contribution?.tags,
        };
        this.tools.set(handle, tool);
        this.toolNameToHandle.set(name, handle);
        this.registeredToolMetadata.set(handle, metadata);
        this.proxy.$registerTool(handle, name, metadata, pluginId).catch(err => {
            this.logger.error(`Failed to register tool '${name}': ${err.message || err}`);
            this.tools.delete(handle);
            this.toolNameToHandle.delete(name);
            this.registeredToolMetadata.delete(handle);
        });
        return new types_impl_1.Disposable(() => {
            this.tools.delete(handle);
            this.toolNameToHandle.delete(name);
            this.registeredToolMetadata.delete(handle);
            this.proxy.$unregisterTool(handle);
        });
    }
    async invokeTool(name, options, token) {
        const handle = this.toolNameToHandle.get(name);
        if (handle === undefined) {
            throw new Error(`Tool '${name}' is not registered.`);
        }
        const result = await this.$invokeTool(handle, JSON.stringify(options.input), token);
        if ((0, lm_tool_protocol_1.isToolInvocationError)(result)) {
            throw new Error(result.error);
        }
        return new types_impl_1.LanguageModelToolResult(result.content.map(part => this.convertDtoToApiPart(part)));
    }
    getTools() {
        const result = new Map();
        // Add declared tool contributions from package.json
        for (const c of this.toolContributions.values()) {
            result.set(c.name, {
                name: c.name,
                description: c.modelDescription ?? '',
                inputSchema: c.inputSchema,
                tags: c.tags ?? [],
            });
        }
        // Add dynamically registered tools not already covered by declarations
        for (const [name, handle] of this.toolNameToHandle.entries()) {
            if (!result.has(name)) {
                const metadata = this.registeredToolMetadata.get(handle);
                if (metadata) {
                    result.set(name, {
                        name: metadata.name,
                        description: metadata.description ?? '',
                        inputSchema: metadata.inputSchema,
                        tags: metadata.tags ?? [],
                    });
                }
            }
        }
        return [...result.values()];
    }
    async $invokeTool(handle, argsString, token) {
        const tool = this.tools.get(handle);
        if (!tool) {
            return { error: `Tool with handle ${handle} not found` };
        }
        try {
            const input = argsString ? JSON.parse(argsString) : {};
            const cancellationToken = token ?? cancellation_1.CancellationToken.None;
            const result = await tool.invoke({ input, toolInvocationToken: undefined }, cancellationToken);
            if (!result) {
                return { content: [] };
            }
            return { content: result.content.map(part => this.convertPartToDto(part)) };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { error: errorMessage };
        }
    }
    convertPartToDto(part) {
        if (this.isTextPart(part)) {
            return { type: 'text', value: part.value };
        }
        if (this.isDataPart(part)) {
            const base64 = (0, lm_tool_protocol_1.uint8ArrayToBase64)(part.data);
            return { type: 'data', base64, mimeType: part.mimeType };
        }
        if (this.isPromptTsxPart(part)) {
            return { type: 'prompt-tsx', value: part.value };
        }
        return { type: 'unknown', json: JSON.stringify(part) };
    }
    isTextPart(part) {
        return typeof part === 'object' && part !== undefined
            && 'value' in part && typeof part.value === 'string'
            && !('data' in part) && !('mimeType' in part);
    }
    isDataPart(part) {
        return typeof part === 'object' && part !== undefined
            && 'data' in part && 'mimeType' in part
            && typeof part.mimeType === 'string';
    }
    isPromptTsxPart(part) {
        return typeof part === 'object' && part !== undefined
            && 'value' in part && typeof part.value !== 'string'
            && !('data' in part) && !('mimeType' in part);
    }
    convertDtoToApiPart(part) {
        switch (part.type) {
            case 'text':
                return new types_impl_1.LanguageModelTextPart(part.value);
            case 'data':
                return new types_impl_1.LanguageModelDataPart((0, lm_tool_protocol_1.base64ToUint8Array)(part.base64), part.mimeType);
            case 'prompt-tsx':
                return new types_impl_1.LanguageModelPromptTsxPart(part.value);
            case 'unknown':
                return new types_impl_1.LanguageModelTextPart(part.json);
        }
    }
}
exports.LanguageModelToolsExtImpl = LanguageModelToolsExtImpl;
//# sourceMappingURL=lm-tool-ext.js.map