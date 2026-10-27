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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const markdown_string_1 = require("@theia/core/lib/common/markdown-rendering/markdown-string");
const markdown_link_handler_1 = require("@theia/core/lib/browser/markdown-rendering/markdown-link-handler");
const disposable_1 = require("@theia/core/lib/common/disposable");
const scm_history_graph_tooltip_1 = require("./scm-history-graph-tooltip");
disableJSDOM();
function makeEntry(item) {
    return {
        item: {
            id: '1a56ba96fdc9b6df3a230df7b44e22e5785e3abd',
            subject: 'fix something',
            parentIds: [],
            ...item,
        },
        graphRow: { lane: 0, color: 0, topColor: 0, edges: [], hasContinuation: false, hasTopLine: false },
        isCurrent: false,
    };
}
const markdownRenderer = {
    render: () => ({ element: document.createElement('div'), dispose: () => { } })
};
describe('buildHtmlTooltip', () => {
    let restoreJSDOM;
    before(() => {
        restoreJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        restoreJSDOM();
    });
    it('renders the author as a bold mailto link when the email is known', () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildHtmlTooltip)(makeEntry({ author: 'Jane Doe', authorEmail: 'jane@example.com', timestamp: 1000 }), markdownRenderer);
        const link = tooltip.querySelector('a[href="mailto:jane@example.com"]');
        (0, chai_1.expect)(link, 'mailto link').to.not.be.null;
        (0, chai_1.expect)(link.textContent).to.contain('Jane Doe');
        (0, chai_1.expect)(link.querySelector('strong'), 'bold author').to.not.be.null;
    });
    it('renders a plain bold author when no email is known', () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildHtmlTooltip)(makeEntry({ author: 'Jane Doe', timestamp: 1000 }), markdownRenderer);
        (0, chai_1.expect)(tooltip.querySelector('a[href^="mailto:"]')).to.be.null;
        const strong = tooltip.querySelector('.scm-history-tooltip-header strong');
        (0, chai_1.expect)(strong).to.not.be.null;
        (0, chai_1.expect)(strong.textContent).to.equal('Jane Doe');
    });
    it('renders the author avatar image when authorIcon is a URL', () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildHtmlTooltip)(makeEntry({ author: 'Jane Doe', authorIcon: 'https://avatars.example.com/u/1' }), markdownRenderer);
        const img = tooltip.querySelector('img.scm-history-tooltip-avatar');
        (0, chai_1.expect)(img, 'avatar image').to.not.be.null;
        (0, chai_1.expect)(img.src).to.equal('https://avatars.example.com/u/1');
    });
    it('falls back to the account icon without an avatar', () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildHtmlTooltip)(makeEntry({ author: 'Jane Doe' }), markdownRenderer);
        (0, chai_1.expect)(tooltip.querySelector('img.scm-history-tooltip-avatar')).to.be.null;
        (0, chai_1.expect)(tooltip.querySelector('.scm-history-tooltip-header .codicon-account')).to.not.be.null;
    });
    it('renders an Open Commit action with the short hash', () => {
        let opened = 0;
        const actions = { openCommit: () => { opened++; } };
        const tooltip = (0, scm_history_graph_tooltip_1.buildHtmlTooltip)(makeEntry({ displayId: '1a56ba9' }), markdownRenderer, undefined, actions);
        const action = tooltip.querySelector('[title="Open Commit"]');
        (0, chai_1.expect)(action, 'open commit action').to.not.be.null;
        (0, chai_1.expect)(action.textContent).to.contain('1a56ba9');
        action.click();
        (0, chai_1.expect)(opened).to.equal(1);
    });
    it('renders a Copy Commit Hash action', () => {
        let copied = 0;
        const actions = { copyCommitHash: () => { copied++; } };
        const tooltip = (0, scm_history_graph_tooltip_1.buildHtmlTooltip)(makeEntry({}), markdownRenderer, undefined, actions);
        const action = tooltip.querySelector('[title="Copy Commit Hash"]');
        (0, chai_1.expect)(action, 'copy hash action').to.not.be.null;
        action.click();
        (0, chai_1.expect)(copied).to.equal(1);
    });
    it('shows the short hash as plain text when no actions are given', () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildHtmlTooltip)(makeEntry({ displayId: '1a56ba9' }), markdownRenderer);
        (0, chai_1.expect)(tooltip.querySelector('[title="Open Commit"]')).to.be.null;
        (0, chai_1.expect)(tooltip.querySelector('[title="Copy Commit Hash"]')).to.be.null;
        (0, chai_1.expect)(tooltip.textContent).to.contain('1a56ba9');
    });
});
describe('buildProviderTooltip', () => {
    let restoreJSDOM;
    let opened;
    let toDispose;
    /** Renders the markdown value as HTML, so that the wiring of the resulting links can be asserted. */
    const htmlRenderer = {
        render: (markdown) => {
            const element = document.createElement('div');
            element.innerHTML = markdown.value;
            return { element, dispose: () => { } };
        }
    };
    const openerService = {
        getOpener: (uri) => Promise.resolve({
            canHandle: () => 1,
            open: () => {
                // decoded, as `HttpOpenHandler` does when opening the target externally
                opened.push(uri.toString(true));
                return Promise.resolve(undefined);
            }
        })
    };
    /** Clicks the anchor and waits for the asynchronous opener lookup to settle. */
    async function click(tooltip, selector) {
        const anchor = tooltip.querySelector(selector);
        (0, chai_1.expect)(anchor, selector).to.not.be.null;
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    before(() => {
        restoreJSDOM = (0, jsdom_1.enableJSDOM)();
    });
    after(() => {
        restoreJSDOM();
    });
    beforeEach(() => {
        opened = [];
        toDispose = new disposable_1.DisposableCollection();
    });
    afterEach(() => {
        toDispose.dispose();
    });
    it('renders each section in order', () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildProviderTooltip)([new markdown_string_1.MarkdownStringImpl('<span>first</span>'), new markdown_string_1.MarkdownStringImpl('<span>second</span>')], htmlRenderer, openerService, toDispose);
        (0, chai_1.expect)(tooltip, 'tooltip').to.not.be.undefined;
        (0, chai_1.expect)(tooltip.textContent).to.equal('firstsecond');
    });
    // `vscode.git` ends its author and statistics sections with a horizontal rule of its own,
    // so adding separators here would render every boundary as a double line.
    it('adds no separators of its own between sections', () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildProviderTooltip)([new markdown_string_1.MarkdownStringImpl('<span>first</span><hr>'), new markdown_string_1.MarkdownStringImpl('<span>second</span>')], htmlRenderer, openerService, toDispose);
        (0, chai_1.expect)(tooltip.querySelectorAll('hr').length, 'rules').to.equal(1);
    });
    it('renders a plain string tooltip', () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildProviderTooltip)('just text', htmlRenderer, openerService, toDispose);
        (0, chai_1.expect)(tooltip, 'tooltip').to.not.be.undefined;
        (0, chai_1.expect)(tooltip.textContent).to.equal('just text');
    });
    it('returns undefined when the provider supplies no usable content', () => {
        (0, chai_1.expect)((0, scm_history_graph_tooltip_1.buildProviderTooltip)('   ', htmlRenderer, openerService, toDispose)).to.be.undefined;
        (0, chai_1.expect)((0, scm_history_graph_tooltip_1.buildProviderTooltip)([], htmlRenderer, openerService, toDispose)).to.be.undefined;
    });
    it('routes an author mailto link through the opener service', async () => {
        const tooltip = (0, scm_history_graph_tooltip_1.buildProviderTooltip)(new markdown_string_1.MarkdownStringImpl('<a href="mailto:jane@example.com">Jane Doe</a>'), htmlRenderer, openerService, toDispose);
        await click(tooltip, 'a[href^="mailto:"]');
        (0, chai_1.expect)(opened).to.deep.equal(['mailto:jane@example.com']);
    });
    it('executes a command link that the section trusts', async () => {
        const section = new markdown_string_1.MarkdownStringImpl('<a href="command:git.viewCommit">Open Commit</a>');
        section.isTrusted = { enabledCommands: ['git.viewCommit'] };
        const tooltip = (0, scm_history_graph_tooltip_1.buildProviderTooltip)(section, htmlRenderer, openerService, toDispose);
        await click(tooltip, 'a[href^="command:"]');
        (0, chai_1.expect)(opened).to.deep.equal(['command:git.viewCommit']);
    });
    it('blocks a command link that the section does not trust', async () => {
        const section = new markdown_string_1.MarkdownStringImpl('<a href="command:git.viewCommit">Open Commit</a>');
        section.isTrusted = { enabledCommands: ['git.copyContentToClipboard'] };
        const tooltip = (0, scm_history_graph_tooltip_1.buildProviderTooltip)(section, htmlRenderer, openerService, toDispose);
        await click(tooltip, 'a[href^="command:"]');
        (0, chai_1.expect)(opened).to.be.empty;
    });
    it('does not open a link twice when the renderer already wired it', async () => {
        // The Monaco-based renderer used at runtime routes link activation through the opener
        // service itself, so wiring a second handler on top would open every link twice.
        const wiringRenderer = {
            render: (markdown) => {
                const element = document.createElement('div');
                element.innerHTML = markdown.value;
                (0, markdown_link_handler_1.markMarkdownLinksWired)(element);
                element.addEventListener('click', event => {
                    event.preventDefault();
                    opened.push(event.target.getAttribute('href'));
                });
                return { element, dispose: () => { } };
            }
        };
        const section = new markdown_string_1.MarkdownStringImpl('<a href="command:git.viewCommit">Open Commit</a>');
        section.isTrusted = { enabledCommands: ['git.viewCommit'] };
        const tooltip = (0, scm_history_graph_tooltip_1.buildProviderTooltip)(section, wiringRenderer, openerService, toDispose);
        await click(tooltip, 'a[href^="command:"]');
        (0, chai_1.expect)(opened).to.deep.equal(['command:git.viewCommit']);
    });
    it('does not let one section authorize another section\'s commands', async () => {
        const untrusted = new markdown_string_1.MarkdownStringImpl('<a id="untrusted" href="command:git.viewCommit">Open Commit</a>');
        const trusted = new markdown_string_1.MarkdownStringImpl('<a id="trusted" href="command:git.copyContentToClipboard">Copy</a>');
        trusted.isTrusted = { enabledCommands: ['git.copyContentToClipboard'] };
        const tooltip = (0, scm_history_graph_tooltip_1.buildProviderTooltip)([untrusted, trusted], htmlRenderer, openerService, toDispose);
        await click(tooltip, 'a#untrusted');
        (0, chai_1.expect)(opened, 'untrusted section').to.be.empty;
        await click(tooltip, 'a#trusted');
        (0, chai_1.expect)(opened, 'trusted section').to.deep.equal(['command:git.copyContentToClipboard']);
    });
});
//# sourceMappingURL=scm-history-graph-tooltip.spec.js.map