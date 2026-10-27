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
exports.GenericCapabilitiesVariableContribution = exports.SELECTED_VARIABLES_VARIABLE = exports.SELECTED_AGENT_DELEGATION_VARIABLE = exports.SELECTED_PROMPT_FRAGMENTS_VARIABLE = exports.SELECTED_FUNCTIONS_VARIABLE = exports.SELECTED_MCP_FUNCTIONS_VARIABLE = exports.SELECTED_SKILLS_VARIABLE = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../common");
const prompt_variable_contribution_1 = require("./prompt-variable-contribution");
const skill_service_1 = require("./skill-service");
const skills_variable_contribution_1 = require("./skills-variable-contribution");
/**
 * Variable IDs for generic capability selections.
 * These variables resolve to lists of selected items from the chat UI dropdowns.
 */
exports.SELECTED_SKILLS_VARIABLE = {
    id: 'selected_skills',
    name: 'selected_skills',
    description: 'Returns the list of user-selected skills from the capabilities panel'
};
exports.SELECTED_MCP_FUNCTIONS_VARIABLE = {
    id: 'selected_mcp_functions',
    name: 'selected_mcp_functions',
    description: 'Returns the list of user-selected MCP functions from the capabilities panel'
};
exports.SELECTED_FUNCTIONS_VARIABLE = {
    id: 'selected_functions',
    name: 'selected_functions',
    description: 'Returns the list of user-selected functions from the capabilities panel'
};
exports.SELECTED_PROMPT_FRAGMENTS_VARIABLE = {
    id: 'selected_prompt_fragments',
    name: 'selected_prompt_fragments',
    description: 'Returns the list of user-selected prompt fragments from the capabilities panel'
};
exports.SELECTED_AGENT_DELEGATION_VARIABLE = {
    id: 'selected_agent_delegation',
    name: 'selected_agent_delegation',
    description: 'Returns the list of user-selected agents for delegation from the capabilities panel'
};
exports.SELECTED_VARIABLES_VARIABLE = {
    id: 'selected_variables',
    name: 'selected_variables',
    description: 'Returns the list of user-selected variables from the capabilities panel'
};
const GENERIC_CAPABILITY_VARIABLES = [
    exports.SELECTED_SKILLS_VARIABLE,
    exports.SELECTED_MCP_FUNCTIONS_VARIABLE,
    exports.SELECTED_FUNCTIONS_VARIABLE,
    exports.SELECTED_PROMPT_FRAGMENTS_VARIABLE,
    exports.SELECTED_AGENT_DELEGATION_VARIABLE,
    exports.SELECTED_VARIABLES_VARIABLE
];
/**
 * Contribution that registers variables for resolving user-selected generic capabilities.
 * These variables read from the genericCapabilitySelections field in the context
 * and delegate resolution to the respective variable contributions.
 */
let GenericCapabilitiesVariableContribution = class GenericCapabilitiesVariableContribution {
    registerVariables(service) {
        for (const variable of GENERIC_CAPABILITY_VARIABLES) {
            service.registerResolver(variable, this);
        }
    }
    canResolve(request, _context) {
        if (GENERIC_CAPABILITY_VARIABLES.some(v => v.name === request.variable.name)) {
            return 1;
        }
        return -1;
    }
    async resolve(request, context, resolveDependency) {
        const selections = common_1.CapabilityAwareContext.is(context) ? context.genericCapabilitySelections : undefined;
        if (!selections) {
            return { variable: request.variable, value: '' };
        }
        switch (request.variable.name) {
            case exports.SELECTED_SKILLS_VARIABLE.name:
                return this.resolveSelectedSkills(request.variable, selections.skills);
            case exports.SELECTED_MCP_FUNCTIONS_VARIABLE.name:
                return this.resolveSelectedFunctions(request.variable, selections.mcpFunctions);
            case exports.SELECTED_FUNCTIONS_VARIABLE.name:
                return this.resolveSelectedFunctions(request.variable, selections.functions);
            case exports.SELECTED_PROMPT_FRAGMENTS_VARIABLE.name:
                return this.resolveSelectedPromptFragments(request.variable, selections.promptFragments, context, resolveDependency);
            case exports.SELECTED_AGENT_DELEGATION_VARIABLE.name:
                return this.resolveSelectedAgentDelegation(request.variable, selections.agentDelegation);
            case exports.SELECTED_VARIABLES_VARIABLE.name:
                return this.resolveSelectedVariables(request.variable, selections.variables, context, resolveDependency);
            default:
                return undefined;
        }
    }
    /**
     * Resolves selected skills using SkillsVariableContribution.resolveSkillsVariable().
     */
    resolveSelectedSkills(variable, skillIds) {
        if (!skillIds || skillIds.length === 0 || !this.skillService || !this.skillsContribution) {
            return { variable, value: '' };
        }
        // Ids come from the capabilities panel, which lists qualified names; `getSkill` also accepts
        // a plain one, so a selection stored before a skill gained a qualifier still resolves.
        const skills = skillIds
            .map(skillId => this.skillService.getSkill(skillId))
            .filter((skill) => skill !== undefined)
            .map(skill => this.skillsContribution.toSkillSummary(skill));
        return this.skillsContribution.resolveSkillsVariable(skills, variable);
    }
    /**
     * Resolves selected functions by outputting ~{functionId} syntax.
     * The chat request parser will pick these up and add them to the toolRequests map.
     */
    resolveSelectedFunctions(variable, functionIds) {
        if (!functionIds || functionIds.length === 0 || !this.toolInvocationRegistry) {
            return { variable, value: '' };
        }
        // Filter out stale/orphaned tool IDs that no longer exist in the registry
        const validIds = functionIds
            .filter(id => this.toolInvocationRegistry.getFunction(id) !== undefined);
        if (validIds.length === 0) {
            return { variable, value: '' };
        }
        // Output function references in ~{id} format so the chat parser picks them up
        const functionRefs = validIds.map(id => `~{${id}}`).join('\n');
        return { variable, value: functionRefs };
    }
    /**
     * Resolves selected prompt fragments using PromptVariableContribution.resolvePromptFragments().
     */
    async resolveSelectedPromptFragments(variable, fragmentIds, context, resolveDependency) {
        if (!fragmentIds || fragmentIds.length === 0 || !this.promptContribution) {
            return { variable, value: '', allResolvedDependencies: [] };
        }
        return this.promptContribution.resolvePromptFragments(fragmentIds, variable, context, resolveDependency);
    }
    /**
     * Resolves selected agents for delegation using AgentsVariableContribution.resolveAgentsVariable().
     */
    resolveSelectedAgentDelegation(variable, agentIds) {
        if (!agentIds || agentIds.length === 0 || !this.agentService || !this.agentsContribution) {
            return { variable, value: '' };
        }
        const allAgents = this.agentService.getAgents();
        const agents = agentIds
            .map(agentId => allAgents.find(a => a.id === agentId))
            .filter((agent) => agent !== undefined);
        return this.agentsContribution.resolveAgentsVariable(agents, variable);
    }
    /**
     * Resolves selected variables using AIVariableService.resolveVariable().
     */
    async resolveSelectedVariables(variable, variableNames, context, resolveDependency) {
        if (!variableNames || variableNames.length === 0 || !this.variableService) {
            return { variable, value: '', allResolvedDependencies: [] };
        }
        const resolvedValues = [];
        const allDependencies = [];
        for (const variableName of variableNames) {
            const aiVariable = this.variableService.getVariable(variableName);
            if (aiVariable) {
                // Use resolveDependency if provided (for proper caching), otherwise use variableService directly
                const resolved = resolveDependency
                    ? await resolveDependency({ variable: aiVariable.name })
                    : await this.variableService.resolveVariable({ variable: aiVariable }, context);
                if (resolved && resolved.value) {
                    resolvedValues.push(`### ${aiVariable.name}\n${resolved.value}`);
                    allDependencies.push(resolved);
                    if (resolved.allResolvedDependencies) {
                        allDependencies.push(...resolved.allResolvedDependencies);
                    }
                }
            }
        }
        return {
            variable,
            value: resolvedValues.join('\n\n'),
            allResolvedDependencies: allDependencies
        };
    }
};
exports.GenericCapabilitiesVariableContribution = GenericCapabilitiesVariableContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(skills_variable_contribution_1.SkillsVariableContribution),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], GenericCapabilitiesVariableContribution.prototype, "skillsContribution", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(skill_service_1.SkillService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], GenericCapabilitiesVariableContribution.prototype, "skillService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.AIVariableService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], GenericCapabilitiesVariableContribution.prototype, "variableService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.AgentService),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], GenericCapabilitiesVariableContribution.prototype, "agentService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.AgentsVariableContribution),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], GenericCapabilitiesVariableContribution.prototype, "agentsContribution", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ToolInvocationRegistry),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], GenericCapabilitiesVariableContribution.prototype, "toolInvocationRegistry", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(prompt_variable_contribution_1.PromptVariableContribution),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], GenericCapabilitiesVariableContribution.prototype, "promptContribution", void 0);
exports.GenericCapabilitiesVariableContribution = GenericCapabilitiesVariableContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], GenericCapabilitiesVariableContribution);
//# sourceMappingURL=generic-capabilities-variable-contribution.js.map