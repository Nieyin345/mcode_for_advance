"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH.
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
exports.MCPGenericCapabilitiesContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const mcp_server_manager_1 = require("../common/mcp-server-manager");
/**
 * Contributes MCP tool functions as generic capabilities for selection in the chat UI.
 */
let MCPGenericCapabilitiesContribution = class MCPGenericCapabilitiesContribution {
    constructor() {
        this.capabilityType = 'mcpFunctions';
    }
    get onDidChange() {
        return this.mcpNotificationService.onDidUpdateMCPServers;
    }
    async getAvailableCapabilities() {
        const groups = [];
        const startedServers = await this.mcpFrontendService.getStartedServers();
        for (const serverName of startedServers) {
            const tools = await this.mcpFrontendService.getTools(serverName);
            if (tools?.tools && tools.tools.length > 0) {
                const items = tools.tools.map(tool => ({
                    id: `mcp_${serverName}_${tool.name}`,
                    name: tool.name,
                    group: serverName,
                    description: tool.description
                }));
                groups.push({
                    name: serverName,
                    items
                });
            }
        }
        return groups;
    }
};
exports.MCPGenericCapabilitiesContribution = MCPGenericCapabilitiesContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPFrontendService),
    tslib_1.__metadata("design:type", Object)
], MCPGenericCapabilitiesContribution.prototype, "mcpFrontendService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_manager_1.MCPFrontendNotificationService),
    tslib_1.__metadata("design:type", Object)
], MCPGenericCapabilitiesContribution.prototype, "mcpNotificationService", void 0);
exports.MCPGenericCapabilitiesContribution = MCPGenericCapabilitiesContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPGenericCapabilitiesContribution);
//# sourceMappingURL=mcp-generic-capabilities-contribution.js.map