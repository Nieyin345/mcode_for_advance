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
exports.GenericCapabilitiesPromptFragmentContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const prompt_service_1 = require("../common/prompt-service");
const capability_utils_1 = require("../common/capability-utils");
const common_1 = require("../common");
const SKILLS_TEMPLATE = `## Skills
The following skills are available. Evaluate which skills apply to the current context and load applicable skills using getSkillFileContent before proceeding.
{{selected_skills}}`;
const MCP_FUNCTIONS_TEMPLATE = `## MCP Functions
{{selected_mcp_functions}}`;
const FUNCTIONS_TEMPLATE = `## Functions
{{selected_functions}}`;
const PROMPT_FRAGMENTS_TEMPLATE = `## Prompt Fragments
{{selected_prompt_fragments}}`;
const AGENT_DELEGATION_TEMPLATE = `## Agent Delegation
You can use ~{${common_1.AGENT_DELEGATION_FUNCTION_ID}} to delegate to the following agents:
{{selected_agent_delegation}}`;
const VARIABLES_TEMPLATE = `## Variables
{{selected_variables}}`;
/**
 * Contribution that registers prompt fragments for each generic capability type.
 * These fragments are dynamically added to agent prompts based on user selections
 * from the chat UI dropdowns.
 */
let GenericCapabilitiesPromptFragmentContribution = class GenericCapabilitiesPromptFragmentContribution {
    onStart() {
        this.promptService.addBuiltInPromptFragment({
            id: capability_utils_1.GENERIC_CAPABILITIES_SKILLS_PROMPT_ID,
            template: SKILLS_TEMPLATE,
        });
        this.promptService.addBuiltInPromptFragment({
            id: capability_utils_1.GENERIC_CAPABILITIES_MCP_FUNCTIONS_PROMPT_ID,
            template: MCP_FUNCTIONS_TEMPLATE,
        });
        this.promptService.addBuiltInPromptFragment({
            id: capability_utils_1.GENERIC_CAPABILITIES_FUNCTIONS_PROMPT_ID,
            template: FUNCTIONS_TEMPLATE,
        });
        this.promptService.addBuiltInPromptFragment({
            id: capability_utils_1.GENERIC_CAPABILITIES_PROMPT_FRAGMENTS_PROMPT_ID,
            template: PROMPT_FRAGMENTS_TEMPLATE,
        });
        this.promptService.addBuiltInPromptFragment({
            id: capability_utils_1.GENERIC_CAPABILITIES_AGENT_DELEGATION_PROMPT_ID,
            template: AGENT_DELEGATION_TEMPLATE,
        });
        this.promptService.addBuiltInPromptFragment({
            id: capability_utils_1.GENERIC_CAPABILITIES_VARIABLES_PROMPT_ID,
            template: VARIABLES_TEMPLATE,
        });
    }
};
exports.GenericCapabilitiesPromptFragmentContribution = GenericCapabilitiesPromptFragmentContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(prompt_service_1.PromptService),
    tslib_1.__metadata("design:type", Object)
], GenericCapabilitiesPromptFragmentContribution.prototype, "promptService", void 0);
exports.GenericCapabilitiesPromptFragmentContribution = GenericCapabilitiesPromptFragmentContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], GenericCapabilitiesPromptFragmentContribution);
//# sourceMappingURL=generic-capabilities-prompt-fragment-contribution.js.map