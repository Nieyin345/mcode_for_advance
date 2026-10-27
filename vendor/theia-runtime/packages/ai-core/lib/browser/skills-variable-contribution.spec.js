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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
const core_1 = require("@theia/core");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
require("reflect-metadata");
const chai_1 = require("chai");
const sinon = require("sinon");
const inversify_1 = require("@theia/core/shared/inversify");
const skills_variable_contribution_1 = require("./skills-variable-contribution");
const file_service_1 = require("@theia/filesystem/lib/browser/file-service");
const skill_service_1 = require("./skill-service");
disableJSDOM();
describe('SkillsVariableContribution', () => {
    let contribution;
    let skillService;
    let mockFileService;
    let container;
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        disableJSDOM();
    });
    beforeEach(() => {
        container = new inversify_1.Container();
        skillService = {
            getSkills: sinon.stub(),
            getSkill: sinon.stub(),
            onSkillsChanged: sinon.stub(),
            ready: sinon.stub()
        };
        container.bind(skill_service_1.SkillService).toConstantValue(skillService);
        mockFileService = {
            read: sinon.stub(),
            exists: sinon.stub(),
        };
        container.bind(file_service_1.FileService).toConstantValue(mockFileService);
        const mockLogger = {
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
            debug: sinon.stub(),
            trace: sinon.stub(),
            fatal: sinon.stub(),
            log: sinon.stub(),
            setLogLevel: sinon.stub(),
            getLogLevel: sinon.stub(),
            isEnabled: sinon.stub().returns(true),
            ifEnabled: sinon.stub(),
            child: sinon.stub()
        };
        container.bind(core_1.ILogger).toConstantValue(mockLogger);
        container.bind(skills_variable_contribution_1.SkillsVariableContribution).toSelf().inSingletonScope();
        contribution = container.get(skills_variable_contribution_1.SkillsVariableContribution);
    });
    describe('SKILLS_VARIABLE', () => {
        it('should have correct id and name', () => {
            (0, chai_1.expect)(skills_variable_contribution_1.SKILLS_VARIABLE.id).to.equal('skills');
            (0, chai_1.expect)(skills_variable_contribution_1.SKILLS_VARIABLE.name).to.equal('skills');
        });
        it('should have a description', () => {
            (0, chai_1.expect)(skills_variable_contribution_1.SKILLS_VARIABLE.description).to.be.a('string');
            (0, chai_1.expect)(skills_variable_contribution_1.SKILLS_VARIABLE.description.length).to.be.greaterThan(0);
        });
    });
    describe('SKILL_VARIABLE', () => {
        it('should have correct id and name', () => {
            (0, chai_1.expect)(skills_variable_contribution_1.SKILL_VARIABLE.id).to.equal('skill');
            (0, chai_1.expect)(skills_variable_contribution_1.SKILL_VARIABLE.name).to.equal('skill');
        });
        it('should have args defined', () => {
            (0, chai_1.expect)(skills_variable_contribution_1.SKILL_VARIABLE.args).to.not.be.undefined;
            (0, chai_1.expect)(skills_variable_contribution_1.SKILL_VARIABLE.args).to.have.lengthOf(1);
            (0, chai_1.expect)(skills_variable_contribution_1.SKILL_VARIABLE.args[0].name).to.equal('skillName');
        });
    });
    describe('canResolve', () => {
        it('should return 1 for skills variable', () => {
            const result = contribution.canResolve({ variable: skills_variable_contribution_1.SKILLS_VARIABLE }, {});
            (0, chai_1.expect)(result).to.equal(1);
        });
        it('should return 1 for skill variable', () => {
            const result = contribution.canResolve({ variable: skills_variable_contribution_1.SKILL_VARIABLE }, {});
            (0, chai_1.expect)(result).to.equal(1);
        });
        it('should return -1 for other variables', () => {
            const result = contribution.canResolve({ variable: { id: 'other', name: 'other', description: 'other' } }, {});
            (0, chai_1.expect)(result).to.equal(-1);
        });
    });
    describe('resolve', () => {
        it('should return undefined for non-skills variable', async () => {
            const result = await contribution.resolve({ variable: { id: 'other', name: 'other', description: 'other' } }, {});
            (0, chai_1.expect)(result).to.be.undefined;
        });
        it('should return empty XML when no skills available', async () => {
            skillService.getSkills.returns([]);
            const result = await contribution.resolve({ variable: skills_variable_contribution_1.SKILLS_VARIABLE }, {});
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.variable).to.equal(skills_variable_contribution_1.SKILLS_VARIABLE);
            (0, chai_1.expect)(result.skills).to.deep.equal([]);
            (0, chai_1.expect)(result.value).to.equal('<available_skills>\n</available_skills>');
        });
        it('should return XML with skills when available', async () => {
            const skills = [
                {
                    name: 'pdf-processing',
                    qualifiedName: 'pdf-processing',
                    description: 'Processes PDF documents and extracts text content',
                    location: '/path/to/skills/pdf-processing/SKILL.md'
                },
                {
                    name: 'data-analysis',
                    qualifiedName: 'data-analysis',
                    description: 'Analyzes data sets and generates reports',
                    location: '/path/to/skills/data-analysis/SKILL.md'
                }
            ];
            skillService.getSkills.returns(skills);
            const result = await contribution.resolve({ variable: skills_variable_contribution_1.SKILLS_VARIABLE }, {});
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.variable).to.equal(skills_variable_contribution_1.SKILLS_VARIABLE);
            (0, chai_1.expect)(result.skills).to.have.lengthOf(2);
            (0, chai_1.expect)(result.skills[0].name).to.equal('pdf-processing');
            (0, chai_1.expect)(result.skills[0].location).to.equal('/path/to/skills/pdf-processing/SKILL.md');
            (0, chai_1.expect)(result.skills[1].name).to.equal('data-analysis');
            (0, chai_1.expect)(result.skills[1].location).to.equal('/path/to/skills/data-analysis/SKILL.md');
            const expectedXml = '<available_skills>\n' +
                '<skill>\n' +
                '<name>pdf-processing</name>\n' +
                '<description>Processes PDF documents and extracts text content</description>\n' +
                '<location>/path/to/skills/pdf-processing/SKILL.md</location>\n' +
                '</skill>\n' +
                '<skill>\n' +
                '<name>data-analysis</name>\n' +
                '<description>Analyzes data sets and generates reports</description>\n' +
                '<location>/path/to/skills/data-analysis/SKILL.md</location>\n' +
                '</skill>\n' +
                '</available_skills>';
            (0, chai_1.expect)(result.value).to.equal(expectedXml);
        });
        it('should escape XML special characters in descriptions', async () => {
            const skills = [
                {
                    name: 'test-skill',
                    qualifiedName: 'test-skill',
                    description: 'Handles <tags> & "quotes" with \'apostrophes\'',
                    location: '/path/to/skill/SKILL.md'
                }
            ];
            skillService.getSkills.returns(skills);
            const result = await contribution.resolve({ variable: skills_variable_contribution_1.SKILLS_VARIABLE }, {});
            (0, chai_1.expect)(result.value).to.include('&lt;tags&gt;');
            (0, chai_1.expect)(result.value).to.include('&amp;');
            (0, chai_1.expect)(result.value).to.include('&quot;quotes&quot;');
            (0, chai_1.expect)(result.value).to.include('&apos;apostrophes&apos;');
        });
        it('should escape XML special characters in name and location', async () => {
            const skills = [
                {
                    name: 'skill<test>',
                    qualifiedName: 'skill<test>',
                    description: 'Test skill',
                    location: '/path/with/&special/chars'
                }
            ];
            skillService.getSkills.returns(skills);
            const result = await contribution.resolve({ variable: skills_variable_contribution_1.SKILLS_VARIABLE }, {});
            (0, chai_1.expect)(result.value).to.include('<name>skill&lt;test&gt;</name>');
            (0, chai_1.expect)(result.value).to.include('<location>/path/with/&amp;special/chars</location>');
        });
    });
    describe('resolve single skill', () => {
        it('should return undefined when no arg provided', async () => {
            const result = await contribution.resolve({ variable: skills_variable_contribution_1.SKILL_VARIABLE }, {});
            (0, chai_1.expect)(result).to.be.undefined;
        });
        it('should return undefined when skill not found', async () => {
            skillService.getSkill.returns(undefined);
            const result = await contribution.resolve({ variable: skills_variable_contribution_1.SKILL_VARIABLE, arg: 'non-existent' }, {});
            (0, chai_1.expect)(result).to.be.undefined;
        });
        it('should return skill content when skill found', async () => {
            const skill = {
                name: 'my-skill',
                qualifiedName: 'my-skill',
                description: 'A test skill',
                location: '/path/to/skills/my-skill/SKILL.md'
            };
            skillService.getSkill.withArgs('my-skill').returns(skill);
            mockFileService.read.resolves({
                value: `---
name: my-skill
description: A test skill
---
# My Skill Content

This is the skill content.`
            });
            const result = await contribution.resolve({ variable: skills_variable_contribution_1.SKILL_VARIABLE, arg: 'my-skill' }, {});
            (0, chai_1.expect)(result).to.not.be.undefined;
            (0, chai_1.expect)(result.variable).to.equal(skills_variable_contribution_1.SKILL_VARIABLE);
            (0, chai_1.expect)(result.value).to.equal('# My Skill Content\n\nThis is the skill content.');
        });
        it('should return undefined when file read fails', async () => {
            const skill = {
                name: 'my-skill',
                qualifiedName: 'my-skill',
                description: 'A test skill',
                location: '/path/to/skills/my-skill/SKILL.md'
            };
            skillService.getSkill.withArgs('my-skill').returns(skill);
            mockFileService.read.rejects(new Error('File not found'));
            const result = await contribution.resolve({ variable: skills_variable_contribution_1.SKILL_VARIABLE, arg: 'my-skill' }, {});
            (0, chai_1.expect)(result).to.be.undefined;
        });
    });
});
//# sourceMappingURL=skills-variable-contribution.spec.js.map