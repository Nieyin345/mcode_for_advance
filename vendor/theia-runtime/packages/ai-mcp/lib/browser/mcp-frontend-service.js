"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPFrontendServiceImpl = void 0;
exports.mapCallContent = mapCallContent;
const tslib_1 = require("tslib");
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
const core_1 = require("@theia/core");
const workspace_trust_service_1 = require("@theia/workspace/lib/browser/workspace-trust-service");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
const ai_core_1 = require("@theia/ai-core");
/**
 * Maps a single MCP call content item to a {@link ToolCallContentResult}.
 * Exported for testability.
 */
function mapCallContent(callContent) {
    const type = callContent.type;
    switch (type) {
        case 'image':
            return { type: 'image', base64data: callContent.data, mimeType: callContent.mimeType };
        case 'text': {
            const text = callContent.text;
            if (text.startsWith('{')) {
                try {
                    const parsed = JSON.parse(text);
                    if ((0, ai_core_1.isToolCallHtmlAppResult)(parsed)) {
                        return { type: 'html', html: parsed.html, title: parsed.title };
                    }
                }
                catch { /* not JSON, fall through */ }
            }
            return { type: 'text', text };
        }
        case 'resource': {
            return { type: 'text', text: JSON.stringify(callContent.resource) };
        }
        default: {
            if ('html' in callContent && typeof callContent.html === 'string') {
                return { type: 'html', html: callContent.html, title: callContent.title };
            }
            return { type: 'text', text: JSON.stringify(callContent) };
        }
    }
}
let MCPFrontendServiceImpl = class MCPFrontendServiceImpl {
    /**
     * Non-interactive start. The backend OAuth provider rejects `redirectToAuthorization`, so this
     * path cannot launch a browser tab. Use {@link startServerInteractive} for direct user actions.
     */
    async startServer(serverName) {
        await this.mcpServerManager.startServer(serverName);
        await this.registerTools(serverName);
    }
    async startServerInteractive(serverName) {
        const description = await this.mcpServerManager.getServerDescription(serverName);
        const usesOAuth = description && (0, mcp_server_manager_1.isRemoteMCPServerDescription)(description) && !!description.oauth;
        if (usesOAuth && !await this.workspaceTrustService.getWorkspaceTrust()) {
            this.messageService.error(core_1.nls.localize('theia/ai/mcp/error/oauthRequiresTrustedWorkspace', 'Starting OAuth-enabled MCP servers requires a trusted workspace.'));
            return false;
        }
        // Pass `interactive: true` so the OAuth provider permits `redirectToAuthorization` to launch
        // the browser. The non-interactive default rejects authorization, keeping autostart silent.
        await this.mcpServerManager.startServer(serverName, { interactive: true });
        await this.registerTools(serverName);
        return true;
    }
    async signIn(serverName) {
        const description = await this.mcpServerManager.getServerDescription(serverName);
        if (!description || !(0, mcp_server_manager_1.isRemoteMCPServerDescription)(description) || !description.oauth) {
            return false;
        }
        if (!await this.workspaceTrustService.getWorkspaceTrust()) {
            this.messageService.error(core_1.nls.localize('theia/ai/mcp/error/oauthRequiresTrustedWorkspace', 'Starting OAuth-enabled MCP servers requires a trusted workspace.'));
            return false;
        }
        // Stop first so a stale in-flight authorization wait is cancelled and a fresh flow starts.
        await this.mcpServerManager.stopServer(serverName);
        await this.mcpServerManager.startServer(serverName, { interactive: true });
        const afterStart = await this.mcpServerManager.getServerDescription(serverName);
        const connected = afterStart?.status === mcp_server_manager_1.MCPServerStatus.Connected || afterStart?.status === mcp_server_manager_1.MCPServerStatus.Running;
        if (connected) {
            // Sign-in only: leave the server stopped. The tokens remain in the credential store.
            await this.mcpServerManager.stopServer(serverName);
        }
        return connected;
    }
    async hasServer(serverName) {
        const serverNames = await this.getServerNames();
        return serverNames.includes(serverName);
    }
    async isServerStarted(serverName) {
        const startedServers = await this.getStartedServers();
        return startedServers.includes(serverName);
    }
    async registerToolsForAllStartedServers() {
        const startedServers = await this.getStartedServers();
        for (const serverName of startedServers) {
            await this.registerTools(serverName);
        }
    }
    async registerTools(serverName) {
        const returnedTools = await this.getTools(serverName);
        this.unregisterTools(serverName);
        if (returnedTools) {
            const toolRequests = returnedTools.tools.map(tool => this.convertToToolRequest(tool, serverName));
            toolRequests.forEach(toolRequest => this.toolInvocationRegistry.registerTool(toolRequest));
            const description = await this.mcpServerManager.getServerDescription(serverName);
            this.createPromptTemplate(serverName, toolRequests, description?.deferLoading === true);
        }
    }
    getPromptTemplateId(serverName) {
        return `mcp_${serverName}_tools`;
    }
    unregisterTools(serverName) {
        this.toolInvocationRegistry.unregisterAllTools(`mcp_${serverName}`);
        this.promptService.removePromptFragment(this.getPromptTemplateId(serverName));
    }
    createPromptTemplate(serverName, toolRequests, deferLoading = false) {
        const templateId = this.getPromptTemplateId(serverName);
        const marker = deferLoading ? '?' : '';
        const functionIds = toolRequests.map(tool => `~{${marker}${tool.id}}`);
        const template = functionIds.join('\n');
        this.promptService.addBuiltInPromptFragment({
            id: templateId,
            template
        });
    }
    async stopServer(serverName) {
        this.unregisterTools(serverName);
        await this.mcpServerManager.stopServer(serverName);
    }
    async signOut(serverName) {
        this.unregisterTools(serverName);
        await this.mcpServerManager.signOut(serverName);
    }
    hasStoredOAuthCredentials(serverName) {
        return this.mcpServerManager.hasStoredOAuthCredentials(serverName);
    }
    getStartedServers() {
        return this.mcpServerManager.getRunningServers();
    }
    getActiveServers() {
        return this.mcpServerManager.getActiveServers();
    }
    getServerNames() {
        return this.mcpServerManager.getServerNames();
    }
    async getServerDescription(name) {
        return this.mcpServerManager.getServerDescription(name);
    }
    async getTools(serverName) {
        try {
            return await this.mcpServerManager.getTools(serverName);
        }
        catch (error) {
            this.logger.error('Error while trying to get tools: ' + error);
            return undefined;
        }
    }
    async addOrUpdateServer(description) {
        return this.mcpServerManager.addOrUpdateServer(description);
    }
    convertToToolRequest(tool, serverName) {
        const id = `mcp_${serverName}_${tool.name}`;
        return {
            id: id,
            name: id,
            providerName: `mcp_${serverName}`,
            parameters: ai_core_1.ToolRequest.isToolRequestParameters(tool.inputSchema) ? {
                type: tool.inputSchema.type,
                properties: tool.inputSchema.properties,
                required: tool.inputSchema.required
            } : {
                type: 'object',
                properties: {}
            },
            description: tool.description,
            handler: async (arg_string) => {
                try {
                    const result = await this.mcpServerManager.callTool(serverName, tool.name, arg_string);
                    if (result.isError) {
                        const textContent = result.content.find(callContent => callContent.type === 'text');
                        return { content: [{ type: 'error', data: textContent?.text ?? 'Unknown Error' }] };
                    }
                    const content = result.content.map(callContent => mapCallContent(callContent));
                    return { content };
                }
                catch (error) {
                    this.logger.error(`Error in tool handler for ${tool.name} on MCP server ${serverName}:`, error);
                    throw error;
                }
            },
        };
    }
};
exports.MCPFrontendServiceImpl = MCPFrontendServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPServerManager),
    tslib_1.__metadata("design:type", Object)
], MCPFrontendServiceImpl.prototype, "mcpServerManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_core_1.ToolInvocationRegistry),
    tslib_1.__metadata("design:type", Object)
], MCPFrontendServiceImpl.prototype, "toolInvocationRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(ai_core_1.PromptService),
    tslib_1.__metadata("design:type", Object)
], MCPFrontendServiceImpl.prototype, "promptService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:MCPFrontendServiceImpl'),
    tslib_1.__metadata("design:type", Object)
], MCPFrontendServiceImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(workspace_trust_service_1.WorkspaceTrustService),
    tslib_1.__metadata("design:type", workspace_trust_service_1.WorkspaceTrustService)
], MCPFrontendServiceImpl.prototype, "workspaceTrustService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.MessageService),
    tslib_1.__metadata("design:type", core_1.MessageService)
], MCPFrontendServiceImpl.prototype, "messageService", void 0);
exports.MCPFrontendServiceImpl = MCPFrontendServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPFrontendServiceImpl);
//# sourceMappingURL=mcp-frontend-service.js.map