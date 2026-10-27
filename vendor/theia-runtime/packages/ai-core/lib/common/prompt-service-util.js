"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FRONT_MATTER_REGEX = exports.DEFERRED_FUNCTION_MARKER = exports.PROMPT_FUNCTION_REGEX = exports.PROMPT_VARIABLE_THREE_BRACES_REGEX = exports.PROMPT_VARIABLE_TWO_BRACES_REGEX = void 0;
exports.matchVariablesRegEx = matchVariablesRegEx;
exports.parseFunctionReference = parseFunctionReference;
exports.matchFunctionsRegEx = matchFunctionsRegEx;
exports.stripFrontMatter = stripFrontMatter;
/** Should match the one from VariableResolverService. The format is `{{variableName:arg}}`. We allow {{}} and {{{}}} but no mixtures */
exports.PROMPT_VARIABLE_TWO_BRACES_REGEX = /(?<!\{)\{\{\s*([^{}]+?)\s*\}\}(?!\})/g;
exports.PROMPT_VARIABLE_THREE_BRACES_REGEX = /(?<!\{)\{\{\{\s*([^{}]+?)\s*\}\}\}(?!\})/g;
function matchVariablesRegEx(template) {
    const twoBraceMatches = [...template.matchAll(exports.PROMPT_VARIABLE_TWO_BRACES_REGEX)];
    const threeBraceMatches = [...template.matchAll(exports.PROMPT_VARIABLE_THREE_BRACES_REGEX)];
    return twoBraceMatches.concat(threeBraceMatches);
}
/**
 * Match function/tool references in the prompt. The format is `~{functionId}`.
 * A function may be marked as deferred by prefixing the id with `?`,
 * e.g. `~{?functionId}`. Deferred tools are not loaded into the model's
 * context upfront and are instead discovered on-demand via the model
 * provider's built-in tool search mechanism (e.g. Anthropic's tool search
 * tool, OpenAI's tool search) when supported by the provider.
 */
exports.PROMPT_FUNCTION_REGEX = /\~\{\s*(.*?)\s*\}/g;
/** Marker used in template syntax to flag a tool reference as deferred. */
exports.DEFERRED_FUNCTION_MARKER = '?';
/**
 * Parses the raw content captured between `~{` and `}` (or the token
 * captured after `~`) and extracts the referenced tool id together with the
 * deferred flag.
 */
function parseFunctionReference(rawIdOrToken) {
    const trimmed = rawIdOrToken.trim();
    if (trimmed.startsWith(exports.DEFERRED_FUNCTION_MARKER)) {
        return { id: trimmed.slice(exports.DEFERRED_FUNCTION_MARKER.length).trim(), deferred: true };
    }
    return { id: trimmed, deferred: false };
}
function matchFunctionsRegEx(template) {
    return [...template.matchAll(exports.PROMPT_FUNCTION_REGEX)];
}
/** Regex matching YAML front matter delimited by `---` */
exports.FRONT_MATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
/**
 * Strips YAML front matter from a template string, returning only the body.
 * If no front matter is present the original string is returned unchanged.
 */
function stripFrontMatter(template) {
    const match = template.match(exports.FRONT_MATTER_REGEX);
    return match ? match[2] : template;
}
//# sourceMappingURL=prompt-service-util.js.map