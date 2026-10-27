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
const jsdom_1 = require("../test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const inversify_1 = require("inversify");
const chai_1 = require("chai");
const common_1 = require("../../common");
const markdown_string_1 = require("../../common/markdown-rendering/markdown-string");
const label_parser_1 = require("../label-parser");
const markdown_renderer_1 = require("./markdown-renderer");
disableJSDOM();
describe('MarkdownRendererImpl', () => {
    let restoreJSDOM;
    let renderer;
    before(() => {
        restoreJSDOM = (0, jsdom_1.enableJSDOM)();
        const container = new inversify_1.Container();
        container.bind(label_parser_1.LabelParser).toSelf().inSingletonScope();
        container.bind(common_1.CommandService).toConstantValue({
            executeCommand: () => Promise.resolve(undefined)
        });
        container.bind(markdown_renderer_1.MarkdownRendererImpl).toSelf().inSingletonScope();
        container.bind(markdown_renderer_1.MarkdownRenderer).toService(markdown_renderer_1.MarkdownRendererImpl);
        renderer = container.get(markdown_renderer_1.MarkdownRenderer);
    });
    after(() => {
        restoreJSDOM();
    });
    function renderImage(markdown) {
        const { element } = renderer.render(new markdown_string_1.MarkdownStringImpl(markdown));
        const image = element.querySelector('img');
        (0, chai_1.expect)(image, `image rendered for '${markdown}'`).to.not.be.null;
        return image;
    }
    it('applies the width and height of an image sizing suffix', () => {
        const image = renderImage('![Jane](https://avatars.example.com/u/1|width=20,height=20)');
        (0, chai_1.expect)(image.getAttribute('src')).to.equal('https://avatars.example.com/u/1');
        (0, chai_1.expect)(image.getAttribute('width')).to.equal('20');
        (0, chai_1.expect)(image.getAttribute('height')).to.equal('20');
    });
    it('applies a suffix that sets only one dimension', () => {
        const image = renderImage('![Jane](https://avatars.example.com/u/1|width=20)');
        (0, chai_1.expect)(image.getAttribute('src')).to.equal('https://avatars.example.com/u/1');
        (0, chai_1.expect)(image.getAttribute('width')).to.equal('20');
        (0, chai_1.expect)(image.hasAttribute('height')).to.be.false;
    });
    // markdown-it percent-encodes the link destination, so a pipe it keeps shows up as `%7C`.
    it('keeps a literal pipe that is not a well-formed sizing suffix', () => {
        const image = renderImage('![Jane](https://avatars.example.com/u/1|v=2)');
        (0, chai_1.expect)(image.getAttribute('src')).to.equal('https://avatars.example.com/u/1%7Cv=2');
        (0, chai_1.expect)(image.hasAttribute('width')).to.be.false;
    });
    it('ignores a non-numeric dimension', () => {
        const image = renderImage('![Jane](https://avatars.example.com/u/1|width=20px)');
        (0, chai_1.expect)(image.getAttribute('src')).to.equal('https://avatars.example.com/u/1%7Cwidth=20px');
        (0, chai_1.expect)(image.hasAttribute('width')).to.be.false;
    });
    it('renders an image without a suffix unchanged', () => {
        const image = renderImage('![Jane](https://avatars.example.com/u/1)');
        (0, chai_1.expect)(image.getAttribute('src')).to.equal('https://avatars.example.com/u/1');
        (0, chai_1.expect)(image.hasAttribute('width')).to.be.false;
    });
});
//# sourceMappingURL=markdown-renderer.spec.js.map