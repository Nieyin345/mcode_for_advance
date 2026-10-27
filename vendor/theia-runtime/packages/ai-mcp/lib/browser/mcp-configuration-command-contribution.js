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
exports.MCPConfigurationCommandContribution = exports.ADD_MCP_SERVER_COMMAND = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const inversify_1 = require("@theia/core/shared/inversify");
const mcp_server_editor_1 = require("./mcp-server-editor");
/**
 * Public command id for opening the "Add MCP Server" dialog. Exposed as a string
 * so consumers (e.g. `@theia/ai-registry`) can trigger it without depending on
 * `@theia/ai-mcp`'s implementation details.
 */
exports.ADD_MCP_SERVER_COMMAND = core_1.Command.toLocalizedCommand({
    id: 'aiConfiguration.mcp.addServer',
    label: 'Add local MCP config...',
    category: 'AI'
}, 'theia/ai/mcpConfiguration/command/addServer');
let MCPConfigurationCommandContribution = class MCPConfigurationCommandContribution {
    registerCommands(commands) {
        commands.registerCommand(exports.ADD_MCP_SERVER_COMMAND, {
            execute: () => this.editor.openAddServer()
        });
    }
};
exports.MCPConfigurationCommandContribution = MCPConfigurationCommandContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(mcp_server_editor_1.MCPServerEditor),
    tslib_1.__metadata("design:type", Object)
], MCPConfigurationCommandContribution.prototype, "editor", void 0);
exports.MCPConfigurationCommandContribution = MCPConfigurationCommandContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPConfigurationCommandContribution);
//# sourceMappingURL=mcp-configuration-command-contribution.js.map