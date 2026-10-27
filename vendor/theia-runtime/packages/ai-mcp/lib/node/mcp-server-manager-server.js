"use strict";
// *****************************************************************************
// Copyright (C) 2025 Dirk Fauth and others.
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
exports.MCPServerManagerServerImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../common");
const mcp_protocol_1 = require("../common/mcp-protocol");
const core_1 = require("@theia/core");
let MCPServerManagerServerImpl = class MCPServerManagerServerImpl {
    setClient(client) {
        if (this.client && this.client !== client) {
            throw new Error('MCP server manager server is scoped to a single frontend connection.');
        }
        this.client = client;
    }
    disconnectClient(client) {
        if (this.client !== undefined && this.client !== client) {
            this.logger.warn('MCP server manager server received disconnectClient for a non-current client; ignoring (one-client-per-container invariant violation).');
            return;
        }
        if (this.client === client) {
            this.client = undefined;
        }
    }
    async addOrUpdateServer(descriptionRCP) {
        const description = (0, mcp_protocol_1.cleanServerDescription)(descriptionRCP);
        if (descriptionRCP.resolveId) {
            description.resolve = async (desc) => {
                if (this.client) {
                    // Discard `resolve` explicitly: it's a function and must not cross the RPC boundary.
                    const { resolve: _resolve, ...descWithoutResolve } = desc;
                    const descRCP = {
                        ...descWithoutResolve,
                        resolveId: descriptionRCP.resolveId
                    };
                    return this.client.resolveServerDescription(descRCP);
                }
                return desc;
            };
        }
        await this.mcpServerManager.addOrUpdateServer(description);
    }
};
exports.MCPServerManagerServerImpl = MCPServerManagerServerImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.MCPServerManager),
    tslib_1.__metadata("design:type", Object)
], MCPServerManagerServerImpl.prototype, "mcpServerManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:MCPServerManagerServerImpl'),
    tslib_1.__metadata("design:type", Object)
], MCPServerManagerServerImpl.prototype, "logger", void 0);
exports.MCPServerManagerServerImpl = MCPServerManagerServerImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPServerManagerServerImpl);
//# sourceMappingURL=mcp-server-manager-server.js.map