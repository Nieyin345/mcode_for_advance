"use strict";
// *****************************************************************************
// Copyright (C) 2026 Safi Seid-Ahmad, K2view and others.
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
exports.parseFrontmatter = parseFrontmatter;
exports.serializeFrontmatter = serializeFrontmatter;
const js_yaml_1 = require("js-yaml");
const STANDARD_FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
/**
 * Parse a string containing optional YAML frontmatter.
 *
 * Supports two layouts (in this order):
 *   1. Standard: starts with `---`, YAML, then `---` separator, then body.
 *   2. Legacy:   starts directly with YAML, then `---` separator, then body.
 *
 * The legacy form is preserved so existing on-disk files written by older
 * Theia versions (e.g. task-context summaries) continue to parse without a
 * migration step.
 */
function parseFrontmatter(content, options) {
    const standardMatch = content.match(STANDARD_FRONTMATTER_REGEX);
    if (standardMatch) {
        const parsed = tryLoad(standardMatch[1]);
        if (parsed !== undefined && isAcceptable(parsed, options)) {
            return { metadata: parsed, body: standardMatch[2].trim() };
        }
    }
    const separatorIndex = content.indexOf('\n---');
    if (separatorIndex > 0) {
        const head = content.slice(0, separatorIndex);
        const tail = content.slice(separatorIndex + 4);
        const parsed = tryLoad(head);
        if (parsed !== undefined && isAcceptable(parsed, options)) {
            return { metadata: parsed, body: tail.replace(/^\s*\n?/, '').trim() };
        }
    }
    return { metadata: undefined, body: content };
}
/**
 * Serialize metadata + body into a standard frontmatter document
 * (`---\n<yaml>\n---\n<body>`).
 */
function serializeFrontmatter(metadata, body) {
    const yamlBlock = (0, js_yaml_1.dump)(metadata, { lineWidth: -1 }).trimEnd();
    const trimmedBody = body.replace(/^\n+/, '');
    return `---\n${yamlBlock}\n---\n${trimmedBody}`;
}
function tryLoad(source) {
    try {
        const parsed = (0, js_yaml_1.load)(source);
        // eslint-disable-next-line no-null/no-null
        if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}
function isAcceptable(parsed, options) {
    if (!options?.isValid) {
        return true;
    }
    return options.isValid(parsed);
}
//# sourceMappingURL=frontmatter.js.map