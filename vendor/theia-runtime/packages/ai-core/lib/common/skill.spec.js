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
const chai_1 = require("chai");
const skill_1 = require("./skill");
describe('Skill Types', () => {
    describe('SKILL_FILE_NAME', () => {
        it('should be SKILL.md', () => {
            (0, chai_1.expect)(skill_1.SKILL_FILE_NAME).to.equal('SKILL.md');
        });
    });
    describe('isValidSkillName', () => {
        it('should accept simple lowercase names', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('skill')).to.be.true;
        });
        it('should accept kebab-case names', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('my-skill')).to.be.true;
        });
        it('should accept names with digits', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('skill1')).to.be.true;
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('my-skill-2')).to.be.true;
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('1skill')).to.be.true;
        });
        it('should accept multi-part kebab-case names', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('my-awesome-skill')).to.be.true;
        });
        it('should reject uppercase letters', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('MySkill')).to.be.false;
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('SKILL')).to.be.false;
        });
        it('should reject leading hyphens', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('-skill')).to.be.false;
        });
        it('should reject trailing hyphens', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('skill-')).to.be.false;
        });
        it('should reject consecutive hyphens', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('my--skill')).to.be.false;
        });
        it('should reject spaces', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('my skill')).to.be.false;
        });
        it('should reject underscores', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('my_skill')).to.be.false;
        });
        it('should reject empty strings', () => {
            (0, chai_1.expect)((0, skill_1.isValidSkillName)('')).to.be.false;
        });
    });
    describe('SkillDescription.is', () => {
        it('should return true for valid SkillDescription', () => {
            const valid = {
                name: 'my-skill',
                description: 'A test skill'
            };
            (0, chai_1.expect)(skill_1.SkillDescription.is(valid)).to.be.true;
        });
        it('should return true for SkillDescription with optional fields', () => {
            const valid = {
                name: 'my-skill',
                description: 'A test skill',
                license: 'MIT',
                compatibility: '>=1.0.0',
                metadata: { author: 'Test' },
                allowedTools: ['tool1', 'tool2']
            };
            (0, chai_1.expect)(skill_1.SkillDescription.is(valid)).to.be.true;
        });
        it('should return false for undefined', () => {
            (0, chai_1.expect)(skill_1.SkillDescription.is(undefined)).to.be.false;
        });
        it('should return false for null', () => {
            // eslint-disable-next-line no-null/no-null
            (0, chai_1.expect)(skill_1.SkillDescription.is(null)).to.be.false;
        });
        it('should return false for non-objects', () => {
            (0, chai_1.expect)(skill_1.SkillDescription.is('string')).to.be.false;
            (0, chai_1.expect)(skill_1.SkillDescription.is(123)).to.be.false;
            (0, chai_1.expect)(skill_1.SkillDescription.is(true)).to.be.false;
        });
        it('should return false when name is missing', () => {
            (0, chai_1.expect)(skill_1.SkillDescription.is({ description: 'A skill' })).to.be.false;
        });
        it('should return false when description is missing', () => {
            (0, chai_1.expect)(skill_1.SkillDescription.is({ name: 'my-skill' })).to.be.false;
        });
        it('should return false when name is not a string', () => {
            (0, chai_1.expect)(skill_1.SkillDescription.is({ name: 123, description: 'A skill' })).to.be.false;
        });
        it('should return false when description is not a string', () => {
            (0, chai_1.expect)(skill_1.SkillDescription.is({ name: 'my-skill', description: 123 })).to.be.false;
        });
    });
    describe('SkillDescription.equals', () => {
        it('should return true for equal names', () => {
            const a = { name: 'skill', description: 'Description A' };
            const b = { name: 'skill', description: 'Description B' };
            (0, chai_1.expect)(skill_1.SkillDescription.equals(a, b)).to.be.true;
        });
        it('should return false for different names', () => {
            const a = { name: 'skill-a', description: 'Same description' };
            const b = { name: 'skill-b', description: 'Same description' };
            (0, chai_1.expect)(skill_1.SkillDescription.equals(a, b)).to.be.false;
        });
    });
    describe('validateSkillDescription', () => {
        it('should return empty array for valid skill description', () => {
            const description = {
                name: 'my-skill',
                description: 'A valid skill description'
            };
            const errors = (0, skill_1.validateSkillDescription)(description, 'my-skill');
            (0, chai_1.expect)(errors).to.be.empty;
        });
        it('should return error when name does not match directory name', () => {
            const description = {
                name: 'my-skill',
                description: 'A skill'
            };
            const errors = (0, skill_1.validateSkillDescription)(description, 'other-directory');
            (0, chai_1.expect)(errors).to.include("Skill name 'my-skill' must match directory name 'other-directory'. Skipping skill.");
        });
        it('should return error for invalid name format', () => {
            const description = {
                name: 'My-Skill',
                description: 'A skill'
            };
            const errors = (0, skill_1.validateSkillDescription)(description, 'My-Skill');
            (0, chai_1.expect)(errors.some(e => e.includes('must be lowercase kebab-case'))).to.be.true;
        });
        it('should return error when description exceeds maximum length', () => {
            const description = {
                name: 'my-skill',
                description: 'x'.repeat(1025)
            };
            const errors = (0, skill_1.validateSkillDescription)(description, 'my-skill');
            (0, chai_1.expect)(errors.some(e => e.includes('exceeds maximum length'))).to.be.true;
        });
        it('should return error when name is not a string', () => {
            const description = {
                name: 123,
                description: 'A skill'
            };
            const errors = (0, skill_1.validateSkillDescription)(description, 'my-skill');
            (0, chai_1.expect)(errors).to.include('Skill name must be a string');
        });
        it('should return error when description is not a string', () => {
            const description = {
                name: 'my-skill',
                description: 123
            };
            const errors = (0, skill_1.validateSkillDescription)(description, 'my-skill');
            (0, chai_1.expect)(errors).to.include('Skill description must be a string');
        });
        it('should return multiple errors when multiple validations fail', () => {
            const description = {
                name: 'Invalid_Name',
                description: 'x'.repeat(1025)
            };
            const errors = (0, skill_1.validateSkillDescription)(description, 'wrong-dir');
            (0, chai_1.expect)(errors.length).to.be.greaterThan(1);
        });
        it('should accept description at exactly maximum length', () => {
            const description = {
                name: 'my-skill',
                description: 'x'.repeat(1024)
            };
            const errors = (0, skill_1.validateSkillDescription)(description, 'my-skill');
            (0, chai_1.expect)(errors).to.be.empty;
        });
        it('does not require the frontmatter name of an owned skill to carry its qualifier', () => {
            // Qualification is layered on top of the name; it never changes what an artifact has to
            // write into its SKILL.md, which would change the artifact's content hash.
            const description = {
                name: 'query-builder',
                description: 'Build SQL'
            };
            (0, chai_1.expect)((0, skill_1.validateSkillDescription)(description, 'query-builder')).to.be.empty;
            (0, chai_1.expect)(skill_1.Skill.qualifyName(description.name, 'bq')).to.equal('bq:query-builder');
        });
    });
    describe('Skill.qualifyName', () => {
        it('returns the plain name when there is no qualifier', () => {
            (0, chai_1.expect)(skill_1.Skill.qualifyName('code-review')).to.equal('code-review');
        });
        it('prefixes the name with the qualifier', () => {
            (0, chai_1.expect)(skill_1.Skill.qualifyName('query-builder', 'bigquery-data-analytics')).to.equal('bigquery-data-analytics:query-builder');
        });
    });
    describe('Skill.qualifierOf', () => {
        const skill = (name, qualifiedName) => ({ name, description: 'd', location: '/skills/' + name + '/SKILL.md', qualifiedName });
        it('returns undefined for a skill from a built-in root', () => {
            (0, chai_1.expect)(skill_1.Skill.qualifierOf(skill('code-review', 'code-review'))).to.be.undefined;
        });
        it('returns the qualifier of a contributed skill', () => {
            (0, chai_1.expect)(skill_1.Skill.qualifierOf(skill('query-builder', 'bq:query-builder'))).to.equal('bq');
        });
        it('round-trips with qualifyName', () => {
            const qualifiedName = skill_1.Skill.qualifyName('query-builder', 'io.github.acme_tools');
            (0, chai_1.expect)(skill_1.Skill.qualifierOf(skill('query-builder', qualifiedName))).to.equal('io.github.acme_tools');
        });
    });
    describe('combineSkillDirectories with plugin directories', () => {
        const pluginEntry = {
            path: '/home/user/.agents/plugins/io.example.bq/skills',
            tier: 'plugin',
            qualifier: 'bq'
        };
        it('appends plugin directories after every user-controlled tier', () => {
            const result = (0, skill_1.combineSkillDirectories)(['/workspace/.prompts/skills'], ['/custom/skills'], ['/home/user/.agents/skills'], [pluginEntry]);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: '/workspace/.prompts/skills', tier: 'workspace' },
                { path: '/custom/skills', tier: 'configured' },
                { path: '/home/user/.agents/skills', tier: 'default' },
                pluginEntry
            ]);
        });
        it('keeps the qualifier of a plugin directory', () => {
            const result = (0, skill_1.combineSkillDirectories)([], [], [], [pluginEntry]);
            (0, chai_1.expect)(result[0].qualifier).to.equal('bq');
        });
        it('drops a plugin directory whose path a user-controlled tier already claimed, so the user wins the collision', () => {
            const result = (0, skill_1.combineSkillDirectories)([], [pluginEntry.path], [], [pluginEntry]);
            (0, chai_1.expect)(result).to.deep.equal([
                { path: pluginEntry.path, tier: 'configured' }
            ]);
        });
        it('deduplicates two plugin directories with the same path, keeping the first', () => {
            const second = {
                ...pluginEntry,
                qualifier: 'other'
            };
            const result = (0, skill_1.combineSkillDirectories)([], [], [], [pluginEntry, second]);
            (0, chai_1.expect)(result).to.deep.equal([pluginEntry]);
        });
        it('behaves exactly as before when no plugin directories are passed', () => {
            (0, chai_1.expect)((0, skill_1.combineSkillDirectories)(['/workspace/skills'], [], [])).to.deep.equal([
                { path: '/workspace/skills', tier: 'workspace' }
            ]);
        });
    });
});
//# sourceMappingURL=skill.spec.js.map