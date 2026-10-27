"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolInvocationRegistryImpl = exports.ToolProvider = exports.ToolInvocationRegistry = void 0;
exports.bindToolProvider = bindToolProvider;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
exports.ToolInvocationRegistry = Symbol('ToolInvocationRegistry');
exports.ToolProvider = Symbol('ToolProvider');
/** Binds the identifier to self in singleton scope and then binds `ToolProvider` to that service. */
function bindToolProvider(identifier, bind) {
    bind(identifier).toSelf().inSingletonScope();
    bind(exports.ToolProvider).toService(identifier);
}
let ToolInvocationRegistryImpl = class ToolInvocationRegistryImpl {
    constructor() {
        this.tools = new Map();
        this.onDidChangeEmitter = new core_1.Emitter();
        this.onDidChange = this.onDidChangeEmitter.event;
    }
    init() {
        this.providers.getContributions().forEach(provider => {
            this.registerTool(provider.getTool());
        });
    }
    unregisterTool(toolId) {
        if (this.tools.delete(toolId)) {
            this.onDidChangeEmitter.fire();
        }
    }
    unregisterAllTools(providerName) {
        const toolsToRemove = [];
        for (const [id, tool] of this.tools.entries()) {
            if (tool.providerName === providerName) {
                toolsToRemove.push(id);
            }
        }
        let changed = false;
        toolsToRemove.forEach(id => {
            if (this.tools.delete(id)) {
                changed = true;
            }
        });
        if (changed) {
            this.onDidChangeEmitter.fire();
        }
    }
    getAllFunctions() {
        return Array.from(this.tools.values());
    }
    registerTool(tool) {
        if (this.tools.has(tool.id)) {
            this.logger.warn(`Function with id ${tool.id} is already registered.`);
        }
        else {
            this.tools.set(tool.id, tool);
            this.onDidChangeEmitter.fire();
        }
    }
    getFunction(toolId) {
        return this.tools.get(toolId);
    }
    getFunctions(...toolIds) {
        const tools = toolIds.map(toolId => {
            const tool = this.tools.get(toolId);
            if (tool) {
                return tool;
            }
            else {
                throw new Error(`Function with id ${toolId} does not exist.`);
            }
        });
        return tools;
    }
};
exports.ToolInvocationRegistryImpl = ToolInvocationRegistryImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ContributionProvider),
    (0, inversify_1.named)(exports.ToolProvider),
    tslib_1.__metadata("design:type", Object)
], ToolInvocationRegistryImpl.prototype, "providers", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:ToolInvocationRegistryImpl'),
    tslib_1.__metadata("design:type", Object)
], ToolInvocationRegistryImpl.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ToolInvocationRegistryImpl.prototype, "init", null);
exports.ToolInvocationRegistryImpl = ToolInvocationRegistryImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ToolInvocationRegistryImpl);
//# sourceMappingURL=tool-invocation-registry.js.map