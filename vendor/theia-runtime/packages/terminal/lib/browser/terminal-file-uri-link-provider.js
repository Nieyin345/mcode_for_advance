"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
exports.FileUriLinkProvider = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@theia/core");
const uri_1 = require("@theia/core/lib/common/uri");
const inversify_1 = require("@theia/core/shared/inversify");
const terminal_file_opening_link_provider_1 = require("./terminal-file-opening-link-provider");
/**
 * Linkifies `file://` URLs printed in the terminal and opens the referenced local file in the editor.
 *
 * A dedicated provider is needed because `UrlLinkProvider` only matches `http(s)` and
 * `FileLinkProvider`'s path regex excludes `:`, so neither recognizes the `file:` scheme.
 */
let FileUriLinkProvider = class FileUriLinkProvider extends terminal_file_opening_link_provider_1.AbstractFileOpeningLinkProvider {
    constructor() {
        super(...arguments);
        // The optional third slash denotes an empty authority (`file:///path`); the match runs to the first
        // whitespace or character that commonly delimits a URL in prose.
        this.fileUriRegExp = /file:\/\/\/?[^\s'"`<>()[\]]+/g;
    }
    async provideLinks(line, terminal) {
        // Collect all matches synchronously before awaiting: the `g`-flag regex is instance-shared, so
        // yielding mid-iteration would let a concurrent call corrupt its `lastIndex`.
        const candidates = [];
        this.fileUriRegExp.lastIndex = 0;
        let regExpResult;
        while (regExpResult = this.fileUriRegExp.exec(line)) {
            candidates.push({ match: this.trimTrailingPunctuation(regExpResult[0]), startIndex: regExpResult.index });
        }
        const links = await Promise.all(candidates.map(async ({ match, startIndex }) => {
            const { fileUri, position } = this.splitPosition(match);
            const uri = this.toURI(fileUri);
            if (uri && await this.isValidFileURI(uri)) {
                return { startIndex, length: match.length, handle: () => this.openURI(uri, position) };
            }
            return undefined;
        }));
        return links.filter((link) => link !== undefined);
    }
    /**
     * Splits a trailing `:line` or `:line:column` suffix (as in `file:///x.ts:10:5`) off the matched
     * URL into a one-based editor position. The drive colon of `file:///C:/x.ts` is not affected, as
     * it is not followed by digits at the end of the string.
     */
    splitPosition(match) {
        const positionMatch = /:(\d+)(?::(\d+))?$/.exec(match);
        if (!positionMatch) {
            return { fileUri: match };
        }
        const line = Math.max(0, parseInt(positionMatch[1], 10) - 1);
        const character = positionMatch[2] !== undefined ? Math.max(0, parseInt(positionMatch[2], 10) - 1) : 0;
        return {
            fileUri: match.slice(0, positionMatch.index),
            position: { line, character }
        };
    }
    toURI(match) {
        try {
            const uri = new uri_1.default(match);
            return uri.scheme === 'file' ? uri : undefined;
        }
        catch {
            return undefined;
        }
    }
    trimTrailingPunctuation(match) {
        return match.replace(/[.,;:]+$/, '');
    }
};
exports.FileUriLinkProvider = FileUriLinkProvider;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('terminal:FileUriLinkProvider'),
    tslib_1.__metadata("design:type", Object)
], FileUriLinkProvider.prototype, "logger", void 0);
exports.FileUriLinkProvider = FileUriLinkProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], FileUriLinkProvider);
//# sourceMappingURL=terminal-file-uri-link-provider.js.map