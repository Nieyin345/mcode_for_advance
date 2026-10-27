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
exports.MarkdownRendererImpl = exports.MarkdownRendererFactory = exports.CoreMarkdownRenderer = exports.MarkdownRenderer = void 0;
const tslib_1 = require("tslib");
const DOMPurify = require("dompurify");
const inversify_1 = require("inversify");
const markdownit = require("markdown-it");
const markdownitemoji = require("markdown-it-emoji");
const label_parser_1 = require("../label-parser");
const widgets_1 = require("../widgets");
// #endregion
/** Use this directly if you aren't worried about circular dependencies in the Shell */
exports.MarkdownRenderer = Symbol('MarkdownRenderer');
/**
 * Always resolves to the core {@link MarkdownRendererImpl} (markdown-it based),
 * even when the {@link MarkdownRenderer} symbol has been rebound (e.g. by Monaco).
 */
exports.CoreMarkdownRenderer = Symbol('CoreMarkdownRenderer');
/** Use this to avoid circular dependencies in the Shell */
exports.MarkdownRendererFactory = Symbol('MarkdownRendererFactory');
let MarkdownRendererImpl = class MarkdownRendererImpl {
    constructor() {
        this.markdownIt = markdownit().use(markdownitemoji.full);
    }
    init() {
        this.markdownItPlugin();
    }
    render(markdown, options) {
        const host = document.createElement('div');
        if (markdown) {
            const html = this.markdownIt.render(markdown.value);
            host.innerHTML = DOMPurify.sanitize(html, {
                ALLOW_UNKNOWN_PROTOCOLS: true // DOMPurify usually strips non http(s) links from hrefs
            });
        }
        return { element: host, dispose: () => { } };
    }
    markdownItPlugin() {
        this.markdownIt.renderer.rules.text = (tokens, idx) => {
            const content = tokens[idx].content;
            return this.labelParser.parse(content).map(chunk => {
                if (typeof chunk === 'string') {
                    return chunk;
                }
                return `<i class="${(0, widgets_1.codicon)(chunk.name)} ${chunk.animation ? `fa-${chunk.animation}` : ''} icon-inline"></i>`;
            }).join('');
        };
        // Support VS Code's `![alt](src|width=W,height=H)` image sizing syntax, which markdown-it
        // would otherwise fold into the `src` attribute, yielding a broken image.
        const renderImage = this.markdownIt.renderer.rules.image;
        this.markdownIt.renderer.rules.image = (tokens, idx, options, env, self) => {
            const token = tokens[idx];
            const srcIndex = token.attrIndex('src');
            if (srcIndex >= 0 && token.attrs) {
                const src = token.attrs[srcIndex][1];
                // markdown-it percent-encodes the link destination, so the separator may have
                // become `%7C` by the time the token reaches the renderer.
                const separator = /(?:\||%7c)(?![\s\S]*(?:\||%7c))/i.exec(src);
                if (separator) {
                    const dimensions = this.parseImageDimensions(src.substring(separator.index + separator[0].length));
                    if (dimensions) {
                        token.attrs[srcIndex][1] = src.substring(0, separator.index);
                        for (const [name, value] of Object.entries(dimensions)) {
                            token.attrSet(name, value);
                        }
                    }
                }
            }
            return renderImage ? renderImage(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
        };
    }
    /**
     * Parses the `width=W,height=H` parameter list of an image's sizing suffix.
     *
     * @returns the recognized dimensions, or `undefined` if the suffix is not a well-formed
     * parameter list — in which case it is left as part of the `src`, since it may be a literal
     * `|` in the URL.
     */
    parseImageDimensions(params) {
        const dimensions = {};
        for (const param of params.split(',')) {
            const match = /^\s*(width|height)\s*=\s*(\d+)\s*$/.exec(param);
            if (!match) {
                return undefined;
            }
            dimensions[match[1]] = match[2];
        }
        return Object.keys(dimensions).length > 0 ? dimensions : undefined;
    }
};
exports.MarkdownRendererImpl = MarkdownRendererImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(label_parser_1.LabelParser),
    tslib_1.__metadata("design:type", label_parser_1.LabelParser)
], MarkdownRendererImpl.prototype, "labelParser", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], MarkdownRendererImpl.prototype, "init", null);
exports.MarkdownRendererImpl = MarkdownRendererImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MarkdownRendererImpl);
//# sourceMappingURL=markdown-renderer.js.map