"use strict";
// *****************************************************************************
// Copyright (C) 2025 Maksim Kachurin and others.
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
exports.normalizeGlob = normalizeGlob;
exports.matchesPattern = matchesPattern;
exports.createIgnoreMatcher = createIgnoreMatcher;
exports.getIgnorePatterns = getIgnorePatterns;
const minimatch_1 = require("minimatch");
const ignore_1 = require("ignore");
/**
 * Normalizes glob patterns to be consistent with ripgrep behavior.
 *
 * Examples of transformations:
 * - "*.js" -> "**\/*.js" (make non-root patterns match anywhere)
 * - "src/" -> "src\/**" (directory patterns match all contents)
 * - "!*.log" -> "!**\/*.log" (negation patterns)
 * - "src/**\/**\/file.js" -> "src/**\/file.js" (collapse repeated double-star patterns)
 *
 * @param glob - The glob pattern to normalize
 * @returns The normalized glob pattern
 */
function normalizeGlob(glob) {
    let neg = '';
    let root = false;
    // Handle negation patterns (starting with '!')
    if (glob.startsWith('!')) {
        neg = '!';
        glob = glob.slice(1);
    }
    // Convert Windows backslashes to forward slashes for consistency
    glob = glob.replace(/\\/g, '/');
    // Remove redundant './' prefix (same as current directory)
    if (glob.startsWith('./')) {
        glob = glob.slice(1);
    }
    // Check if pattern is root-anchored (starts with '/')
    if (glob.startsWith('/')) {
        root = true;
    }
    // Convert directory patterns to match all contents
    // "src/" becomes "src/**" to match everything inside the directory
    if (glob.endsWith('/') && !glob.endsWith('/**')) {
        glob = glob + '**';
    }
    // Make non-root patterns match anywhere in the directory tree
    // "*.js" becomes "**/*.js" to match .js files anywhere
    if (!root && !glob.startsWith('**')) {
        glob = '**/' + glob;
    }
    // Clean up repeated '**/' patterns
    // "src/**/**/file.js" becomes "src/**/file.js"
    glob = glob.replace(/(\*\*\/)+\*\*\//g, '**/');
    // Restore negation prefix if it was present
    return neg + glob;
}
/**
 * Checks if a text matches any of the minimatch patterns
 * @param text - The text to check
 * @param patterns - The patterns to check
 * @returns True if the text matches any of the patterns, false otherwise
 */
function matchesPattern(text, patterns, opts) {
    return patterns.some(pattern => (0, minimatch_1.minimatch)(text, pattern, opts));
}
/**
 * Creates a new ignore pattern matcher for managing ignore patterns.
 * @returns An object with add and ignores methods
 */
function createIgnoreMatcher() {
    const ig = (0, ignore_1.default)();
    return {
        add: (patterns) => ig.add(patterns),
        ignores: (path) => ig.ignores(path)
    };
}
/**
 * Processes ignore files (.gitignore, .ignore, .rgignore) in a directory.
 * @param dir - The directory URI to process
 * @param read - Function to read the ignore file content
 * @returns Array of processed ignore patterns relative to the directory contains that ignore file
 */
async function getIgnorePatterns(dir, read) {
    const fromPath = dir.path.toString();
    const ignoreFiles = await Promise.allSettled(['.gitignore', '.ignore', '.rgignore'].map(file => read(dir.resolve(file))));
    const lines = ignoreFiles
        .filter(result => result.status === 'fulfilled')
        .flatMap((result) => result.value
        .split('\n')
        .map(line => prefixGitignoreLine(fromPath, line))
        .filter((line) => typeof line === 'string'));
    return lines;
}
/**
 * Convert patterns from dir base to root-relative git semantics.
 * @param baseRel - The base relative path
 * @param raw - The raw pattern
 * @returns The processed pattern
 */
function prefixGitignoreLine(baseRel, raw) {
    let line = raw.replace(/\r?\n$/, '');
    if (!line || /^\s*#/.test(line)) {
        return undefined;
    }
    // handle escaped leading '!' and '#'
    const escapedBang = line.startsWith('\\!');
    const escapedHash = line.startsWith('\\#');
    if (escapedBang || escapedHash) {
        line = line.slice(1);
    }
    const neg = !escapedBang && line.startsWith('!');
    if (neg) {
        line = line.slice(1);
    }
    // normalize slashes in the pattern part
    line = line.replace(/\\/g, '/');
    // strip leading "./"
    if (line.startsWith('./')) {
        line = line.slice(2);
    }
    const anchored = line.startsWith('/');
    const hasSlash = line.includes('/');
    const prefix = baseRel ? baseRel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') : '';
    let pattern;
    if (anchored) {
        // "/foo" in base -> "base/foo"
        pattern = (prefix ? `${prefix}${line}` : line.slice(1)); // remove leading '/' if no base
    }
    else if (hasSlash) {
        // "bar/*.js" in base -> "base/bar/*.js"
        pattern = prefix ? `${prefix}/${line}` : line;
    }
    else {
        // "foo" in base -> "base/**/foo"
        pattern = prefix ? `${prefix}/**/${line}` : line;
    }
    return neg ? `!${pattern}` : pattern;
}
//# sourceMappingURL=file-search.js.map