"use strict";
// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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
exports.MarkdownStringImpl = exports.MarkdownString = exports.MarkdownStringTextNewlineStyle = void 0;
exports.escapeMarkdownSyntaxTokens = escapeMarkdownSyntaxTokens;
exports.parseHrefAndDimensions = parseHrefAndDimensions;
const strings_1 = require("../strings");
const icon_utilities_1 = require("./icon-utilities");
const types_1 = require("../types");
var MarkdownStringTextNewlineStyle;
(function (MarkdownStringTextNewlineStyle) {
    MarkdownStringTextNewlineStyle[MarkdownStringTextNewlineStyle["Paragraph"] = 0] = "Paragraph";
    MarkdownStringTextNewlineStyle[MarkdownStringTextNewlineStyle["Break"] = 1] = "Break";
})(MarkdownStringTextNewlineStyle || (exports.MarkdownStringTextNewlineStyle = MarkdownStringTextNewlineStyle = {}));
var MarkdownString;
(function (MarkdownString) {
    /**
     * @returns whether the candidate satisfies the interface of a markdown string
     */
    function is(candidate) {
        return (0, types_1.isObject)(candidate) && (0, types_1.isString)(candidate.value);
    }
    MarkdownString.is = is;
    /**
     * @returns whether `commandId` is allowed to execute given the markdown string's
     * {@link MarkdownString.isTrusted} setting. Fully trusted strings allow any command;
     * partially trusted strings restrict execution to their `enabledCommands` list.
     */
    function isCommandAllowed(isTrusted, commandId) {
        return isTrusted === true
            || (typeof isTrusted === 'object' && isTrusted.enabledCommands.includes(commandId));
    }
    MarkdownString.isCommandAllowed = isCommandAllowed;
})(MarkdownString || (exports.MarkdownString = MarkdownString = {}));
// Copied from https://github.com/microsoft/vscode/blob/7d9b1c37f8e5ae3772782ba3b09d827eb3fdd833/src/vs/base/common/htmlContent.ts
class MarkdownStringImpl {
    constructor(value = '', isTrustedOrOptions = false) {
        this.value = value;
        if (typeof this.value !== 'string') {
            throw new Error('Illegal value for MarkdownString. Expected string, got ' + typeof this.value);
        }
        if (typeof isTrustedOrOptions === 'boolean') {
            this.isTrusted = isTrustedOrOptions;
            this.supportThemeIcons = false;
            this.supportHtml = false;
        }
        else {
            this.isTrusted = isTrustedOrOptions.isTrusted ?? undefined;
            this.supportThemeIcons = isTrustedOrOptions.supportThemeIcons ?? false;
            this.supportHtml = isTrustedOrOptions.supportHtml ?? false;
        }
    }
    appendText(value, newlineStyle = MarkdownStringTextNewlineStyle.Paragraph) {
        this.value += escapeMarkdownSyntaxTokens(this.supportThemeIcons ? (0, icon_utilities_1.escapeIcons)(value) : value)
            .replace(/([ \t]+)/g, (_match, g1) => '&nbsp;'.repeat(g1.length))
            .replace(/\>/gm, '\\>')
            .replace(/\n/g, newlineStyle === MarkdownStringTextNewlineStyle.Break ? '\\\n' : '\n\n');
        return this;
    }
    appendMarkdown(value) {
        this.value += value;
        return this;
    }
    appendCodeblock(langId, code) {
        // Use a fence longer than any run of backticks in the code so that triple-backtick
        // sequences inside `code` cannot prematurely close the surrounding fenced block.
        const fence = '`'.repeat(Math.max(3, MarkdownStringImpl.longestBacktickRun(code) + 1));
        this.value += '\n';
        this.value += fence;
        this.value += langId;
        this.value += '\n';
        this.value += code;
        this.value += '\n';
        this.value += fence;
        this.value += '\n';
        return this;
    }
    static longestBacktickRun(value) {
        let longest = 0;
        let current = 0;
        for (let i = 0; i < value.length; i++) {
            if (value.charCodeAt(i) === 96 /* ` */) {
                current++;
                if (current > longest) {
                    longest = current;
                }
            }
            else {
                current = 0;
            }
        }
        return longest;
    }
    appendLink(target, label, title) {
        this.value += '[';
        this.value += this._escape(label, ']');
        this.value += '](';
        this.value += this._escape(String(target), ')');
        if (title) {
            this.value += ` "${this._escape(this._escape(title, '"'), ')')}"`;
        }
        this.value += ')';
        return this;
    }
    _escape(value, ch) {
        const r = new RegExp((0, strings_1.escapeRegExpCharacters)(ch), 'g');
        return value.replace(r, (match, offset) => {
            if (value.charAt(offset - 1) !== '\\') {
                return `\\${match}`;
            }
            else {
                return match;
            }
        });
    }
}
exports.MarkdownStringImpl = MarkdownStringImpl;
function escapeMarkdownSyntaxTokens(text) {
    // escape markdown syntax tokens: http://daringfireball.net/projects/markdown/syntax#backslash
    return text.replace(/[\\`*_{}[\]()#+\-!]/g, '\\$&');
}
// Copied from https://github.com/microsoft/vscode/blob/1.72.2/src/vs/base/common/htmlContent.ts
function parseHrefAndDimensions(href) {
    const dimensions = [];
    const splitted = href.split('|').map(s => s.trim());
    href = splitted[0];
    const parameters = splitted[1];
    if (parameters) {
        const heightFromParams = /height=(\d+)/.exec(parameters);
        const widthFromParams = /width=(\d+)/.exec(parameters);
        const height = heightFromParams ? heightFromParams[1] : '';
        const width = widthFromParams ? widthFromParams[1] : '';
        const widthIsFinite = isFinite(parseInt(width));
        const heightIsFinite = isFinite(parseInt(height));
        if (widthIsFinite) {
            dimensions.push(`width="${width}"`);
        }
        if (heightIsFinite) {
            dimensions.push(`height="${height}"`);
        }
    }
    return { href, dimensions };
}
//# sourceMappingURL=markdown-string.js.map