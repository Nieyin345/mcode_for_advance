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
exports.Skill = exports.SkillDescription = exports.SKILL_FILE_NAME = void 0;
exports.isValidSkillName = isValidSkillName;
exports.validateSkillDescription = validateSkillDescription;
exports.parseSkillFile = parseSkillFile;
exports.combineSkillDirectories = combineSkillDirectories;
const frontmatter_1 = require("./frontmatter");
/**
 * The standard filename for skill definition files.
 */
exports.SKILL_FILE_NAME = 'SKILL.md';
/**
 * Regular expression for valid skill names.
 * Must be lowercase kebab-case with digits allowed.
 * Examples: 'my-skill', 'skill1', 'my-skill-2'
 */
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/**
 * Maximum allowed length for skill descriptions.
 */
const MAX_DESCRIPTION_LENGTH = 1024;
var SkillDescription;
(function (SkillDescription) {
    /**
     * Type guard to check if an unknown value is a valid SkillDescription.
     * Validates that required fields exist and have correct types.
     */
    function is(entry) {
        if (typeof entry !== 'object' || entry === undefined) {
            return false;
        }
        // eslint-disable-next-line no-null/no-null
        if (entry === null) {
            return false;
        }
        const obj = entry;
        return typeof obj.name === 'string' && typeof obj.description === 'string';
    }
    SkillDescription.is = is;
    /**
     * Compares two SkillDescription objects for equality based on name.
     */
    function equals(a, b) {
        return a.name === b.name;
    }
    SkillDescription.equals = equals;
})(SkillDescription || (exports.SkillDescription = SkillDescription = {}));
var Skill;
(function (Skill) {
    /**
     * Never changes what is written in `SKILL.md` - the frontmatter `name` must still equal the
     * skill's directory name; qualification is layered on top.
     */
    function qualifyName(name, qualifier) {
        return qualifier ? `${qualifier}:${name}` : name;
    }
    Skill.qualifyName = qualifyName;
    /**
     * The qualifier of {@link Skill.qualifiedName}, or `undefined` for a skill from a built-in root.
     * Unambiguous because neither part can contain a colon: a skill name is validated as lowercase
     * kebab-case, and a qualifier has to be a single path segment.
     */
    function qualifierOf(skill) {
        const separatorIndex = skill.qualifiedName.indexOf(':');
        return separatorIndex < 0 ? undefined : skill.qualifiedName.substring(0, separatorIndex);
    }
    Skill.qualifierOf = qualifierOf;
})(Skill || (exports.Skill = Skill = {}));
/**
 * Validates if a skill name follows the required format.
 * Valid names are lowercase kebab-case with digits allowed.
 * No leading/trailing/consecutive hyphens.
 *
 * @param name The skill name to validate
 * @returns true if the name is valid, false otherwise
 */
function isValidSkillName(name) {
    return SKILL_NAME_REGEX.test(name);
}
/**
 * Validates a SkillDescription against all constraints.
 *
 * @param description The skill description to validate
 * @param directoryName The name of the directory containing the SKILL.md file
 * @returns Array of validation error messages, empty if valid
 */
function validateSkillDescription(description, directoryName) {
    const errors = [];
    if (typeof description.name !== 'string') {
        errors.push('Skill name must be a string');
    }
    else {
        if (description.name !== directoryName) {
            errors.push(`Skill name '${description.name}' must match directory name '${directoryName}'. Skipping skill.`);
        }
        if (!isValidSkillName(description.name)) {
            errors.push(`Skill name '${description.name}' must be lowercase kebab-case (e.g., 'my-skill', 'skill1')`);
        }
    }
    if (typeof description.description !== 'string') {
        errors.push('Skill description must be a string');
    }
    else if (description.description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push(`Skill description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    return errors;
}
/**
 * Parses a SKILL.md file content, extracting YAML frontmatter metadata and markdown content.
 * @param content The raw file content
 * @returns Object with parsed metadata (if valid) and the markdown content
 */
function parseSkillFile(content) {
    const { metadata, body } = (0, frontmatter_1.parseFrontmatter)(content, { isValid: SkillDescription.is });
    if (!metadata) {
        return { metadata: undefined, content };
    }
    return { metadata, content: body };
}
/**
 * Combines skill directories with proper priority ordering and provenance: workspace, then
 * configured, then defaults, then installed artifacts - so a directory the user controls always wins.
 * First occurrence of a path wins on duplicates; later occurrences (regardless of tier) are dropped.
 */
function combineSkillDirectories(workspaceSkillsDirs, configuredDirectories, defaultSkillsDirs, pluginSkillsDirs = []) {
    const seen = new Set();
    const result = [];
    const candidates = [
        ...toSkillDirectoryEntries(workspaceSkillsDirs, 'workspace'),
        ...toSkillDirectoryEntries(configuredDirectories, 'configured'),
        ...toSkillDirectoryEntries(defaultSkillsDirs, 'default'),
        ...pluginSkillsDirs
    ];
    for (const candidate of candidates) {
        if (!seen.has(candidate.path)) {
            seen.add(candidate.path);
            result.push(candidate);
        }
    }
    return result;
}
function toSkillDirectoryEntries(dirs, tier) {
    return dirs.map(dir => ({ path: dir, tier }));
}
//# sourceMappingURL=skill.js.map