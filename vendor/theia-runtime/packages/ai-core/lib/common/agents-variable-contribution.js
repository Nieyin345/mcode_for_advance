"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentsVariableContribution = exports.AGENTS_VARIABLE = void 0;
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
const agent_service_1 = require("./agent-service");
exports.AGENTS_VARIABLE = {
    id: 'agents',
    name: 'agents',
    description: core_1.nls.localize('theia/ai/core/agentsVariable/description', 'Returns the list of agents available in the system')
};
let AgentsVariableContribution = class AgentsVariableContribution {
    registerVariables(service) {
        service.registerResolver(exports.AGENTS_VARIABLE, this);
    }
    canResolve(request, _context) {
        if (request.variable.name === exports.AGENTS_VARIABLE.name) {
            return 1;
        }
        return -1;
    }
    async resolve(request, context) {
        if (request.variable.name === exports.AGENTS_VARIABLE.name) {
            return this.resolveAgentsVariable(this.agentService.getAgents(), exports.AGENTS_VARIABLE);
        }
    }
    resolveAgentsVariable(includedAgents, variable) {
        const agents = includedAgents.map(agent => ({
            id: agent.id,
            name: agent.name,
            description: agent.description
        }));
        return { variable, agents, value: JSON.stringify(agents) };
    }
};
exports.AgentsVariableContribution = AgentsVariableContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(agent_service_1.AgentService),
    tslib_1.__metadata("design:type", Object)
], AgentsVariableContribution.prototype, "agentService", void 0);
exports.AgentsVariableContribution = AgentsVariableContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AgentsVariableContribution);
//# sourceMappingURL=agents-variable-contribution.js.map