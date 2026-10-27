"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentServiceImpl = exports.AgentService = void 0;
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
const settings_service_1 = require("./settings-service");
const prompt_service_1 = require("./prompt-service");
exports.AgentService = Symbol('AgentService');
let AgentServiceImpl = class AgentServiceImpl {
    constructor() {
        this.disabledAgents = new Set();
        this._agents = [];
        this.onDidChangeAgentsEmitter = new core_1.Emitter();
        this.onDidChangeAgents = this.onDidChangeAgentsEmitter.event;
    }
    init() {
        this.aiSettingsService?.getSettings().then(settings => {
            Object.entries(settings).forEach(([agentId, agentSettings]) => {
                if (agentSettings.enable === false) {
                    this.disabledAgents.add(agentId);
                }
            });
            this.onDidChangeAgentsEmitter.fire();
        });
    }
    registerAgent(agent) {
        this._agents.push(agent);
        this._agents.sort((a, b) => a.name.localeCompare(b.name));
        agent.prompts.forEach(prompt => {
            this.promptService.addBuiltInPromptFragment(prompt.defaultVariant, prompt.id, true);
            prompt.variants?.forEach(variant => {
                this.promptService.addBuiltInPromptFragment(variant, prompt.id);
            });
        });
        this.onDidChangeAgentsEmitter.fire();
    }
    unregisterAgent(agentId) {
        const agent = this._agents.find(a => a.id === agentId);
        this._agents = this._agents.filter(a => a.id !== agentId);
        this.onDidChangeAgentsEmitter.fire();
        agent?.prompts.forEach(prompt => {
            this.promptService.removePromptFragment(prompt.defaultVariant.id);
            prompt.variants?.forEach(variant => {
                this.promptService.removePromptFragment(variant.id);
            });
        });
    }
    getAgents() {
        return this._agents.filter(agent => this.isEnabled(agent.id));
    }
    getAllAgents() {
        return this._agents;
    }
    async enableAgent(agentId) {
        this.disabledAgents.delete(agentId);
        await this.aiSettingsService?.updateAgentSettings(agentId, { enable: true });
        this.onDidChangeAgentsEmitter.fire();
    }
    async disableAgent(agentId) {
        this.disabledAgents.add(agentId);
        await this.aiSettingsService?.updateAgentSettings(agentId, { enable: false });
        this.onDidChangeAgentsEmitter.fire();
    }
    isEnabled(agentId) {
        return !this.disabledAgents.has(agentId);
    }
};
exports.AgentServiceImpl = AgentServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(settings_service_1.AISettingsService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], AgentServiceImpl.prototype, "aiSettingsService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(prompt_service_1.PromptService),
    tslib_1.__metadata("design:type", Object)
], AgentServiceImpl.prototype, "promptService", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], AgentServiceImpl.prototype, "init", null);
exports.AgentServiceImpl = AgentServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AgentServiceImpl);
//# sourceMappingURL=agent-service.js.map