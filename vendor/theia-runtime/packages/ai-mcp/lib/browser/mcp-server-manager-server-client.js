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
exports.MCPServerManagerServerClientImpl = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const uuid_1 = require("@theia/core/lib/common/uuid");
const mcp_protocol_1 = require("../common/mcp-protocol");
const core_1 = require("@theia/core");
let MCPServerManagerServerClientImpl = class MCPServerManagerServerClientImpl {
    constructor() {
        this.serverDescriptions = new Map();
    }
    addServerDescription(description) {
        if (description.resolve) {
            const serverDescription = {
                ...description,
                resolveId: (0, uuid_1.generateUuid)(),
            };
            // store only the name and resolve function
            if (serverDescription.resolveId) {
                this.serverDescriptions.set(serverDescription.resolveId, {
                    name: description.name,
                    resolve: description.resolve
                });
            }
            return serverDescription;
        }
        return description;
    }
    getResolveFunction(name) {
        for (const storedInfo of this.serverDescriptions.values()) {
            if (storedInfo.name === name) {
                return storedInfo.resolve;
            }
        }
        return undefined;
    }
    async resolveServerDescription(description) {
        const cleanDescription = (0, mcp_protocol_1.cleanServerDescription)(description);
        if (description.resolveId) {
            const storedInfo = this.serverDescriptions.get(description.resolveId);
            if (storedInfo?.resolve) {
                const updated = await storedInfo.resolve(cleanDescription);
                if (updated) {
                    return updated;
                }
            }
        }
        return cleanDescription;
    }
    cleanServers(serverNames) {
        const currentNamesSet = new Set(serverNames);
        // Remove descriptions for servers that no longer exist
        for (const [resolveId, storedInfo] of this.serverDescriptions.entries()) {
            if (storedInfo.name && !currentNamesSet.has(storedInfo.name)) {
                this.logger.debug('Removing a frontend stored resolve function because the corresponding MCP server was removed', storedInfo);
                this.serverDescriptions.delete(resolveId);
            }
        }
    }
};
exports.MCPServerManagerServerClientImpl = MCPServerManagerServerClientImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-mcp:MCPServerManagerServerClientImpl'),
    tslib_1.__metadata("design:type", Object)
], MCPServerManagerServerClientImpl.prototype, "logger", void 0);
exports.MCPServerManagerServerClientImpl = MCPServerManagerServerClientImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MCPServerManagerServerClientImpl);
//# sourceMappingURL=mcp-server-manager-server-client.js.map