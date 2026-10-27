"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.MARKDOWN_LINKS_WIRED_ATTRIBUTE = void 0;
exports.markMarkdownLinksWired = markMarkdownLinksWired;
exports.wireMarkdownLinkHandler = wireMarkdownLinkHandler;
const common_1 = require("../../common");
const markdown_string_1 = require("../../common/markdown-rendering/markdown-string");
const uri_1 = require("../../common/uri");
const opener_service_1 = require("../opener-service");
/**
 * Marks an element whose markdown links are already routed through an {@link OpenerService}.
 *
 * Renderers that install their own link handling declare it with {@link markMarkdownLinksWired},
 * so that {@link wireMarkdownLinkHandler} does not add a second handler and open every link twice.
 */
exports.MARKDOWN_LINKS_WIRED_ATTRIBUTE = 'data-theia-markdown-links-wired';
/** Declares that the element's markdown links are already routed through an {@link OpenerService}. */
function markMarkdownLinksWired(root) {
    root.setAttribute(exports.MARKDOWN_LINKS_WIRED_ATTRIBUTE, 'true');
}
/**
 * Wires up anchor clicks inside a rendered markdown element so that they are routed
 * through the {@link OpenerService} instead of relying on default browser navigation.
 * Honors {@link MarkdownString.isTrusted} for `command:` URIs.
 *
 * Also sets the `title` attribute on each anchor to its `href` (when no title is set)
 * so users can hover to see the link target.
 *
 * Does nothing if the element's links are already wired, see {@link markMarkdownLinksWired}.
 *
 * @returns a {@link Disposable} that removes the click listener.
 */
function wireMarkdownLinkHandler(root, source, openerService) {
    if (root.hasAttribute(exports.MARKDOWN_LINKS_WIRED_ATTRIBUTE)) {
        return common_1.Disposable.NULL;
    }
    markMarkdownLinksWired(root);
    for (const anchor of root.querySelectorAll('a')) {
        const href = anchor.getAttribute('href');
        if (href && !anchor.hasAttribute('title')) {
            anchor.setAttribute('title', href);
        }
    }
    const handleClick = async (event) => {
        const href = event.target?.closest('a')?.getAttribute('href');
        if (!href) {
            return;
        }
        event.preventDefault();
        const uri = new uri_1.default(href);
        if (uri.scheme === 'command' && !markdown_string_1.MarkdownString.isCommandAllowed(source.isTrusted, uri.path.toString())) {
            return;
        }
        try {
            await (0, opener_service_1.open)(openerService, uri);
        }
        catch (e) {
            console.error(`Failed to open '${uri.toString()}':`, e);
        }
    };
    root.addEventListener('click', handleClick);
    return common_1.Disposable.create(() => {
        root.removeEventListener('click', handleClick);
        root.removeAttribute(exports.MARKDOWN_LINKS_WIRED_ATTRIBUTE);
    });
}
//# sourceMappingURL=markdown-link-handler.js.map