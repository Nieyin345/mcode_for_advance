"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource
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
exports.LanguageModelToolsMainImpl = void 0;
const lm_tool_protocol_1 = require("../../common/lm-tool-protocol");
const buffer_1 = require("@theia/core/lib/common/buffer");
const plugin_api_rpc_1 = require("../../common/plugin-api-rpc");
const common_1 = require("@theia/ai-core/lib/common");
const language_model_1 = require("@theia/ai-core/lib/common/language-model");
class LanguageModelToolsMainImpl {
    constructor(rpc, container) {
        this.toolHandleToName = new Map();
        this.proxy = rpc.getProxy(plugin_api_rpc_1.MAIN_RPC_CONTEXT.LM_TOOLS_EXT);
        try {
            this.toolInvocationRegistry = container.get(common_1.ToolInvocationRegistry);
        }
        catch {
            this.toolInvocationRegistry = undefined;
        }
    }
    async $registerTool(handle, name, metadata, pluginId) {
        if (!this.toolInvocationRegistry) {
            console.warn('ToolInvocationRegistry not available - tool will not be registered');
            return;
        }
        if (this.toolInvocationRegistry.getFunction(name)) {
            throw new Error(`Tool '${name}' is already registered.`);
        }
        const parameters = language_model_1.ToolRequest.isToolRequestParameters(metadata.inputSchema)
            ? metadata.inputSchema
            : { type: 'object', properties: {} };
        // Note: metadata.tags is not forwarded to ToolRequest as ToolRequest has no tags field.
        // Tags are exposed to extensions on the Ext side via lm.tools (LanguageModelToolInformation).
        const toolRequest = {
            id: name,
            name: name,
            providerName: `plugin_lm_tools_${pluginId}`,
            description: metadata.description,
            parameters,
            handler: async (argString, ctx) => {
                const result = await this.proxy.$invokeTool(handle, argString, ctx?.cancellationToken);
                if ((0, lm_tool_protocol_1.isToolInvocationError)(result)) {
                    return (0, language_model_1.createToolCallError)(result.error);
                }
                const content = result.content.map(part => this.convertDtoToToolCallResult(part));
                return { content };
            }
        };
        this.toolHandleToName.set(handle, name);
        this.toolInvocationRegistry.registerTool(toolRequest);
    }
    $unregisterTool(handle) {
        if (!this.toolInvocationRegistry) {
            return;
        }
        const name = this.toolHandleToName.get(handle);
        if (name) {
            this.toolInvocationRegistry.unregisterTool(name);
            this.toolHandleToName.delete(handle);
        }
    }
    convertDtoToToolCallResult(part) {
        switch (part.type) {
            case 'text':
                return { type: 'text', text: part.value };
            case 'data':
                return this.convertDataPart(part.base64, part.mimeType);
            case 'prompt-tsx':
                return { type: 'text', text: JSON.stringify(part.value) };
            case 'unknown':
                return { type: 'text', text: part.json };
        }
    }
    convertDataPart(base64, mimeType) {
        if (mimeType.startsWith('image/')) {
            return { type: 'image', base64data: base64, mimeType };
        }
        if (mimeType.startsWith('audio/')) {
            return { type: 'audio', data: base64, mimeType };
        }
        // Text-like MIME types: decode base64 to string
        const decoded = buffer_1.BinaryBuffer.wrap((0, lm_tool_protocol_1.base64ToUint8Array)(base64)).toString();
        return { type: 'text', text: decoded };
    }
}
exports.LanguageModelToolsMainImpl = LanguageModelToolsMainImpl;
//# sourceMappingURL=lm-tool-main.js.map