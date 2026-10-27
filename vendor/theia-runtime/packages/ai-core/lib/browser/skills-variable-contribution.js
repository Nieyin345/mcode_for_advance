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
exports.SkillsVariableContribution = exports.SKILL_VARIABLE = exports.SKILLS_VARIABLE = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const skill_service_1 = require("./skill-service");
const skill_1 = require("../common/skill");
exports.SKILLS_VARIABLE = {
    id: 'skills',
    name: 'skills',
    description: core_1.nls.localize('theia/ai/core/skillsVariable/description', 'Returns the list of available skills that can be used by AI agents')
};
exports.SKILL_VARIABLE = {
    id: 'skill',
    name: 'skill',
    description: 'Returns the content of a specific skill by name',
    args: [{ name: 'skillName', description: 'The name of the skill to load' }]
};
let SkillsVariableContribution = class SkillsVariableContribution {
    registerVariables(service) {
        service.registerResolver(exports.SKILLS_VARIABLE, this);
        service.registerResolver(exports.SKILL_VARIABLE, this);
    }
    canResolve(request, _context) {
        if (request.variable.name === exports.SKILLS_VARIABLE.name || request.variable.name === exports.SKILL_VARIABLE.name) {
            return 1;
        }
        return -1;
    }
    async resolve(request, _context) {
        // Handle singular skill variable with argument
        if (request.variable.name === exports.SKILL_VARIABLE.name) {
            return this.resolveSingleSkill(request);
        }
        // Handle plural skills variable
        if (request.variable.name === exports.SKILLS_VARIABLE.name) {
            return this.resolveSkillsVariable(this.skillService.getSkills().map(skill => this.toSkillSummary(skill)), exports.SKILLS_VARIABLE);
        }
        return undefined;
    }
    /** Named by {@link Skill.qualifiedName}: that is what the model has to write to load it again. */
    toSkillSummary(skill) {
        return {
            name: skill.qualifiedName,
            description: skill.description,
            location: skill.location
        };
    }
    /**
     * Resolves skills into a ResolvedSkillsVariable with XML format.
     */
    resolveSkillsVariable(includedSkills, variable) {
        this.logger.debug(`SkillsVariableContribution: Resolving skills variable, found ${includedSkills.length} skills`);
        const xmlValue = this.generateSkillsXML(includedSkills);
        this.logger.debug(`SkillsVariableContribution: Generated XML:\n${xmlValue}`);
        return { variable, skills: includedSkills, value: xmlValue };
    }
    async resolveSingleSkill(request) {
        const skillName = request.arg;
        if (!skillName) {
            this.logger.warn('skill variable requires a skill name argument');
            return undefined;
        }
        const skill = this.skillService.getSkill(skillName);
        if (!skill) {
            this.logger.warn(`Skill not found: ${skillName}`);
            return undefined;
        }
        try {
            const skillFileUri = core_1.URI.fromFilePath(skill.location);
            const fileContent = await this.fileService.read(skillFileUri);
            const parsed = (0, skill_1.parseSkillFile)(fileContent.value);
            return {
                variable: request.variable,
                value: parsed.content
            };
        }
        catch (error) {
            this.logger.error(`Failed to load skill content for '${skillName}': ${error}`);
            return undefined;
        }
    }
    /**
     * Generates XML representation of skills.
     * XML format follows the Agent Skills spec for structured skill representation.
     * This method is public to allow reuse by GenericCapabilitiesVariableContribution.
     */
    generateSkillsXML(skills) {
        if (skills.length === 0) {
            return '<available_skills>\n</available_skills>';
        }
        const skillElements = skills.map(skill => '<skill>\n' +
            `<name>${this.escapeXml(skill.name)}</name>\n` +
            `<description>${this.escapeXml(skill.description)}</description>\n` +
            `<location>${this.escapeXml(skill.location)}</location>\n` +
            '</skill>').join('\n');
        return `<available_skills>\n${skillElements}\n</available_skills>`;
    }
    escapeXml(text) {
        const QUOT = '&quot;';
        const APOS = '&apos;';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, QUOT)
            .replace(/'/g, APOS);
    }
};
exports.SkillsVariableContribution = SkillsVariableContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(skill_service_1.SkillService),
    tslib_1.__metadata("design:type", Object)
], SkillsVariableContribution.prototype, "skillService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('ai-core:SkillsVariableContribution'),
    tslib_1.__metadata("design:type", Object)
], SkillsVariableContribution.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(file_service_1.FileService),
    tslib_1.__metadata("design:type", file_service_1.FileService)
], SkillsVariableContribution.prototype, "fileService", void 0);
exports.SkillsVariableContribution = SkillsVariableContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], SkillsVariableContribution);
//# sourceMappingURL=skills-variable-contribution.js.map